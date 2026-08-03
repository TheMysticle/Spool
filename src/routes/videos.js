'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const {
  getAllVideos,
  getVideoById,
  updateVideoMeta,
  setVideoThumbnail,
  incrementViewCount,
  getCommentsByVideoId,
  addComment,
  getCommentById,
  updateComment,
  deleteComment,
  hasCommentLike,
  addCommentLike,
  removeCommentLike,
  hasCommentHeart,
  addCommentHeart,
  removeCommentHeart,
  upsertProgress,
  getProgress,
  canUserAccessVideo,
  getVideoPeople,
  getChannelProfile,
  createVideoShare,
  getVideoShareToken,
  deleteVideoShare,
  getChannelById,
  setVideoAccess,
  getVideoAccess,
  setVideoPeople,
  getSetting,
  getAllUsers,
} = require('../database');
const { authenticate, requireAdmin, authOrShareToken } = require('../middleware/auth');
const os = require('os');

const router = express.Router();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const THUMB_DIR = path.join(DATA_DIR, 'thumbnails');
const TRANSCODE_DIR = path.join(DATA_DIR, 'transcoded');
const HLS_DIR = path.join(DATA_DIR, 'hls');
const HLS_CLEANUP_MS = Number(process.env.HLS_CLEANUP_MS || 30 * 60 * 1000); // 30 min
const HLS_ACTIVE_IDLE_MS = Number(process.env.HLS_ACTIVE_IDLE_MS || 10 * 1000);
const TRANSCODE_CLEANUP_MS = Number(process.env.TRANSCODE_CLEANUP_MS || 20 * 1000);

function getFfmpegThreadArgs() {
  const totalCpus = os.cpus() ? os.cpus().length : 4;
  const defaultThreads = Math.max(1, Math.floor(totalCpus / 2));
  let threads = defaultThreads;
  try {
    const setting = parseInt(getSetting('auto_transcode_threads', String(defaultThreads)), 10);
    if (!isNaN(setting) && setting > 0) threads = setting;
  } catch (e) {}
  const lookahead = threads <= 1 ? 0 : 1;
  return ['-threads', String(threads), '-x264-params', `threads=${threads}:lookahead_threads=${lookahead}:sliced-threads=1`];
}

function lowerProcessPriority(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try {
      execFile('wmic', ['process', 'where', `processid=${proc.pid}`, 'CALL', 'setpriority', 'below normal'], () => {});
    } catch (e) {}
  } else {
    try {
      execFile('renice', ['10', '-p', String(proc.pid)], () => {});
    } catch (e) {}
  }
}

// ── HLS job tracking ──────────────────────────────────────────────────────────
// Map<jobKey, { dir, proc, ready: Promise<void>, lastAccess: number }>
const hlsJobs = new Map();
const activeTranscodes = new Map();
const activeTranscodeStreams = new Map();
const transcodeCleanupTimers = new Map();

function hlsJobKey(videoId, quality) { return `${videoId}:${quality}`; }

function injectTokenIntoPlaylist(playlistText, token) {
  if (!token) return playlistText;

  return playlistText
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      if (/^[a-z]+:\/\//i.test(trimmed)) return line;
      const separator = trimmed.includes('?') ? '&' : '?';
      return `${trimmed}${separator}token=${encodeURIComponent(token)}`;
    })
    .join('\n');
}

// Derive available quality levels from source height
function getAvailableQualities(sourceHeight) {
  const ladder = [
    { label: '480p',  height: 480,  minSrc: 0   },
    { label: '720p',  height: 720,  minSrc: 600  },
    { label: '1080p', height: 1080, minSrc: 900  },
    { label: '4k',    height: 2160, minSrc: 2160 },
  ];
  // If height is 0 (not yet scanned), return all; otherwise filter
  if (!sourceHeight) return ladder;
  return ladder.filter((q) => sourceHeight >= q.minSrc);
}

