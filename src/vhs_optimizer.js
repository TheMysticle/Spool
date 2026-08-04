const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { getAllVideos } = require('./database');

// We no longer rely on checking atoms because a file might have 'moov' at the front 
// but still have terrible audio/video interleaving, which also causes buffering.
// Instead, we will use a marker file to track if Spool has optimized it.

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
      
      const markerPath = video.filepath + '.spool-optimized';
      if (!fs.existsSync(markerPath)) {
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
                fs.writeFileSync(markerPath, '1'); // Create marker file
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
