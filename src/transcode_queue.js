const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const db = require('./database');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const os = require('os');

class TranscodeQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.currentJob = null;
    this.currentProgress = 0;
    
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
  }

  getStatus() {
    const queueEnriched = this.queue.map(job => {
      const video = db.getVideoById(job.videoId);
      return {
        ...job,
        title: video ? video.title : path.basename(job.sourcePath),
        video_height: video ? (video.video_height || 0) : 0,
        file_size: video ? (video.file_size || 0) : 0
      };
    });

    let currentJobEnriched = null;
    if (this.currentJob) {
      const video = db.getVideoById(this.currentJob.videoId);
      currentJobEnriched = {
        ...this.currentJob,
        title: video ? video.title : path.basename(this.currentJob.sourcePath),
        video_height: video ? (video.video_height || 0) : 0,
        file_size: video ? (video.file_size || 0) : 0
      };
    }

    const totalCpus = os.cpus() ? os.cpus().length : 4;
    const defaultThreads = Math.max(1, Math.floor(totalCpus / 2));

    return {
      enabled: db.getSetting('auto_transcode_enabled', '0') === '1',
      confirm4k: db.getSetting('auto_transcode_confirm_4k', '0') === '1',
      confirmSizeMb: parseInt(db.getSetting('auto_transcode_confirm_size_mb', '0'), 10) || 0,
      threads: parseInt(db.getSetting('auto_transcode_threads', String(defaultThreads)), 10),
      totalCpus,
      isProcessing: this.isProcessing,
      currentJob: currentJobEnriched,
      currentProgress: this.currentProgress,
      queue: queueEnriched
    };
  }

  generateThumbnail(filePath, thumbPath) {
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

  addJob(videoId, sourcePath) {
    // Only queue if auto transcode is enabled
    if (db.getSetting('auto_transcode_enabled', '0') !== '1') return;

    if (this.queue.some(job => job.videoId === videoId) || (this.currentJob && this.currentJob.videoId === videoId)) {
      return; // Already in queue
    }

    const video = db.getVideoById(videoId);
    let fileSize = video ? (video.file_size || 0) : 0;
    let videoHeight = video ? (video.video_height || 0) : 0;

    if (!fileSize && fs.existsSync(sourcePath)) {
      try {
        fileSize = fs.statSync(sourcePath).size;
      } catch (e) {}
    }

    const confirm4k = db.getSetting('auto_transcode_confirm_4k', '0') === '1';
    const confirmSizeMb = parseInt(db.getSetting('auto_transcode_confirm_size_mb', '0'), 10) || 0;

    let requiresApproval = false;
    let approvalReason = '';

    if (confirm4k && videoHeight >= 2160) {
      requiresApproval = true;
      approvalReason = '4K resolution (>=2160p)';
    }

    if (confirmSizeMb > 0 && fileSize >= confirmSizeMb * 1024 * 1024) {
      requiresApproval = true;
      approvalReason = approvalReason
        ? `${approvalReason} & file size >= ${confirmSizeMb}MB`
        : `File size >= ${confirmSizeMb}MB`;
    }

    const job = {
      videoId,
      sourcePath,
      requiresApproval,
      approvalReason,
      status: requiresApproval ? 'pending_approval' : 'queued'
    };

    this.queue.push(job);
    console.log(`[Transcoder] Added video ${videoId} to queue (requiresApproval: ${requiresApproval}). Queue length: ${this.queue.length}`);
    this.processNext();
  }

  approveJob(videoId) {
    const job = this.queue.find(j => String(j.videoId) === String(videoId));
    if (job) {
      job.requiresApproval = false;
      job.status = 'queued';
      console.log(`[Transcoder] Job for video ${videoId} manually approved.`);
      this.processNext();
      return true;
    }
    return false;
  }

  removeJob(videoId) {
    const initialLen = this.queue.length;
    this.queue = this.queue.filter(j => String(j.videoId) !== String(videoId));
    return this.queue.length < initialLen;
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;

    // Find first job that does NOT require approval
    const eligibleIndex = this.queue.findIndex(j => !j.requiresApproval);
    if (eligibleIndex === -1) return; // All remaining jobs are pending approval

    this.isProcessing = true;
    this.currentJob = this.queue.splice(eligibleIndex, 1)[0];

    const { videoId, sourcePath } = this.currentJob;

    try {
      console.log(`[Transcoder] Starting transcode for video ${videoId}: ${sourcePath}`);
      
      const parsedPath = path.parse(sourcePath);
      const outputFilename = `${parsedPath.name}.mkv`;
      const outputPath = path.join(parsedPath.dir, outputFilename);

      if (fs.existsSync(outputPath)) {
        throw new Error('Output MKV already exists');
      }

      const video = db.getVideoById(videoId);
      const duration = video ? (video.duration || 0) : 0;
      this.currentProgress = 0;

      await this.runFfmpeg(sourcePath, outputPath, duration);

      console.log(`[Transcoder] Transcode successful for ${videoId}. Moving original to backups.`);
      
      const sourceStats = fs.statSync(sourcePath);
      
      const backupPath = path.join(BACKUP_DIR, parsedPath.base);
      fs.copyFileSync(sourcePath, backupPath);
      fs.unlinkSync(sourcePath);

      // Preserve original timestamps on the new MKV file
      fs.utimesSync(outputPath, sourceStats.atime, sourceStats.mtime);

      const stats = fs.statSync(outputPath);
      
      // Generate new thumbnail for the new MKV
      const thumbFilename = `${Buffer.from(outputPath).toString('base64url').slice(0, 80)}.jpg`;
      const thumbPath = path.join(DATA_DIR, 'thumbnails', thumbFilename);
      await this.generateThumbnail(outputPath, thumbPath);
      
      const thumbRelative = `/thumbnails/${thumbFilename}`;
      db.updateVideoFilepath(videoId, outputFilename, outputPath, stats.size);
      db.setVideoThumbnail(videoId, thumbRelative);

      console.log(`[Transcoder] Finished processing video ${videoId}. Output: ${outputFilename}`);
    } catch (err) {
      console.error(`[Transcoder] Error processing video ${videoId}:`, err.message);
    } finally {
      this.currentJob = null;
      this.isProcessing = false;
      this.processNext();
    }
  }

  runFfmpeg(sourcePath, outputPath, durationSeconds) {
    return new Promise((resolve, reject) => {
      const totalCpus = os.cpus() ? os.cpus().length : 4;
      const defaultThreads = Math.max(1, Math.floor(totalCpus / 2));
      const threadsSetting = parseInt(db.getSetting('auto_transcode_threads', String(defaultThreads)), 10);
      const threads = isNaN(threadsSetting) || threadsSetting <= 0 ? defaultThreads : threadsSetting;

      const preset = 'veryfast';
      const lookahead = threads <= 1 ? 0 : 1;

      const args = [
        '-y',
        '-i', sourcePath,
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', '22',
        '-threads', String(threads),
        '-x264-params', `threads=${threads}:lookahead_threads=${lookahead}:sliced-threads=1`,
        '-c:a', 'aac',
        '-b:a', '128k',
        '-f', 'matroska',
        outputPath
      ];

      console.log(`[Transcoder] Spawning FFmpeg with ${threads} CPU thread(s) (preset: ${preset})...`);
      const proc = spawn('ffmpeg', args);

      // Lower process priority on Windows/Linux to keep host OS smooth
      if (proc.pid) {
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

      if (durationSeconds > 0) {
        proc.stderr.on('data', (data) => {
          const text = data.toString();
          const match = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
          if (match) {
            const h = parseFloat(match[1]);
            const m = parseFloat(match[2]);
            const s = parseFloat(match[3]);
            const currentSec = h * 3600 + m * 60 + s;
            this.currentProgress = Math.min(100, Math.round((currentSec / durationSeconds) * 100));
          }
        });
      }

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
      
      proc.on('error', (err) => {
        reject(err);
      });
    });
  }
}

module.exports = new TranscodeQueue();