// Spawn ffmpeg for HLS into outDir. Returns { proc, ready }
// ready resolves when 2 segments have been written (fast enough to start playing).
function startHlsTranscode(sourcePath, outDir, heightCap) {
  console.log(`[HLS] Starting transcode: ${sourcePath} → ${outDir} @ ${heightCap}p`);
  fs.mkdirSync(outDir, { recursive: true });

  const scaleFilter = heightCap ? `scale=-2:${heightCap}` : 'scale=-2:1080';
  const playlistPath = path.join(outDir, 'index.m3u8');
  const threadArgs = getFfmpegThreadArgs();

  const args = [
    '-hide_banner', '-loglevel', 'info',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    ...threadArgs,
    '-vf', scaleFilter,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-hls_time', '6',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(outDir, 'seg%05d.ts'),
    '-hls_flags', 'independent_segments+append_list',
    '-progress', 'pipe:1',
    playlistPath,
  ];

  const proc = spawn('ffmpeg', args);
  lowerProcessPriority(proc);
  let ffmpegOutput = '';
  proc.stdout.on('data', (data) => {
    ffmpegOutput += data.toString();
  });
  proc.stderr.on('data', (data) => {
    console.log('[ffmpeg]', data.toString().trim());
  });
  proc.on('error', (err) => console.error('[HLS spawn error]', err.message));
  proc.on('close', (code) => {
    console.log(`[HLS] ffmpeg process closed with code ${code} for ${outDir}`);
  });

  // Resolve once the playlist exists and has at least 2 complete segments listed
  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      console.error(`[HLS] Timeout waiting for segments at ${outDir}`);
      reject(new Error('HLS transcode timed out'));
    }, 120_000);
    const interval = setInterval(() => {
      if (!fs.existsSync(playlistPath)) return;
      try {
        const content = fs.readFileSync(playlistPath, 'utf8');
        const segmentCount = (content.match(/#EXTINF/g) || []).length;
        if (segmentCount > 0) {
          console.log(`[HLS] Playlist ready with ${segmentCount} segment(s) at ${outDir}`);
          clearInterval(interval);
          clearTimeout(deadline);
          resolve();
        }
      } catch (err) {
        console.error(`[HLS] Error reading playlist: ${err.message}`);
      }
    }, 300);

    proc.on('close', (code) => {
      clearInterval(interval);
      clearTimeout(deadline);
      if (code === 0 || fs.existsSync(playlistPath)) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });

  return { proc, ready, playlistPath };
}

// Get or create an HLS job for a video+quality
function getOrCreateHlsJob(videoId, sourcePath, quality) {
  const key = hlsJobKey(videoId, quality);
  const existing = hlsJobs.get(key);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing;
  }

  const heights = { '480p': 480, '720p': 720, '1080p': 1080, '4k': 2160 };
  const heightCap = heights[quality] || 1080;
  const outDir = path.join(HLS_DIR, String(videoId), quality);

  // If a previous run left a completed playlist, reuse it
  const existingPlaylist = path.join(outDir, 'index.m3u8');
  if (fs.existsSync(existingPlaylist)) {
    const content = fs.readFileSync(existingPlaylist, 'utf8');
    if (content.includes('#EXT-X-ENDLIST')) {
      const job = { dir: outDir, proc: null, ready: Promise.resolve(), lastAccess: Date.now() };
      hlsJobs.set(key, job);
      return job;
    }
    // Incomplete leftover — delete and re-transcode
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  }

  const { proc, ready } = startHlsTranscode(sourcePath, outDir, heightCap);
  const job = { dir: outDir, proc, ready, lastAccess: Date.now() };
  hlsJobs.set(key, job);

  // Mark process as no longer active when encoding ends so long-term cleanup
  // can handle it as a cached job instead of an active worker.
  proc.on('close', () => {
    const current = hlsJobs.get(key);
    if (current) current.proc = null;
  });

  return job;
}

// Periodic cleanup of stale HLS job dirs
setInterval(() => {
  const now = Date.now();
  for (const [key, job] of hlsJobs.entries()) {
    const age = now - job.lastAccess;

    // If an ffmpeg job is still actively transcoding but no client has touched
    // the playlist/segments recently, kill it quickly so it does not keep
    // burning CPU after the viewer closes the page.
    if (job.proc && age > HLS_ACTIVE_IDLE_MS) {
      try {
        job.proc.kill('SIGTERM');
      } catch {}
      try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
      hlsJobs.delete(key);
      console.log(`[HLS] Killed idle transcode job ${key} after ${age}ms`);
      continue;
    }

    // Completed / cached job cleanup remains much longer.
    if (!job.proc && age > HLS_CLEANUP_MS) {
      try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
      hlsJobs.delete(key);
      console.log(`[HLS] Removed stale cached job ${key} after ${age}ms`);
    }
  }
}, 5_000);

