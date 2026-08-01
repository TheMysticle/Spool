const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');

async function compressAvatars() {
  if (!fs.existsSync(AVATAR_DIR)) {
    console.log('[Compress] No avatars directory found. Skipping.');
    return;
  }

  const files = fs.readdirSync(AVATAR_DIR);
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    if (file.startsWith('banner_')) {
      skipped++;
      continue;
    }
    
    if (file.match(/\.(jpg|jpeg|png|webp)$/i)) {
      const absPath = path.join(AVATAR_DIR, file);
      try {
        const stats = fs.statSync(absPath);
        // Skip files smaller than 100KB as they are likely already compressed
        if (stats.size < 100 * 1024) {
          skipped++;
          continue;
        }

        const buffer = fs.readFileSync(absPath);
        
        const compressedBuffer = await sharp(buffer)
          .resize(512, 512, { fit: 'cover' })
          .jpeg({ quality: 80 })
          .toBuffer();
          
        fs.writeFileSync(absPath, compressedBuffer);
        console.log(`[Compress] Compressed ${file}`);
        processed++;
      } catch (err) {
        console.error(`[Compress] Failed to compress ${file}:`, err.message);
        errors++;
      }
    } else {
      skipped++;
    }
  }
  
  console.log(`\n[Compress] Done. Processed: ${processed}, Skipped: ${skipped}, Errors: ${errors}`);
}

compressAvatars().catch(console.error);
