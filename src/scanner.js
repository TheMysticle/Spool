'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { upsertVideo, removeStaleVideos, getAllVideos, getVideoByPath } = require('./database');
const transcodeQueue = require('./transcode_queue');

const MEDIA_PATH = process.env.MEDIA_PATH || '/media';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const THUMB_DIR = path.join(DATA_DIR, 'thumbnails');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.ts', '.flv']);

// Keywords in path that indicate a livestream
const LIVE_KEYWORDS = /live\s*stream|livestream|live[-_ ]?s\d|live\b/i;

let scanStatus = {
  running: false,
  last_run: null,
  found: 0,
  processed: 0,
  errors: 0,
  message: 'No scan run yet.',
};

function getScanStatus() {
  if (!scanStatus.running) {
    try {
      const all = getAllVideos({ isAdmin: true, limit: 1 });
      scanStatus.found = all.total;
    } catch (err) {}
  }
  return { ...scanStatus };
}

// ── Helper: clean up yt-dlp-style filenames ───────────────────────────────────
function filenameToTitle(filename) {
  // Remove extension
  let title = path.parse(filename).name;
  // Remove [videoId] or (videoId) suffix (11-char YouTube ID)
  title = title.replace(/\s*[\[(][a-zA-Z0-9_-]{11}[\])]\s*$/, '');
  // Remove ALL-CAPS LIVESTREAM / LIVE STREAM keywords only
  title = title.replace(/\b(LIVE\s*STREAMS?|LIVESTREAMS?)\b/g, '');
  // Replace underscores/hyphens between words with spaces
  title = title.replace(/[-_]+/g, ' ').trim();
  // Trim extra whitespace
  title = title.replace(/\s{2,}/g, ' ').trim();
  return title || filename;
}

// ── Helper: detect category from path ────────────────────────────────────────
function detectCategory(filePath) {
  return LIVE_KEYWORDS.test(filePath) ? 'livestream' : 'video';
}

// ── Helper: run ffprobe to get duration + resolution ─────────────────────────
function getVideoMeta(filePath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'format=duration:stream=width,height',
        '-of', 'json',
        filePath,
      ],
      { timeout: 30000 },
      (err, stdout) => {
        if (err) return resolve({ duration: 0, width: 0, height: 0 });
        try {
          const data = JSON.parse(stdout.trim());
          const stream = (data.streams || [])[0] || {};
          const fmt = data.format || {};
          const seconds = parseFloat(fmt.duration);
          resolve({
            duration: isNaN(seconds) ? 0 : Math.round(seconds),
            width: parseInt(stream.width, 10) || 0,
            height: parseInt(stream.height, 10) || 0,
          });
        } catch {
          resolve({ duration: 0, width: 0, height: 0 });
        }
      }
    );
  });
}

// ── Helper: generate thumbnail with ffmpeg ────────────────────────────────────
function buildThumbnailSeekPlan(durationSec = 0) {
  const duration = Math.max(0, Number(durationSec) || 0);
  if (!duration) return [15, 5, 0];

  const safeEnd = Math.max(0, duration - 2);
  const minRandom = Math.max(6, Math.floor(duration * 0.2));
  const maxRandom = Math.max(minRandom, Math.floor(duration * 0.6));
  const boundedMin = Math.min(minRandom, safeEnd);
  const boundedMax = Math.min(maxRandom, safeEnd);
  const randomSeek = boundedMax > boundedMin
    ? Math.floor(boundedMin + Math.random() * (boundedMax - boundedMin + 1))
    : boundedMin;

  const midpoint = Math.min(Math.max(1, Math.floor(duration * 0.5)), safeEnd);
  const lateFallback = Math.min(Math.max(1, 15), safeEnd);

  return Array.from(new Set([randomSeek, midpoint, lateFallback, 5, 0])).filter((s) => s >= 0);
}

function generateThumbnail(filePath, thumbPath, durationSec = 0) {
  return new Promise((resolve) => {
    const seekPlan = buildThumbnailSeekPlan(durationSec);

    const trySeekAt = (index) => {
      if (index >= seekPlan.length) {
        resolve(false);
        return;
      }

      const seek = String(seekPlan[index]);
      execFile(
        'ffmpeg',
        [
          '-ss', seek,
          '-i', filePath,
          '-vframes', '1',
          '-vf', 'scale=640:-1',
          '-q:v', '3',
          '-y',
          thumbPath,
        ],
        { timeout: 60000 },
        (err) => {
          if (err) {
            trySeekAt(index + 1);
            return;
          }
          resolve(true);
        }
      );
    };

    trySeekAt(0);
  });
}