const MIME_TYPES = {
  '.mp4':  'video/mp4',
  '.mkv':  'video/x-matroska',
  '.webm': 'video/webm',
  '.avi':  'video/x-msvideo',
  '.mov':  'video/quicktime',
  '.m4v':  'video/mp4',
  '.ts':   'video/mp2t',
  '.flv':  'video/x-flv',
};

function generateThumbFilename(filePath) {
  return `${Buffer.from(filePath).toString('base64url').slice(0, 80)}.jpg`;
}

function generateThumbnail(filePath, thumbPath) {
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      ['-ss', '5', '-i', filePath, '-vframes', '1', '-vf', 'scale=640:-1', '-q:v', '3', '-y', thumbPath],
      { timeout: 60000 },
      (err) => {
        if (!err) return resolve(true);
        execFile(
          'ffmpeg',
          ['-i', filePath, '-vframes', '1', '-vf', 'scale=640:-1', '-q:v', '3', '-y', thumbPath],
          { timeout: 60000 },
          (err2) => resolve(!err2)
        );
      }
    );
  });
}

function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function getQualityHeight(quality, sourceHeight) {
  const heights = { '480p': 480, '720p': 720, '1080p': 1080, '4k': 2160 };
  const requestedHeight = heights[quality] || 1080;
  if (!sourceHeight) return requestedHeight;
  return Math.min(requestedHeight, sourceHeight);
}

async function transcodeFileToMp4(sourcePath, outputPath, quality, sourceHeight) {
  const targetHeight = getQualityHeight(quality, sourceHeight);
  const shouldScale = sourceHeight && targetHeight < sourceHeight;

  if (!shouldScale) {
    try {
      await ffmpegRun([
        '-hide_banner',
        '-loglevel', 'error',
        '-i', sourcePath,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-y',
        outputPath,
      ]);
      return;
    } catch {
      // Fall back to full re-encode below.
    }
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    ...getFfmpegThreadArgs(),
  ];

  if (shouldScale) {
    args.push('-vf', `scale=-2:${targetHeight}`);
  }

  args.push(
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-y',
    outputPath
  );

  await ffmpegRun(args);
}

async function ensureTranscodedMp4(sourcePath, quality, sourceHeight) {
  fs.mkdirSync(TRANSCODE_DIR, { recursive: true });

  const sourceStat = fs.statSync(sourcePath);
  const safeKey = Buffer.from(`${sourcePath}|${sourceStat.size}|${sourceStat.mtimeMs}|${quality}`)
    .toString('base64url')
    .slice(0, 120);
  const outputPath = path.join(TRANSCODE_DIR, `${safeKey}.mp4`);

  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  if (!activeTranscodes.has(outputPath)) {
    const job = transcodeFileToMp4(sourcePath, outputPath, quality, sourceHeight)
      .catch((err) => {
        try {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch {}
        throw err;
      })
      .finally(() => {
        activeTranscodes.delete(outputPath);
      });
    activeTranscodes.set(outputPath, job);
  }

  await activeTranscodes.get(outputPath);

  if (!fs.existsSync(outputPath)) {
    throw new Error('Transcoded MP4 was not created.');
  }

  return outputPath;
}

function beginTranscodeUsage(filePath) {
  const existingTimer = transcodeCleanupTimers.get(filePath);
  if (existingTimer) {
    clearTimeout(existingTimer);
    transcodeCleanupTimers.delete(filePath);
  }
  activeTranscodeStreams.set(filePath, (activeTranscodeStreams.get(filePath) || 0) + 1);
}

function endTranscodeUsage(filePath) {
  const count = Math.max(0, (activeTranscodeStreams.get(filePath) || 0) - 1);
  if (count === 0) {
    activeTranscodeStreams.delete(filePath);
    const timer = setTimeout(() => {
      try {
        if (!activeTranscodeStreams.has(filePath) && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        console.error('[Transcode Cleanup]', err.message);
      } finally {
        transcodeCleanupTimers.delete(filePath);
      }
    }, TRANSCODE_CLEANUP_MS);
    transcodeCleanupTimers.set(filePath, timer);
  } else {
    activeTranscodeStreams.set(filePath, count);
  }
}

function streamFileWithRange(filePath, req, res, contentType) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const match = range.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).json({ error: 'Invalid range.' });
    }

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).json({ error: 'Range not satisfiable.' });
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });

    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Length': fileSize,
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
  });
  return fs.createReadStream(filePath).pipe(res);
}

