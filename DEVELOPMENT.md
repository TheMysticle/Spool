# Quick Development Workflow (Unraid)

## One-Time Setup

Copy source code to your NAS appdata folder:

```bash
# On your Unraid terminal or via SSH:
mkdir -p /mnt/user/appdata/Spool/{src,public,data}

# Copy from your development machine:
cd ~/Mysticle\ Archives
cp -r src/* /mnt/user/appdata/Spool/src/
cp -r public/* /mnt/user/appdata/Spool/public/
cp server.js package.json /mnt/user/appdata/Spool/
```

## Edit & Restart (No Rebuild!)

```bash
# 1. Edit files on NAS
# Via SSH from your machine: 
ssh root@<unraid-ip> 'nano /mnt/user/appdata/Spool/src/routes/videos.js'

# Or use Unraid web UI file manager to edit files

# 2. Restart the container (picks up changes immediately)
docker compose restart spool

# 3. Hard-refresh browser (Ctrl+Shift+R)
# Done! Your changes are live
```

## Full Rebuild (if you add packages)

```bash
docker compose down
docker compose up -d --build
```

## Useful Commands

```bash
# View live logs
docker compose logs -f spool

# Stop the app
docker compose down

# Start without rebuilding
docker compose up -d

# Check container health
docker compose ps

# SSH into Unraid and check files
ssh root@<unraid-ip> 'ls -la /mnt/user/appdata/Spool/'
```

## Volume Mounts Active

Your `docker-compose.yml` mounts these directories from your Unraid NAS:

- `/mnt/user/appdata/Spool/src/` → `/app/src` (backend code)
- `/mnt/user/appdata/Spool/public/` → `/app/public` (frontend)
- `/mnt/user/appdata/Spool/server.js` → `/app/server.js` (entry point)
- `/mnt/user/appdata/Spool/package.json` → `/app/package.json` (deps)
- `/mnt/user/appdata/Spool/data/` → `/app/data` (database + thumbnails)

Changes to these files are immediately visible inside the container. Just restart to reload Node.js.

## Folder Structure on NAS

```
/mnt/user/appdata/Spool/
├── data/                    ← Database + thumbnails (auto-created)
│   ├── spool.db
│   └── thumbnails/
├── src/                     ← Backend source code
│   ├── database.js
│   ├── scanner.js
│   ├── middleware/
│   └── routes/
│       ├── auth.js
│       ├── videos.js
│       └── admin.js
├── public/                  ← Frontend
│   ├── index.html
│   ├── watch.html
│   ├── login.html
│   ├── admin.html
│   ├── css/
│   └── js/
├── server.js                ← Express entry point
└── package.json             ← Node dependencies
```

## Quick Development Loop

1. **Edit** a file in `/mnt/user/appdata/Spool/` (use SSH, Unraid UI, or SMB)
2. **Restart**: `docker compose restart spool`
3. **Refresh**: Ctrl+Shift+R in browser
4. **Repeat**

No Docker image rebuild needed!

## Example: Fixing JavaScript

```bash
# Edit the watch page player logic
ssh root@<unraid-ip> 'nano /mnt/user/appdata/Spool/public/js/watch.js'

# Make your changes, save, exit

# Restart container
docker compose restart spool

# Hard-refresh browser (Ctrl+Shift+R)
# Your changes are live!
```

## Switching to Production (Lock to Image)

Comment out the source code volumes in `docker-compose.yml` to use only the baked-in Docker image. Keep the data volume mounted to preserve your database:

```yaml
volumes:
  - /mnt/user/Media/YouTubeBackup:/media:ro
  - /mnt/user/appdata/Spool/data:/app/data
  # - /mnt/user/appdata/Spool/src:/app/src        ← comment out to lock
  # - /mnt/user/appdata/Spool/public:/app/public
  # - /mnt/user/appdata/Spool/server.js:/app/server.js
  # - /mnt/user/appdata/Spool/package.json:/app/package.json
```

Then rebuild the image:
```bash
docker compose down
docker compose up -d --build
```

Now the app uses only code from the Docker image, not from NAS volumes.

---

See README.md for more information.
