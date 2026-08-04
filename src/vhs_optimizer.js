const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { getAllVideos } = require('./database');

// Fast check if an MP4 has the moov atom before mdat
function isFastStart(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8);
    let offset = 0;
    let hasMoov = false;
    let hasMdat = false;

    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, 8, offset);
      if (bytesRead < 8) break;
      
      const size = buffer.readUInt32BE(0);
      const type = buffer.toString('ascii', 4, 8);
      
      if (type === 'moov') {
        hasMoov = true;
        break; // moov comes before mdat -> faststart
      }
      if (type === 'mdat') {
        hasMdat = true;
        break; // mdat comes before moov -> NOT faststart
      }
      
      if (size === 1) { // 64-bit size
        const extBuffer = Buffer.alloc(8);
        fs.readSync(fd, extBuffer, 0, 8, offset + 8);
        const hugeSize = Number(extBuffer.readBigUInt64BE(0));
        offset += hugeSize;
      } else if (size === 0) {
        break; // reaches end of file
      } else {
        offset += size;
      }
    }
    return hasMoov && !hasMdat;
  } catch (err) {
    console.error(`[VHS Optimizer] Error reading headers for ${filePath}: ${err.message}`);
    return true; // Fail safe: assume optimized so we don't accidentally ruin a file we can't read
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Background task to optimize all VHS videos
async function autoOptimizeVhsVideos() {
  console.log('[VHS Optimizer] Starting background VHS optimization check...');
  
  try {
    // Get all videos with pagination large enough to cover the library
    const data = getAllVideos({ category: 'all', includeVhs: true, isAdmin: true, limit: 100000 });
    const vhsVideos = (data.videos || []).filter(v => v.is_vhs === 1);
    
    let optimizedCount = 0;
    
    for (const video of vhsVideos) {
      if (!fs.existsSync(video.filepath)) continue;
      if (path.extname(video.filepath).toLowerCase() !== '.mp4') continue;
      
      if (!isFastStart(video.filepath)) {
        console.log(`[VHS Optimizer] Optimizing VHS video: "${video.title}"...`);
        const tempPath = video.filepath + '.optimized.mp4';
        
        await new Promise((resolve) => {
          // -c copy bypasses all CPU transcoding, -threads 1 ensures zero load, -y overwrites if temp exists
          const cmd = `ffmpeg -y -i "${video.filepath}" -c copy -threads 1 -movflags +faststart "${tempPath}"`;
          exec(cmd, (err) => {
            if (err) {
              console.error(`[VHS Optimizer] Failed to optimize "${video.title}": ${err.message}`);
              if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } else {
              try {
                fs.unlinkSync(video.filepath);
                fs.renameSync(tempPath, video.filepath);
                console.log(`[VHS Optimizer] Successfully optimized "${video.title}".`);
                optimizedCount++;
              } catch (fsErr) {
                console.error(`[VHS Optimizer] File system error replacing "${video.title}": ${fsErr.message}`);
              }
            }
            resolve();
          });
        });
      }
    }
    
    console.log(`[VHS Optimizer] Finished. Optimizations applied: ${optimizedCount}`);
  } catch (err) {
    console.error(`[VHS Optimizer] Unexpected error: ${err.message}`);
  }
}

module.exports = { autoOptimizeVhsVideos };