function streamTranscodedWithCleanup(filePath, req, res) {
  beginTranscodeUsage(filePath);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    endTranscodeUsage(filePath);
  };
  res.once('finish', finish);
  res.once('close', finish);

  return streamFileWithRange(filePath, req, res, 'video/mp4');
}

// ── GET /api/videos — list videos ─────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const { category, search, page = 1, limit = 40, sort = 'title_asc', person_id, channelId, include_vhs } = req.query;

  // Validate pagination params
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 40));

  // Sanitize category
  const safeCategory = ['video', 'livestream', 'all'].includes(category) ? category : 'all';

  // Sanitize search (strip SQL control characters beyond parameterized placeholders)
  const safeSearch = typeof search === 'string' ? search.slice(0, 100) : undefined;

  const parsedPersonId = parseInt(person_id, 10);
  const safePersonId = Number.isNaN(parsedPersonId) ? null : parsedPersonId;

  const safeSort = ['title_asc', 'title_desc', 'name_asc', 'name_desc', 'people_asc', 'people_desc', 'oldest', 'newest'].includes(sort)
    ? sort
    : 'title_asc';

  const result = getAllVideos({
    category: safeCategory,
    search: safeSearch,
    page: parsedPage,
    limit: parsedLimit,
    sort: safeSort,
    userId: req.user.id,
    isAdmin: req.user.role === 'admin',
    personId: safePersonId,
    channelId: channelId || null,
    includeVhs: include_vhs === 'true'
  });

  result.channel = getChannelProfile();
  res.json(result);
});

// ── GET /api/videos/:id — single video metadata ───────────────────────────────
router.get('/:id', authOrShareToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });

  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  if (!req.sharedVideo && req.user?.role !== 'admin' && !canUserAccessVideo(id, req.user?.id)) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  if (video.channel_id) {
    const { getChannelById } = require('../database');
    video.channel = getChannelById(video.channel_id);
  } else {
    video.channel = getChannelProfile();
  }
  
  res.json(video);
});

// ── GET /api/videos/:id/people — people tagged in a video ─────────────────────
router.get('/:id/people', authOrShareToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });
  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  if (!req.sharedVideo && req.user?.role !== 'admin' && !canUserAccessVideo(id, req.user?.id)) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  res.json(getVideoPeople(id));
});

// ── PUT /api/videos/:id — update metadata (admin/owner) ───────────────────────
router.put('/:id', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });

  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  let canEdit = req.user.role === 'admin';
  if (!canEdit && video.channel_id) {
    const channel = getChannelById(video.channel_id);
    if (channel && channel.user_id === req.user.id) canEdit = true;
  }
  if (!canEdit) return res.status(403).json({ error: 'Forbidden' });

  const { title, description, category, is_vhs, content_date } = req.body;

  if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0)) {
    return res.status(400).json({ error: 'Title must be a non-empty string.' });
  }
  if (description !== undefined && typeof description !== 'string') {
    return res.status(400).json({ error: 'Description must be a string.' });
  }
  if (category !== undefined && !['video', 'livestream'].includes(category)) {
    return res.status(400).json({ error: 'Category must be video or livestream.' });
  }
  if (is_vhs !== undefined && typeof is_vhs !== 'number') {
    return res.status(400).json({ error: 'is_vhs must be a number (0 or 1).' });
  }

  updateVideoMeta(id, {
    title: title !== undefined ? title.trim().slice(0, 255) : undefined,
    description: description !== undefined ? description.slice(0, 5000) : undefined,
    category,
    is_vhs: is_vhs !== undefined ? is_vhs : undefined,
    vhs_start_date: vhs_start_date !== undefined ? vhs_start_date : undefined,
    vhs_end_date: vhs_end_date !== undefined ? vhs_end_date : undefined,
    content_date: content_date !== undefined ? content_date : undefined,
  });

  if (is_vhs === 1) {
    const access = getVideoAccess(id);
    if (access.all_users) {
      setVideoAccess(id, { all_users: false, user_ids: access.user_ids });
    }
  }

  res.json({ message: 'Video updated.', video: getVideoById(id) });
});

