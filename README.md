# Spool — README

A YouTube-like self-hosted web player for your personal video library. Browse, search, and watch any of your videos with a clean, modern interface.

---

## Quick Start

### 1. Configure secrets

Edit `docker-compose.yml` and change:
- `JWT_SECRET` — Any long random string (32+ chars). e.g. use `openssl rand -hex 32`
- `ADMIN_USERNAME` — Your admin login username
- `ADMIN_PASSWORD` — Your admin password (min 8 chars)

### 2. Build and start

```bash
cd "Spool"
docker compose up -d --build
```

### 3. Open in browser

```
http://YOUR_UNRAID_IP:443
```

Log in with your admin credentials. The server will automatically scan your media directory on first boot — this may take a few minutes depending on how many files you have.

---

## Features

- **Browse & search** ~500 videos in a responsive grid
- **Two categories**: Videos and Live Streams (auto-detected, manually overridable)
- **In-browser playback** with seek, speed control (0.5x–2x), fullscreen
- **Auto thumbnails** — generated from each video via FFmpeg (taken at 5 seconds)
- **Multiple user accounts** — Admin and Viewer roles
- **Admin panel** — manage users, edit video titles/descriptions/categories, trigger rescans
- **Read-only media mount** — your files cannot be deleted by the app

---

## File structure

```
Spool/
├── docker-compose.yml       ← Main config — edit secrets here
├── Dockerfile
├── server.js                ← Express app entry point
├── src/
│   ├── database.js          ← SQLite schema & queries
│   ├── scanner.js           ← Video directory scanner + thumbnail generator
│   ├── middleware/auth.js   ← JWT auth middleware
│   └── routes/
│       ├── auth.js          ← Login, /me, change-password
│       ├── videos.js        ← List, stream, metadata
│       └── admin.js         ← User management, scan trigger
└── public/                  ← Frontend (served as static files)
    ├── index.html           ← Browse/home page
    ├── watch.html           ← Video player
    ├── login.html           ← Login page
    ├── admin.html           ← Admin panel
    ├── css/style.css
    └── js/
        ├── shared.js        ← Auth helpers, API wrapper, toasts
        ├── main.js          ← Browse page logic
        ├── watch.js         ← Player page logic
        └── admin.js         ← Admin panel logic
```

---

## Data persistence

The `/mnt/user/appdata/Spool/` folder on your Unraid NAS contains:
- `spool.db` — SQLite database (users, video metadata)
- `thumbnails/` — Auto-generated JPEG thumbnails

Back up this folder to preserve your custom titles, descriptions, and user accounts.

---

## Ports

| Port | Service |
|------|---------|
| 443 | Spool web interface |

---

## Folder detection

The scanner detects whether a video is a "Live Stream" or "Video" by checking if its file path contains words like: `live`, `stream`, `livestream`. You can override the category for any video in the Admin panel.

---

## Rescanning your library

If you add new videos to the NAS, go to **Admin → Library Scan → Start Scan**. The scanner will:
1. Find all new video files
2. Generate thumbnails with FFmpeg
3. Probe duration with FFprobe
4. Add them to the database
5. Remove any DB entries for files that have been deleted

---

## Development & Hot Reloading

The `docker-compose.yml` now mounts your source code from `/mnt/user/appdata/Spool/`, allowing you to edit files without rebuilding the image:

### Workflow

1. **Copy source code to appdata** (first time only):
   ```bash
   mkdir -p /mnt/user/appdata/Spool/{src,public,data}
   cp -r src/* /mnt/user/appdata/Spool/src/
   cp -r public/* /mnt/user/appdata/Spool/public/
   cp server.js package.json /mnt/user/appdata/Spool/
   ```

2. **Make code changes** — Edit files in `/mnt/user/appdata/Spool/` on your Unraid NAS
   - `server.js` — Backend entry point
   - `src/` — Route handlers, database, scanner
   - `public/` — Frontend HTML, JS, CSS

3. **Restart container** — Changes are reflected immediately:
   ```bash
   docker compose restart spool
   ```

4. **Done** — No image rebuild needed

### What's mounted

- `/mnt/user/appdata/Spool/src/` → `/app/src`
- `/mnt/user/appdata/Spool/public/` → `/app/public`
- `/mnt/user/appdata/Spool/server.js` → `/app/server.js`
- `/mnt/user/appdata/Spool/package.json` → `/app/package.json`
- `/mnt/user/appdata/Spool/data/` → `/app/data` (database + thumbnails)

### Disabling volume mounts (for production)

Comment out the source code volumes in `docker-compose.yml` if you want to lock the app to the built image:

```yaml
volumes:
  - /mnt/user/Media/YouTubeBackup:/media:ro
  - /mnt/user/appdata/Spool/data:/app/data
  # - /mnt/user/appdata/Spool/src:/app/src              ← comment these out
  # - /mnt/user/appdata/Spool/public:/app/public
  # ...
```

---

## Updating

### With hot reload (development)

```bash
# Edit files directly on NAS
ssh <unraid> 'nano /mnt/user/appdata/Spool/src/routes/videos.js'

# Or use Unraid's file manager to edit files

# Restart container to pick up changes
docker compose restart spool
```

### Without hot reload (production)

```bash
# Full rebuild to lock in changes
docker compose down
docker compose up -d --build
```

Your database and thumbnails are always preserved in `/mnt/user/appdata/Spool/data/`.

---

## Troubleshooting

### Container won't start

```bash
# Check logs
docker compose logs -f spool

# Verify volumes are mounted
docker inspect spool | grep -A 20 Mounts
```

### Changes not reflected after restart

1. Verify the volume mount exists: `docker inspect spool` (look for Mounts section)
2. Check file permissions on host: `ls -la src/routes/videos.js`
3. Restart again to force reload: `docker compose restart spool`

### "Cannot find module" after updating package.json

You need to rebuild the image to install new dependencies:

```bash
docker compose down
docker compose up -d --build
```

---

## Architecture

- **Frontend**: Express serves static HTML/JS/CSS from `/public`
- **Backend**: Node.js Express app with SQLite database
- **FFmpeg**: Used for thumbnail generation and video probing (codec detection)
- **Auth**: JWT tokens stored in localStorage (browser) and verified server-side
- **Video Streaming**: HTTP range requests for direct playback + on-demand MP4 transcode fallback