// ── Walk directory recursively ────────────────────────────────────────────────
async function walkDirectory(dir) {
  const results = [];
  try {
    await fs.promises.access(dir, fs.constants.F_OK);
  } catch {
    return results;
  }

  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const backupDirNormalized = path.join(DATA_DIR, 'backups').replace(/\\/g, '/');
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (fullPath.replace(/\\/g, '/').includes(backupDirNormalized)) continue;
    if (entry.isDirectory()) {
      results.push(...(await walkDirectory(fullPath)));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

// ── Main scan function (runs asynchronously) ──────────────────────────────────
async function scanVideos(options = {}) {
  const regenerateThumbnails = Boolean(options.regenerateThumbnails);

  scanStatus = {
    running: true,
    last_run: new Date().toISOString(),
    found: 0,
    processed: 0,
    errors: 0,
    message: regenerateThumbnails ? 'Scanning and regenerating thumbnails…' : 'Scanning…',
  };

  console.log('[Scanner] Starting video scan at:', MEDIA_PATH);

  try {
    const mediaPaths = await walkDirectory(MEDIA_PATH);
    const uploadedPaths = await walkDirectory(VIDEOS_DIR);
    
    // De-duplicate in case VIDEOS_DIR happens to be inside MEDIA_PATH
    const videoPaths = Array.from(new Set([...mediaPaths, ...uploadedPaths]));
    
    scanStatus.found = videoPaths.length;
    console.log(`[Scanner] Found ${videoPaths.length} video files.${regenerateThumbnails ? ' (thumbnail regeneration enabled)' : ''}`);

    for (const filePath of videoPaths) {
      try {
        const stat = await fs.promises.stat(filePath);
        const filename = path.basename(filePath);
        const createdAtMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
        const fileCreatedAt = new Date(createdAtMs).toISOString();
        const thumbName = `${Buffer.from(filePath).toString('base64url').slice(0, 80)}.jpg`;
        const thumbPath = path.join(THUMB_DIR, thumbName);
        const thumbExists = fs.existsSync(thumbPath);

        const meta = await getVideoMeta(filePath);
        if (regenerateThumbnails || !thumbExists) {
          await generateThumbnail(filePath, thumbPath, meta.duration);
        }

        const thumbRelative = fs.existsSync(thumbPath) ? `/thumbnails/${thumbName}` : null;
        const channelMatch = filePath.replace(/\\/g, '/').match(/\/channels\/(\d+)\//);
        const channelId = channelMatch ? parseInt(channelMatch[1], 10) : null;

        upsertVideo({
          filename,
          filepath: filePath,
          title: filenameToTitle(filename),
          category: detectCategory(filePath),
          file_created_at: fileCreatedAt,
          duration: meta.duration,
          file_size: stat.size,
          thumbnail_path: thumbRelative,
          video_width: meta.width,
          video_height: meta.height,
          channel_id: channelId,
        });
        
        const ext = path.extname(filePath).toLowerCase();
        if (['.avi', '.mov', '.flv', '.ts'].includes(ext)) {
          const inserted = getVideoByPath(filePath);
          if (inserted && inserted.id) {
            transcodeQueue.addJob(inserted.id, filePath);
          }
        }

        scanStatus.processed += 1;
      } catch (err) {
        console.error(`[Scanner] Error processing ${filePath}:`, err.message);
        scanStatus.errors += 1;
      }
    }

    // Remove DB entries for files that no longer exist on disk
    removeStaleVideos(videoPaths);

    scanStatus.message = `${regenerateThumbnails ? 'Thumbnail regeneration scan complete' : 'Scan complete'}. ${scanStatus.processed} processed, ${scanStatus.errors} errors.`;
    console.log('[Scanner]', scanStatus.message);
  } catch (err) {
    scanStatus.message = `Scan failed: ${err.message}`;
    console.error('[Scanner] Fatal scan error:', err);
  } finally {
    scanStatus.running = false;
  }
}

// Auto-scan on startup (non-blocking)
setTimeout(() => {
  console.log('[Scanner] Auto-scanning on startup…');
  scanVideos();
}, 3000);

module.exports = { 
  scanVideos, 
  getScanStatus, 
  getVideoMeta, 
  generateThumbnail, 
  filenameToTitle, 
  detectCategory 
};