// ── GET /api/videos/:id/access ────────────────────────────────────────────────
router.get('/:id/access', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });
  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  let canEdit = req.user.role === 'admin';
  if (!canEdit && video.channel_id) {
    const channel = getChannelById(video.channel_id);
    if (channel && channel.user_id === req.user.id) canEdit = true;
  }
  if (!canEdit) return res.status(403).json({ error: 'Forbidden' });

  res.json(getVideoAccess(id));
});

// ── PUT /api/videos/:id/access ────────────────────────────────────────────────
router.put('/:id/access', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });
  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  let canEdit = req.user.role === 'admin';
  if (!canEdit && video.channel_id) {
    const channel = getChannelById(video.channel_id);
    if (channel && channel.user_id === req.user.id) canEdit = true;
  }
  if (!canEdit) return res.status(403).json({ error: 'Forbidden' });

  const { all_users, user_ids = [] } = req.body;
  let finalAllUsers = Boolean(all_users);
  
  if (finalAllUsers && video.is_vhs) {
    finalAllUsers = false; // VHS videos cannot have public access
  }

  setVideoAccess(id, {
    all_users: finalAllUsers,
    user_ids: Array.isArray(user_ids) ? user_ids.map(Number).filter((n) => !isNaN(n)) : [],
  });

  res.json({ message: 'Access updated.', access: getVideoAccess(id) });
});

// ── GET /api/videos/:id/viewers ───────────────────────────────────────────────
// Returns non-admin users for the access-control UI. Available to admins and
// channel owners so they can manage viewer permissions without full admin access.
router.get('/:id/viewers', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });
  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  let canEdit = req.user.role === 'admin';
  if (!canEdit && video.channel_id) {
    const channel = getChannelById(video.channel_id);
    if (channel && channel.user_id === req.user.id) canEdit = true;
  }
  if (!canEdit) return res.status(403).json({ error: 'Forbidden' });

  // Return only non-sensitive fields for non-admin users
  const users = getAllUsers().map(u => ({
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
  }));
  res.json(users);
});

// ── PUT /api/videos/:id/people ────────────────────────────────────────────────
router.put('/:id/people', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });
  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  let canEdit = req.user.role === 'admin';
  if (!canEdit && video.channel_id) {
    const channel = getChannelById(video.channel_id);
    if (channel && channel.user_id === req.user.id) canEdit = true;
  }
  if (!canEdit) return res.status(403).json({ error: 'Forbidden' });

  const { person_ids = [] } = req.body;
  setVideoPeople(id, Array.isArray(person_ids) ? person_ids.map(Number).filter((n) => !isNaN(n)) : []);
  res.json({ message: 'People tags updated.', people: getVideoPeople(id) });
});

// ── Streaming transcode: real-time MP4 encoding ──────────────────────────────
// Directly pipes ffmpeg output to client without caching, allowing progressively
// playable MP4 if client supports it. Shows loading bar while transcoding.
function streamTranscodeToMp4(sourcePath, quality, sourceHeight, res) {
  const heights = { '480p': 480, '720p': 720, '1080p': 1080, '4k': 2160 };
  const targetHeight = heights[quality] || 1080;
  const shouldScale = sourceHeight && targetHeight < sourceHeight;

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    ...getFfmpegThreadArgs(),
  ];

  if (shouldScale) {
    args.push('-vf', `scale=-2:${targetHeight}`);
  }

  args.push(
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-f', 'mp4',
    'pipe:1'  // Output to stdout
  );

  const proc = spawn('ffmpeg', args);
  lowerProcessPriority(proc);
  let aborted = false;

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'none',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });

  proc.stdout.pipe(res);

  const sigtermHandler = () => {
    if (!aborted) {
      aborted = true;
      proc.kill('SIGTERM');
    }
  };
  process.on('SIGTERM', sigtermHandler);

  proc.on('error', (err) => {
    console.error('[Streaming Transcode]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Transcode failed.' });
  });

  res.on('close', () => {
    process.removeListener('SIGTERM', sigtermHandler);
    if (!aborted) {
      aborted = true;
      proc.kill('SIGTERM');
    }
  });
}

