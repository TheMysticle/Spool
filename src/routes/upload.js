const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const db = require('../database');
const { getVideoMeta, generateThumbnail, filenameToTitle, detectCategory } = require('../scanner');
const transcodeQueue = require('../transcode_queue');

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const MEDIA_PATH = process.env.MEDIA_PATH || '/media';
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const CHANNELS_DIR = path.join(MEDIA_PATH, 'channels');
const THUMB_DIR = path.join(DATA_DIR, 'thumbnails');

fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(CHANNELS_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

const TMP_DIR = path.join(DATA_DIR, 'tmp_uploads');
fs.mkdirSync(TMP_DIR, { recursive: true });

// Check upload permissions middleware
const requireUploadPrivileges = (req, res, next) => {
  if (req.user.role === 'admin' || req.user.can_upload === 1) {
    // If not admin, they MUST have a channel created to upload
    if (req.user.role !== 'admin') {
      const channel = db.getChannelByUserId(req.user.id);
      if (!channel) {
        return res.status(403).json({ error: 'You must create a channel before uploading.' });
      }
      
      // Enforce 50 videos per channel limit
      const channelVideos = db.getAllVideos({ channelId: channel.id, isAdmin: true });
      if (channelVideos.length >= 50) {
        return res.status(403).json({ error: 'Channel storage quota reached (max 50 videos).' });
      }

      req.uploadChannel = channel;
    }
    return next();
  }
  return res.status(403).json({ error: 'You do not have upload privileges.' });
};

// Configure Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let destDir;
    if (req.uploadChannel) {
      destDir = path.join(CHANNELS_DIR, String(req.uploadChannel.id));
    } else {
      destDir = MEDIA_PATH;
    }
    fs.mkdirSync(destDir, { recursive: true });
    req.uploadDestDir = destDir;
    cb(null, destDir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename to prevent path traversal but keep spaces and common safe characters
    let safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_\s()\[\],]/g, '_');
    if (!safeName) safeName = 'video.mp4';
    
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    
    let finalName = safeName;
    let attempt = 1;
    // Append a counter only if a file with the exact name already exists
    while (fs.existsSync(path.join(req.uploadDestDir, finalName))) {
      finalName = `${base}-${attempt}${ext}`;
      attempt++;
    }
    
    cb(null, finalName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB limit
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.mp4', '.webm', '.mkv', '.mov', '.avi'];
    
    if (file.mimetype.startsWith('video/') || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Only video files are allowed.`));
    }
  }
});

// POST /api/upload
router.post('/', authenticate, requireUploadPrivileges, (req, res) => {
  console.log('[Upload] POST /api/upload received from user:', req.user?.username, 'role:', req.user?.role);
  upload.array('videos', 10)(req, res, async (err) => {
    if (err) {
      console.error('[Upload] Multer error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.files || req.files.length === 0) {
      console.warn('[Upload] No files in request');
      return res.status(400).json({ error: 'No files uploaded.' });
    }
    console.log(`[Upload] Received ${req.files.length} file(s):`, req.files.map(f => f.originalname).join(', '));

    const datePref = req.body.datePref || 'modified';
    const customDate = req.body.customDate || null;
    let lastModifiedMap = {};
    try {
      if (req.body.lastModifiedData) {
        const arr = JSON.parse(req.body.lastModifiedData);
        arr.forEach(item => {
          lastModifiedMap[item.name] = item.lastModified;
        });
      }
    } catch (e) {}

    const uploadedVideos = [];

    for (const file of req.files) {
      try {
        console.log(`[Upload] Processing file: ${file.originalname} at ${file.path}`);
        const meta = await getVideoMeta(file.path);
        console.log(`[Upload] ffprobe meta:`, JSON.stringify(meta));
        
        // M7: Validate actual content type
        if (meta.duration === 0 && meta.width === 0 && meta.height === 0) {
          console.error(`[Upload] Invalid video file: ${file.originalname}`);
          try { fs.unlinkSync(file.path); } catch (e) {}
          continue; // Skip this file
        }

        const category = detectCategory(file.path);
        const title = filenameToTitle(file.originalname);
        const stat = fs.statSync(file.path);
        
        let fileCreatedAt = stat.mtime.toISOString();
        let forceContentDate = null;

        if (datePref === 'custom' && customDate) {
          forceContentDate = new Date(`${customDate}T12:00:00Z`).toISOString();
          fileCreatedAt = forceContentDate;
        } else if (datePref === 'filename') {
          fileCreatedAt = stat.mtime.toISOString(); 
        } else {
          // datePref === 'modified'
          const origModifiedMs = lastModifiedMap[file.originalname];
          if (origModifiedMs) {
            forceContentDate = new Date(origModifiedMs).toISOString();
            fileCreatedAt = forceContentDate;
          }
        }

        const relativePath = path.relative(DATA_DIR, file.path).replace(/\\/g, '/');

        // Database insertion
        const videoData = {
          filename: file.filename,
          filepath: file.path,
          title: title,
          category: category,
          file_created_at: fileCreatedAt,
          force_content_date: forceContentDate,
          duration: meta.duration,
          file_size: stat.size,
          video_width: meta.width,
          video_height: meta.height,
          thumbnail_path: null,
          channel_id: req.uploadChannel ? req.uploadChannel.id : null,
          is_vhs: req.body.is_vhs === 'true' || req.body.is_vhs === true ? 1 : 0
        };

        console.log(`[Upload] Inserting into DB: title="${title}" filepath="${file.path}"`);
        db.upsertVideo(videoData);
        const inserted = db.getVideoByPath(file.path);
        const videoId = inserted ? inserted.id : 0;
        console.log(`[Upload] DB insert complete, videoId=${videoId}`);

        if (videoId && videoData.channel_id) {
          db.addChannelNotification(videoData.channel_id, videoId);
        } else if (videoId && req.user.role === 'admin') {
          db.addChannelNotification(0, videoId); // 0 is admin channel ID for notifications
        }

        const ext = path.extname(file.path).toLowerCase();
        if (['.avi', '.mov', '.flv', '.ts'].includes(ext)) {
          if (videoId) {
            transcodeQueue.addJob(videoId, file.path);
          }
        }

        uploadedVideos.push({ id: videoId, title });

        // Async Thumbnail Generation
        setTimeout(async () => {
          try {
            const thumbName = `thumb_${videoId}.jpg`;
            const thumbPath = path.join(THUMB_DIR, thumbName);
            await generateThumbnail(file.path, thumbPath, meta.duration);
            
            if (fs.existsSync(thumbPath)) {
              db.setVideoThumbnail(videoId, `/thumbnails/${thumbName}`);
            }
          } catch (err) {
            console.error(`[Upload] Failed to generate thumbnail for ${videoId}:`, err.message);
          }
        }, 0);

      } catch (err) {
        console.error(`[Upload] Error processing uploaded file ${file.filename}:`, err);
      }
    }

    console.log(`[Upload] Complete. ${uploadedVideos.length} videos processed.`);
    res.json({ message: 'Upload successful', videos: uploadedVideos });
  });
});

const chunkStorage = multer.diskStorage({
  destination: TMP_DIR,
  filename: (req, file, cb) => cb(null, 'chunk_' + Date.now() + '_' + Math.floor(Math.random() * 1000))
});
const chunkUpload = multer({ storage: chunkStorage });

router.post('/chunk', authenticate, requireUploadPrivileges, chunkUpload.single('chunk'), (req, res) => {
  const { uploadId, chunkIndex } = req.body;
  if (!req.file || !uploadId) return res.status(400).json({ error: 'Missing chunk data' });
  const partPath = path.join(TMP_DIR, uploadId + '.part');
  try {
    const chunkData = fs.readFileSync(req.file.path);
    fs.appendFileSync(partPath, chunkData);
    fs.unlinkSync(req.file.path);
    res.json({ success: true, chunkIndex });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write chunk' });
  }
});

router.post('/complete', authenticate, requireUploadPrivileges, upload.none(), async (req, res) => {
  const { uploadId, originalName, datePref, customDate, isVhs, lastModifiedData } = req.body;
  const partPath = path.join(TMP_DIR, uploadId + '.part');
  if (!fs.existsSync(partPath)) return res.status(400).json({ error: 'Incomplete upload' });
  
  let destDir = req.uploadChannel ? path.join(CHANNELS_DIR, String(req.uploadChannel.id)) : MEDIA_PATH;
  fs.mkdirSync(destDir, { recursive: true });
  
  let safeName = originalName.replace(/[^a-zA-Z0-9.\-_\s()\[\],]/g, '_');
  if (!safeName) safeName = 'video.mp4';
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  let finalName = safeName;
  let attempt = 1;
  while (fs.existsSync(path.join(destDir, finalName))) {
    finalName = `${base}-${attempt}${ext}`;
    attempt++;
  }
  const finalPath = path.join(destDir, finalName);
  fs.renameSync(partPath, finalPath);

  try {
    const meta = await getVideoMeta(finalPath);
    if (meta.duration === 0 && meta.width === 0 && meta.height === 0) {
      try { fs.unlinkSync(finalPath); } catch (e) {}
      return res.status(400).json({ error: 'Invalid video file' });
    }
    const category = detectCategory(finalPath);
    const title = filenameToTitle(originalName);
    const stat = fs.statSync(finalPath);
    let fileCreatedAt = stat.mtime.toISOString();
    let forceContentDate = null;

    if (datePref === 'custom' && customDate) {
      forceContentDate = new Date(`${customDate}T12:00:00Z`).toISOString();
      fileCreatedAt = forceContentDate;
    } else if (datePref === 'filename') {
      fileCreatedAt = stat.mtime.toISOString();
    } else {
      try {
        if (lastModifiedData) {
          const map = JSON.parse(lastModifiedData);
          const origModifiedMs = map[originalName];
          if (origModifiedMs) {
            forceContentDate = new Date(origModifiedMs).toISOString();
            fileCreatedAt = forceContentDate;
          }
        }
      } catch (e) {}
    }

    const videoData = {
      filename: finalName,
      filepath: finalPath,
      title: title,
      category: category,
      file_created_at: fileCreatedAt,
      force_content_date: forceContentDate,
      duration: meta.duration,
      file_size: stat.size,
      video_width: meta.width,
      video_height: meta.height,
      thumbnail_path: null,
      channel_id: req.uploadChannel ? req.uploadChannel.id : null,
      is_vhs: isVhs === 'true' || isVhs === true ? 1 : 0
    };

    db.upsertVideo(videoData);
    const inserted = db.getVideoByPath(finalPath);
    const videoId = inserted ? inserted.id : 0;

    if (videoId && videoData.channel_id) {
      db.addChannelNotification(videoData.channel_id, videoId);
    } else if (videoId && req.user.role === 'admin') {
      db.addChannelNotification(0, videoId);
    }

    if (['.avi', '.mov', '.flv', '.ts'].includes(ext.toLowerCase())) {
      if (videoId) transcodeQueue.addJob(videoId, finalPath);
    }

    setTimeout(async () => {
      try {
        const thumbName = `thumb_${videoId}.jpg`;
        const thumbPath = path.join(THUMB_DIR, thumbName);
        await generateThumbnail(finalPath, thumbPath, meta.duration);
        if (fs.existsSync(thumbPath)) {
          db.setVideoThumbnail(videoId, `/thumbnails/${thumbName}`);
        }
      } catch (err) {}
    }, 0);

    res.json({ message: 'Upload successful', videos: [{ id: videoId, title }] });
  } catch (err) {
    res.status(500).json({ error: 'Server error processing video' });
  }
});

module.exports = router;