// ── GET /api/videos/:id/stream — stream video with range support ───────────────
router.get('/:id/stream', authOrShareToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });

  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  if (!req.sharedVideo && req.user?.role !== 'admin' && !canUserAccessVideo(id, req.user?.id)) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  // Prevent path traversal — filepath is stored from our own scanner
  const filePath = video.filepath;
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Video file not found on disk.' });
  }

  try {
    fs.statSync(filePath);
  } catch {
    return res.status(500).json({ error: 'Could not read video file.' });
  }

  const ext = path.extname(filePath).toLowerCase();
  const transcodeMode = req.query.transcode; // Can be '1' (legacy/cached), 'stream' (new real-time), or undefined
  const requestedQuality = typeof req.query.quality === 'string' ? req.query.quality : '1080p';
  const quality = ['480p', '720p', '1080p', '4k'].includes(requestedQuality) ? requestedQuality : '1080p';

  // Realtime chunked mode is disabled to maximize TV compatibility.
  if (transcodeMode === 'stream') {
    return res.status(410).json({
      error: 'Realtime transcode mode disabled. Use transcode=1 cached mode.',
    });
  }

  const isPreview = !!req.query.preview || req.query.preview === '1' || req.query.preview === 'true';

  // ── Legacy cached transcode (for backward compatibility) ───────────────────
  if (transcodeMode === '1') {

    try {
      const mp4Path = await ensureTranscodedMp4(filePath, quality, video.video_height || 0);
      return streamTranscodedWithCleanup(mp4Path, req, res);
    } catch (err) {
      console.error('[Transcode MP4]', err.message);
      return res.status(500).json({ error: 'Failed to prepare video for playback.' });
    }
  }

  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const range = req.headers.range;

  // View count logic has been moved to POST /api/videos/:id/view

  return streamFileWithRange(filePath, req, res, contentType);
});

// ── POST /api/videos/:id/view ──────────────────────────────────────────────
router.post('/:id/view', authOrShareToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  incrementViewCount(id);
  res.json({ ok: true });
});

// ── GET /api/videos/:id/hls/:quality/index.m3u8 — start/join HLS transcode ───
router.get('/:id/hls/:quality/index.m3u8', authOrShareToken, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    error: 'Legacy HLS endpoint is disabled. Reload the page to use the new MP4 stream path.',
  });
});

// ── GET /api/videos/:id/hls/:quality/:segment — serve HLS segment ─────────────
router.get('/:id/hls/:quality/:segment', authOrShareToken, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    error: 'Legacy HLS endpoint is disabled. Reload the page to use the new MP4 stream path.',
  });
});

// ── GET /api/videos/:id/qualities — list available HLS quality options ────────
router.get('/:id/qualities', authOrShareToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });

  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  const qualities = getAvailableQualities(video.video_height || 0);
  res.json({ qualities, video_height: video.video_height || 0 });
});

// ── GET /api/videos/channel/avatar ─────────────────────────────────────────
router.get('/channel/avatar', authOrShareToken, (req, res) => {
  const absPath = path.join(DATA_DIR, 'avatars', 'channel.jpg');
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.sendFile(absPath);
});

// ── GET /api/videos/:id/download ─────────────────────────────────────────────
router.get('/:id/download', authenticate, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized.' });
  if (req.user.role !== 'admin' && !req.user.can_download) {
    return res.status(403).json({ error: 'You do not have permission to download videos.' });
  }

  const id = parseInt(req.params.id, 10);
  const video = db.getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  const canAccess = checkVideoAccess(req.user, video);
  if (!canAccess) return res.status(403).json({ error: 'Forbidden.' });

  const absPath = path.resolve(video.file_path);
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File not found on disk.' });

  // Use Express' res.download which natively handles Streams and Range requests,
  // bypassing memory buffering issues.
  // We disable cache so Cloudflare doesn't try to buffer/cache massive files.
  res.setHeader('Cache-Control', 'no-store, no-transform');
  
  const ext = path.extname(absPath);
  let safeTitle = video.title || 'video';
  // Strip characters that might break content-disposition
  safeTitle = safeTitle.replace(/[/\\?%*:|"<>]/g, '-');
  
  return res.download(absPath, `${safeTitle}${ext}`);
});

// ── GET /api/videos/:id/thumbnail — serve thumbnail ──────────────────────────
router.get('/:id/thumbnail', authOrShareToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });

  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  if (!req.sharedVideo && req.user?.role !== 'admin' && !canUserAccessVideo(id, req.user?.id)) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  let thumbRelative = video.thumbnail_path;
  let thumbFile = thumbRelative ? path.join(DATA_DIR, thumbRelative) : null;

  // If missing in DB or file missing, try generating on-demand.
  if (!thumbFile || !fs.existsSync(path.resolve(thumbFile))) {
    try {
      fs.mkdirSync(THUMB_DIR, { recursive: true });
      const thumbName = generateThumbFilename(video.filepath);
      const generatedPath = path.join(THUMB_DIR, thumbName);
      const ok = await generateThumbnail(video.filepath, generatedPath);

      if (!ok || !fs.existsSync(generatedPath)) {
        return res.status(404).json({ error: 'Thumbnail not available.' });
      }

      thumbRelative = `/thumbnails/${thumbName}`;
      setVideoThumbnail(video.id, thumbRelative);
      thumbFile = generatedPath;
    } catch {
      return res.status(404).json({ error: 'Thumbnail not available.' });
    }
  }

  // Prevent path traversal
  const resolvedThumb = path.resolve(thumbFile);
  const resolvedDir = path.resolve(path.join(DATA_DIR, 'thumbnails'));
  if (!resolvedThumb.startsWith(resolvedDir)) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  if (!fs.existsSync(resolvedThumb)) {
    return res.status(404).json({ error: 'Thumbnail not found.' });
  }

  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(resolvedThumb);
});

// ── GET /api/videos/:id/comments — list comments for a video ────────────────
router.get('/:id/comments', authOrShareToken, (req, res) => {
  const videoId = parseInt(req.params.id, 10);
  if (isNaN(videoId)) return res.status(400).json({ error: 'Invalid video id.' });

  const video = getVideoById(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  res.json(getCommentsByVideoId(videoId, req.user?.id || null));
});

// ── POST /api/videos/:id/comments — add comment ─────────────────────────────
router.post('/:id/comments', authenticate, (req, res) => {
  const videoId = parseInt(req.params.id, 10);
  if (isNaN(videoId)) return res.status(400).json({ error: 'Invalid video id.' });

  const video = getVideoById(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
  if (content.length > 2000) return res.status(400).json({ error: 'Comment is too long.' });

  let gifUrl = null;
  if (typeof req.body.gif_url === 'string' && req.body.gif_url.trim()) {
    gifUrl = req.body.gif_url.trim();
    try {
      const parsed = new URL(gifUrl);
      const host = parsed.hostname.toLowerCase();
      const isAllowedHost = host.includes('tenor.com') || host.includes('giphy.com') || host.includes('klipy.com');
      if (parsed.protocol !== 'https:' || !isAllowedHost) {
        return res.status(400).json({ error: 'Unsupported GIF URL.' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid GIF URL.' });
    }
  }

  if (!content && !gifUrl) {
    return res.status(400).json({ error: 'Comment cannot be empty.' });
  }

  let parentCommentId = null;
  if (req.body.parent_comment_id !== undefined && req.body.parent_comment_id !== null && req.body.parent_comment_id !== '') {
    parentCommentId = Number(req.body.parent_comment_id);
    if (!Number.isInteger(parentCommentId) || parentCommentId <= 0) {
      return res.status(400).json({ error: 'Invalid parent comment id.' });
    }

    const parentComment = getCommentById(parentCommentId);
    if (!parentComment || parentComment.video_id !== videoId) {
      return res.status(400).json({ error: 'Parent comment not found for this video.' });
    }
  }

  const result = addComment(videoId, req.user.id, content, parentCommentId, gifUrl);
  const created = getCommentById(result.lastInsertRowid);
  res.status(201).json(created);
});

// ── PUT /api/videos/:id/comments/:commentId — edit own/admin comment ───────
router.put('/:id/comments/:commentId', authenticate, (req, res) => {
  const videoId = parseInt(req.params.id, 10);
  const commentId = parseInt(req.params.commentId, 10);
  if (isNaN(videoId) || isNaN(commentId)) {
    return res.status(400).json({ error: 'Invalid ids.' });
  }

  const comment = getCommentById(commentId);
  if (!comment || comment.video_id !== videoId) {
    return res.status(404).json({ error: 'Comment not found.' });
  }

  const canEdit = req.user.role === 'admin' || comment.user_id === req.user.id;
  if (!canEdit) return res.status(403).json({ error: 'Not allowed.' });

  const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
  if (!content) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (content.length > 2000) return res.status(400).json({ error: 'Comment is too long.' });

  updateComment(commentId, content);
  res.json(getCommentById(commentId));
});

// ── DELETE /api/videos/:id/comments/:commentId — delete own/admin comment ──
router.delete('/:id/comments/:commentId', authenticate, (req, res) => {
  const videoId = parseInt(req.params.id, 10);
  const commentId = parseInt(req.params.commentId, 10);
  if (isNaN(videoId) || isNaN(commentId)) {
    return res.status(400).json({ error: 'Invalid ids.' });
  }

  const comment = getCommentById(commentId);
  if (!comment || comment.video_id !== videoId) {
    return res.status(404).json({ error: 'Comment not found.' });
  }

  const canDelete = req.user.role === 'admin' || comment.user_id === req.user.id;
  if (!canDelete) return res.status(403).json({ error: 'Not allowed.' });

  deleteComment(commentId);
  res.json({ message: 'Comment deleted.' });
});

// ── POST /api/videos/:id/comments/:commentId/reaction — toggle like/heart ─
router.post('/:id/comments/:commentId/reaction', authenticate, (req, res) => {
  const videoId = parseInt(req.params.id, 10);
  const commentId = parseInt(req.params.commentId, 10);
  if (isNaN(videoId) || isNaN(commentId)) {
    return res.status(400).json({ error: 'Invalid ids.' });
  }

  const comment = getCommentById(commentId);
  if (!comment || comment.video_id !== videoId) {
    return res.status(404).json({ error: 'Comment not found.' });
  }

  const reactionType = typeof req.body.type === 'string' ? req.body.type.trim().toLowerCase() : 'like';
  if (reactionType !== 'like' && reactionType !== 'heart') {
    return res.status(400).json({ error: 'Invalid reaction type.' });
  }

  if (reactionType === 'heart' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can heart comments.' });
  }

  if (reactionType === 'like') {
    if (hasCommentLike(commentId, req.user.id)) {
      removeCommentLike(commentId, req.user.id);
    } else {
      addCommentLike(commentId, req.user.id);
    }
  } else {
    if (hasCommentHeart(commentId, req.user.id)) {
      removeCommentHeart(commentId, req.user.id);
    } else {
      addCommentHeart(commentId, req.user.id);
    }
  }

  const updated = getCommentsByVideoId(videoId, req.user.id).find((c) => c.id === commentId);
  res.json({
    message: 'Reaction updated.',
    active: reactionType === 'heart' ? Boolean(updated?.viewer_hearted) : Boolean(updated?.viewer_liked),
    reaction_type: reactionType,
    reaction_total: updated?.reaction_total || 0,
    like_count: updated?.like_count || 0,
    heart_count: updated?.heart_count || 0,
    viewer_liked: Boolean(updated?.viewer_liked),
    viewer_hearted: Boolean(updated?.viewer_hearted),
  });
});

// ── GET /api/videos/:id/progress ──────────────────────────────────────────
router.get('/:id/progress', authenticate, (req, res) => {
  const videoId = parseInt(req.params.id, 10);
  if (isNaN(videoId)) return res.status(400).json({ error: 'Invalid video id.' });
  const row = getProgress(req.user.id, videoId);
  res.json({ position: row ? row.position : 0 });
});

// ── POST /api/videos/:id/progress ─────────────────────────────────────────
router.post('/:id/progress', authenticate, (req, res) => {
  const videoId = parseInt(req.params.id, 10);
  if (isNaN(videoId)) return res.status(400).json({ error: 'Invalid video id.' });
  const position = Number(req.body.position);
  if (!Number.isFinite(position) || position < 0) {
    return res.status(400).json({ error: 'position must be a non-negative number.' });
  }
  upsertProgress(req.user.id, videoId, Math.floor(position));
  res.json({ ok: true });
});

// ── Share Endpoints (Admin Only) ─────────────────────────────────────────────

router.get('/:id/share', authenticate, requireAdmin, (req, res) => {
  const token = getVideoShareToken(req.params.id);
  res.json({ token });
});

router.post('/:id/share', authenticate, requireAdmin, (req, res) => {
  const token = createVideoShare(req.params.id);
  res.json({ token });
});

router.delete('/:id/share', authenticate, requireAdmin, (req, res) => {
  deleteVideoShare(req.params.id);
  res.json({ success: true });
});

module.exports = router;
