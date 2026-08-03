'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'spool.db');

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'thumbnails'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'avatars'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'people'), { recursive: true });

let db;

function parseEmbeddedVideoDateAndTitle(rawTitle, fallbackDate) {
  const safeTitle = String(rawTitle || '');
  const normalized = safeTitle.replace(/^\uFEFF/, '').trimStart();
  const match = normalized.match(/^(\d{4})(\d{2})(\d{2})[\s_-]+(.+)$/);

  if (match) {
    const [, y, m, d, rest] = match;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    const dt = new Date(Date.UTC(year, month - 1, day));
    const valid =
      dt.getUTCFullYear() === year &&
      dt.getUTCMonth() === month - 1 &&
      dt.getUTCDate() === day;

    if (valid) {
      return {
        title: (rest || '').trim() || normalized,
        contentDateIso: dt.toISOString(),
      };
    }
  }

  const fallback = fallbackDate ? new Date(fallbackDate) : null;
  return {
    title: normalized || safeTitle,
    contentDateIso: fallback && !Number.isNaN(fallback.getTime()) ? fallback.toISOString() : null,
  };
}

function splitTitleTags(rawTags) {
  return String(rawTags || '')
    .toLowerCase()
    .split(/[\n,;]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function titleMatchesAnyTag(title, rawTags) {
  const normalizedTitle = String(title || '').toLowerCase();
  return splitTitleTags(rawTags).some((tag) => normalizedTitle.includes(tag));
}

function getPeopleWithTitleTags() {
  return db.prepare("SELECT id, name, title_tags FROM people WHERE COALESCE(title_tags, '') != ''").all();
}

function initDatabase() {
  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ── Schema ────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    UNIQUE NOT NULL,
      password_hash TEXT    NOT NULL,
      twofa_secret  TEXT,
      twofa_enabled INTEGER NOT NULL DEFAULT 0,
      display_name  TEXT,
      avatar_path   TEXT,
      role          TEXT    NOT NULL DEFAULT 'viewer'  CHECK(role IN ('admin', 'viewer')),
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login    DATETIME,
      can_upload    INTEGER NOT NULL DEFAULT 0,
      can_download  INTEGER NOT NULL DEFAULT 0,
      volume        REAL    DEFAULT 1.0
    );

    CREATE TABLE IF NOT EXISTS videos (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      filename       TEXT    NOT NULL,
      filepath       TEXT    UNIQUE NOT NULL,
      title          TEXT    NOT NULL,
      original_title TEXT,
      description    TEXT    DEFAULT '',
      category       TEXT    NOT NULL DEFAULT 'video' CHECK(category IN ('video', 'livestream')),
      content_date   DATETIME,
      file_created_at DATETIME,
      duration       INTEGER DEFAULT 0,
      file_size      INTEGER DEFAULT 0,
      thumbnail_path TEXT,
      video_width    INTEGER DEFAULT 0,
      video_height   INTEGER DEFAULT 0,
      view_count     INTEGER DEFAULT 0,
      scanned_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_vhs         INTEGER NOT NULL DEFAULT 0,
      vhs_start_date DATETIME,
      vhs_end_date   DATETIME,
      has_chapters   INTEGER DEFAULT 0,
      chapters_json  TEXT    DEFAULT '[]',
      location       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category);
    CREATE INDEX IF NOT EXISTS idx_videos_title    ON videos(title);
    CREATE INDEX IF NOT EXISTS idx_videos_file_created_at ON videos(file_created_at);

    CREATE TABLE IF NOT EXISTS comments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id    INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      parent_comment_id INTEGER,
      content     TEXT    NOT NULL,
      gif_url     TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME,
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_comment_id) REFERENCES comments(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_comments_video_id ON comments(video_id);
    CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at);

    CREATE TABLE IF NOT EXISTS comment_reactions (
      comment_id     INTEGER NOT NULL,
      user_id        INTEGER NOT NULL,
      reaction_type  TEXT    NOT NULL CHECK(reaction_type IN ('like', 'heart')),
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(comment_id, user_id),
      FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment
      ON comment_reactions(comment_id);

    CREATE TABLE IF NOT EXISTS comment_likes (
      comment_id  INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(comment_id, user_id),
      FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS comment_hearts (
      comment_id  INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(comment_id, user_id),
      FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id);
    CREATE INDEX IF NOT EXISTS idx_comment_hearts_comment ON comment_hearts(comment_id);

    CREATE TABLE IF NOT EXISTS video_progress (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      video_id   INTEGER NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, video_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_progress_user ON video_progress(user_id);

    CREATE TABLE IF NOT EXISTS user_favorites (
      user_id    INTEGER NOT NULL,
      video_id   INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id, video_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_favorites_user_created
      ON user_favorites(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS people (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      second_name TEXT   NOT NULL DEFAULT '',
      surname    TEXT    NOT NULL DEFAULT '',
      bio        TEXT    NOT NULL DEFAULT '',
      title_tags TEXT    NOT NULL DEFAULT '',
      image_path TEXT,
      user_id    INTEGER UNIQUE,
      channel_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS video_people (
      video_id   INTEGER NOT NULL,
      person_id  INTEGER NOT NULL,
      PRIMARY KEY(video_id, person_id),
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE,
      FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_video_people_video ON video_people(video_id);

    CREATE TABLE IF NOT EXISTS video_people_auto (
      video_id   INTEGER NOT NULL,
      person_id  INTEGER NOT NULL,
      PRIMARY KEY(video_id, person_id),
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE,
      FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_video_people_auto_video ON video_people_auto(video_id);

    CREATE TABLE IF NOT EXISTS video_access_all (
      video_id INTEGER PRIMARY KEY,
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS video_access_users (
      video_id INTEGER NOT NULL,
      user_id  INTEGER NOT NULL,
      PRIMARY KEY(video_id, user_id),
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_video_access_users_video ON video_access_users(video_id);

    CREATE TABLE IF NOT EXISTS video_shares (
      video_id   INTEGER PRIMARY KEY,
      token      TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS series (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      created_by  INTEGER,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS series_videos (
      series_id   INTEGER NOT NULL,
      video_id    INTEGER NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(series_id, video_id),
      FOREIGN KEY(series_id) REFERENCES series(id) ON DELETE CASCADE,
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_series_videos_series ON series_videos(series_id, sort_order, created_at);

    CREATE TABLE IF NOT EXISTS series_access_all (
      series_id INTEGER PRIMARY KEY,
      FOREIGN KEY(series_id) REFERENCES series(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS series_access_users (
      series_id INTEGER NOT NULL,
      user_id   INTEGER NOT NULL,
      PRIMARY KEY(series_id, user_id),
      FOREIGN KEY(series_id) REFERENCES series(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_series_access_users_series ON series_access_users(series_id);

    CREATE TABLE IF NOT EXISTS dialogs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      body        TEXT    NOT NULL,
      title_pl    TEXT,
      body_pl     TEXT,
      created_by  INTEGER,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS dialog_reads (
      user_id    INTEGER NOT NULL,
      dialog_id  INTEGER NOT NULL,
      read_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id, dialog_id),
      FOREIGN KEY(user_id)   REFERENCES users(id)   ON DELETE CASCADE,
      FOREIGN KEY(dialog_id) REFERENCES dialogs(id)  ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER,
      action      TEXT    NOT NULL,
      details     TEXT,
      ip_address  TEXT,
      user_agent  TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comment_reads (
      user_id    INTEGER NOT NULL,
      comment_id INTEGER NOT NULL,
      PRIMARY KEY(user_id, comment_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE
    );
  `);

  db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('channel_name', 'Mysticle Archive')`);

  // Migration for older databases that were created before file_created_at existed.
  const videoColumns = db.prepare('PRAGMA table_info(videos)').all();
  const hasFileCreatedAt = videoColumns.some((col) => col.name === 'file_created_at');
  if (!hasFileCreatedAt) {
    db.exec('ALTER TABLE videos ADD COLUMN file_created_at DATETIME');
    db.exec('CREATE INDEX IF NOT EXISTS idx_videos_file_created_at ON videos(file_created_at)');
  }

  const hasVideoWidth = videoColumns.some((col) => col.name === 'video_width');
  if (!hasVideoWidth) {
    db.exec('ALTER TABLE videos ADD COLUMN video_width INTEGER DEFAULT 0');
    db.exec('ALTER TABLE videos ADD COLUMN video_height INTEGER DEFAULT 0');
  }

  const hasOriginalTitle = videoColumns.some((col) => col.name === 'original_title');
  if (!hasOriginalTitle) {
    db.exec('ALTER TABLE videos ADD COLUMN original_title TEXT');
  }

  const hasContentDate = videoColumns.some((col) => col.name === 'content_date');
  if (!hasContentDate) {
    db.exec('ALTER TABLE videos ADD COLUMN content_date DATETIME');
  }

  const hasLocation = videoColumns.some((col) => col.name === 'location');
  if (!hasLocation) {
    db.exec('ALTER TABLE videos ADD COLUMN location TEXT');
  }

  // One-time normalization/backfill for legacy rows during schema migration.
  if (!hasOriginalTitle || !hasContentDate) {
    const rowsToBackfill = db
      .prepare(
        `SELECT id, title, original_title, content_date, file_created_at
         FROM videos`
      )
      .all();
    const backfillStmt = db.prepare(
      `UPDATE videos
       SET title = ?,
           original_title = COALESCE(original_title, ?),
           content_date = ?,
           file_created_at = COALESCE(?, file_created_at)
       WHERE id = ?`
    );
    const backfillTx = db.transaction((rows) => {
      for (const row of rows) {
        const sourceTitle = row.original_title || row.title || '';
        const parsed = parseEmbeddedVideoDateAndTitle(sourceTitle, row.file_created_at);
        backfillStmt.run(
          parsed.title,
          sourceTitle,
          parsed.contentDateIso,
          parsed.contentDateIso,
          row.id
        );
      }
    });
    backfillTx(rowsToBackfill);
  }

  // One-time cleanup to restore mixed-case 'Livestream' while stripping legacy ALL-CAPS 'LIVESTREAM'
  const hasCleanedLivestreamsV3 = videoColumns.some((col) => col.name === 'livestream_caps_cleaned_v3');
  if (!hasCleanedLivestreamsV3) {
    try {
      db.exec('ALTER TABLE videos ADD COLUMN livestream_caps_cleaned_v3 INTEGER DEFAULT 0');
      const allVideos = db.prepare("SELECT id, title, original_title, file_created_at FROM videos").all();
      const updateStmt = db.prepare("UPDATE videos SET title = ?, livestream_caps_cleaned_v3 = 1 WHERE id = ?");
      for (const v of allVideos) {
        const rawSource = v.original_title || v.title || '';
        // If original_title has mixed/lowercase 'Livestream' (and NOT ALL-CAPS), restore it!
        if (/\b(live\s*streams?|livestreams?)\b/i.test(rawSource) && !/\b(LIVE\s*STREAMS?|LIVESTREAMS?)\b/.test(rawSource)) {
          let parsed = parseEmbeddedVideoDateAndTitle(rawSource, v.file_created_at);
          let restored = (parsed.title || '').replace(/[-_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
          if (restored && restored !== v.title) {
            updateStmt.run(restored, v.id);
          }
        } else if (/\b(LIVE\s*STREAMS?|LIVESTREAMS?)\b/.test(v.title)) {
          // If title has ALL-CAPS LIVESTREAM, strip ONLY ALL-CAPS
          let cleaned = v.title
            .replace(/\b(LIVE\s*STREAMS?|LIVESTREAMS?)\b/g, '')
            .replace(/[-_]+/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
          if (cleaned && cleaned !== v.title) {
            updateStmt.run(cleaned, v.id);
          }
        }
      }
      try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (e) {}
    } catch (e) {
      console.warn('[DB] Migration error cleaning livestream titles:', e.message);
    }
  }

  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  const hasAvatarPath = userColumns.some((col) => col.name === 'avatar_path');
  if (!hasAvatarPath) {
    db.exec('ALTER TABLE users ADD COLUMN avatar_path TEXT');
  }
  const hasTwofaSecret = userColumns.some((col) => col.name === 'twofa_secret');
  if (!hasTwofaSecret) {
    db.exec('ALTER TABLE users ADD COLUMN twofa_secret TEXT');
  }
  const hasTwofaEnabled = userColumns.some((col) => col.name === 'twofa_enabled');
  if (!hasTwofaEnabled) {
    db.exec('ALTER TABLE users ADD COLUMN twofa_enabled INTEGER NOT NULL DEFAULT 0');
  }
  const hasCanDownload = userColumns.some((col) => col.name === 'can_download');
  if (!hasCanDownload) {
    db.exec('ALTER TABLE users ADD COLUMN can_download INTEGER NOT NULL DEFAULT 0');
  }

  const commentColumns = db.prepare('PRAGMA table_info(comments)').all();
  const hasParentCommentId = commentColumns.some((col) => col.name === 'parent_comment_id');
  if (!hasParentCommentId) {
    db.exec('ALTER TABLE comments ADD COLUMN parent_comment_id INTEGER');
  }
  const hasGifUrl = commentColumns.some((col) => col.name === 'gif_url');
  if (!hasGifUrl) {
    db.exec('ALTER TABLE comments ADD COLUMN gif_url TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_comment_id)');

  const peopleColumns = db.prepare('PRAGMA table_info(people)').all();
  const hasTitleTags = peopleColumns.some((col) => col.name === 'title_tags');
  if (!hasTitleTags) {
    db.exec("ALTER TABLE people ADD COLUMN title_tags TEXT NOT NULL DEFAULT ''");
  }
  const hasSecondName = peopleColumns.some((col) => col.name === 'second_name');
  if (!hasSecondName) {
    db.exec("ALTER TABLE people ADD COLUMN second_name TEXT NOT NULL DEFAULT ''");
  }
  const hasSurname = peopleColumns.some((col) => col.name === 'surname');
  if (!hasSurname) {
    db.exec("ALTER TABLE people ADD COLUMN surname TEXT NOT NULL DEFAULT ''");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS person_vhs_photos (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id       INTEGER NOT NULL,
      image_path      TEXT    NOT NULL,
      effective_date  TEXT,
      label           TEXT    NOT NULL DEFAULT '',
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_person_vhs_photos_person ON person_vhs_photos(person_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS video_people_auto (
      video_id   INTEGER NOT NULL,
      person_id  INTEGER NOT NULL,
      PRIMARY KEY(video_id, person_id),
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE,
      FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_video_people_auto_video ON video_people_auto(video_id)');

  const dialogColumns = db.prepare('PRAGMA table_info(dialogs)').all();
  const hasTitlePl = dialogColumns.some((col) => col.name === 'title_pl');
  if (!hasTitlePl) {
    db.exec('ALTER TABLE dialogs ADD COLUMN title_pl TEXT');
  }
  const hasBodyPl = dialogColumns.some((col) => col.name === 'body_pl');
  if (!hasBodyPl) {
    db.exec('ALTER TABLE dialogs ADD COLUMN body_pl TEXT');
  }

  // ── Multi-user upload / channels migrations ───────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      avatar_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  const usersCols = db.prepare('PRAGMA table_info(users)').all();
  if (!usersCols.some(c => c.name === 'can_upload')) {
    db.exec('ALTER TABLE users ADD COLUMN can_upload INTEGER NOT NULL DEFAULT 0');
  }
  if (!usersCols.some(c => c.name === 'password_changed_at')) {
    db.exec('ALTER TABLE users ADD COLUMN password_changed_at DATETIME');
  }
  if (!usersCols.some(c => c.name === 'volume')) {
    db.exec('ALTER TABLE users ADD COLUMN volume REAL DEFAULT 1.0');
  }

  const vidsCols = db.prepare('PRAGMA table_info(videos)').all();
  if (!vidsCols.some(c => c.name === 'channel_id')) {
    db.exec('ALTER TABLE videos ADD COLUMN channel_id INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id)');
  }

  // ── Channel Page Overhaul migrations ────────────────────────────────────────
  const chanCols = db.prepare('PRAGMA table_info(channels)').all();
  if (!chanCols.some(c => c.name === 'banner_path')) {
    db.exec('ALTER TABLE channels ADD COLUMN banner_path TEXT');
  }
  if (!chanCols.some(c => c.name === 'vhs_password')) {
    db.exec('ALTER TABLE channels ADD COLUMN vhs_password TEXT');
  }

  if (!vidsCols.some(c => c.name === 'is_vhs')) {
    db.exec('ALTER TABLE videos ADD COLUMN is_vhs INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_videos_is_vhs ON videos(is_vhs)');
  }
  if (!vidsCols.some(c => c.name === 'vhs_start_date')) {
    db.exec('ALTER TABLE videos ADD COLUMN vhs_start_date DATETIME');
  }
  if (!vidsCols.some(c => c.name === 'vhs_end_date')) {
    db.exec('ALTER TABLE videos ADD COLUMN vhs_end_date DATETIME');
  }
  if (!vidsCols.some(c => c.name === 'has_chapters')) {
    db.exec('ALTER TABLE videos ADD COLUMN has_chapters INTEGER DEFAULT 0');
  }
  if (!vidsCols.some(c => c.name === 'chapters_json')) {
    db.exec("ALTER TABLE videos ADD COLUMN chapters_json TEXT DEFAULT '[]'");
  }

  const peopleCols = db.prepare('PRAGMA table_info(people)').all();
  if (!peopleCols.some(c => c.name === 'channel_id')) {
    db.exec('ALTER TABLE people ADD COLUMN channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER,
      content TEXT NOT NULL,
      image_path TEXT,
      is_edited INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );
  `);
  const cpCols = db.prepare('PRAGMA table_info(community_posts)').all();
  if (!cpCols.some(c => c.name === 'image_path')) {
    db.exec('ALTER TABLE community_posts ADD COLUMN image_path TEXT');
  }
  if (!cpCols.some(c => c.name === 'is_edited')) {
    db.exec('ALTER TABLE community_posts ADD COLUMN is_edited INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_subscriptions (
      user_id INTEGER NOT NULL,
      channel_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id, channel_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS channel_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      channel_id INTEGER,
      video_id INTEGER NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
    );
  `);

  // ── Seed admin user ───────────────────────────────────────────────────────
  // ── Seed welcome dialog ───────────────────────────────────────────────────
  const welcomeExists = db.prepare("SELECT id FROM dialogs WHERE id = 1").get();
  const welcomeBodyEn = [
    "Hey, welcome - glad you're here.",
    "",
    "This is a private personal archive of videos that used to live on YouTube. Here's why they don't anymore: YouTube rolled out AI-based content scanning that started flagging old private videos - videos that were totally fine when they were uploaded years ago but might not clear today's automated filters. Rather than wait around for a strike on something I had no control over, I mass-downloaded everything and pulled it all from YouTube before anything could happen.",
    "",
    "So now it all lives here, privately, where it belongs.",
    "",
    "**What you'll find:**",
    "- Regular videos and livestream recordings, dating back years",
    "- A browse page where you can filter by category, search by title, or sort however you like",
    "- A People section that lets you browse videos by who's in them",
    "- Watch progress is saved automatically - pick up where you left off",
    "- You can favorite videos to find them easily later",
    "- Comments work too, if you want to leave a note on something",
    "",
    "Everything here is private and only accessible to people who've been given an account. If something isn't working or you have questions, reach out directly.",
    "",
    "Enjoy the archive."
  ].join('\n');
  const welcomeBodyPl = [
    "Witaj - super, że tu jesteś.",
    "",
    "To prywatne archiwum filmów, które kiedyś były na YouTube. Dlaczego już ich tam nie ma: YouTube wdrożył automatyczne skanowanie treści przez AI i zaczął oznaczać stare prywatne materiały - nawet takie, które lata temu były całkowicie akceptowalne. Zamiast ryzykować ostrzeżenia lub blokady za coś, nad czym nie mam kontroli, hurtowo pobrałem wszystko i usunąłem te filmy z YouTube, zanim mogło dojść do problemów.",
    "",
    "Dlatego teraz wszystko jest tutaj - prywatnie i bezpiecznie.",
    "",
    "**Co tutaj znajdziesz:**",
    "- Zwykłe filmy i archiwalne transmisje na żywo z wielu lat",
    "- Przeglądanie z filtrowaniem po kategorii, wyszukiwaniem i sortowaniem",
    "- Sekcję Osoby, która pozwala przeglądać filmy po tym, kto w nich występuje",
    "- Automatyczny zapis postępu oglądania - możesz wrócić dokładnie tam, gdzie skończyłeś",
    "- Ulubione, żeby szybko wracać do wybranych materiałów",
    "- Komentarze, jeśli chcesz zostawić notatkę pod filmem",
    "",
    "Całość jest prywatna i dostępna tylko dla osób z kontem. Jeśli coś nie działa albo masz pytania, daj znać.",
    "",
    "Miłego oglądania archiwum."
  ].join('\n');
  if (!welcomeExists) {
    db.prepare(
      'INSERT INTO dialogs (id, title, body, title_pl, body_pl, created_by) VALUES (1, ?, ?, ?, ?, NULL)'
    ).run(
      'Welcome to Spool',
      'This is your new community tab. You can post updates and images here.',
      'Witamy w Spool',
      welcomeBodyPl
    );
  } else {
    db.prepare(
      `UPDATE dialogs
       SET title_pl = COALESCE(title_pl, ?),
           body_pl = COALESCE(body_pl, ?)
       WHERE id = 1`
    ).run('Witamy in Spool', welcomeBodyPl);
  }

  const existingAdmin = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!existingAdmin) {
    const adminUsername = process.env.ADMIN_USERNAME || 'mysticle';
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
      console.error('[DB] FATAL: ADMIN_PASSWORD environment variable is not set!');
      console.error('[DB] Set ADMIN_PASSWORD in your .env or docker-compose.yml before first run.');
      process.exit(1);
    }
    const hash = bcrypt.hashSync(adminPassword, 12);
    db.prepare(
      'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
    ).run(adminUsername, hash, 'Mysticle', 'admin');
    console.log(`[DB] Admin user created → username: ${adminUsername}`);
  }

  // ── Friends & Watch Party tables ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS friends (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      friend_id   INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','blocked')),
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, friend_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(friend_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends(user_id);
    CREATE INDEX IF NOT EXISTS idx_friends_friend_id ON friends(friend_id);

    CREATE TABLE IF NOT EXISTS watch_parties (
      id          TEXT PRIMARY KEY,
      host_id     INTEGER NOT NULL,
      video_id    INTEGER,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(host_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  console.log('[DB] Database initialised:', DB_PATH);
}

// ── Dialog queries ────────────────────────────────────────────────────────────
const getPendingDialogsForUser = (userId) =>
  db.prepare(
    `SELECT d.id, d.title, d.body, d.title_pl, d.body_pl, d.created_at
     FROM dialogs d
     WHERE NOT EXISTS (
       SELECT 1 FROM dialog_reads r
       WHERE r.dialog_id = d.id AND r.user_id = ?
     )
     ORDER BY d.id ASC`
  ).all(userId);

const markDialogRead = (userId, dialogId) =>
  db.prepare(
    'INSERT OR IGNORE INTO dialog_reads (user_id, dialog_id) VALUES (?, ?)'
  ).run(userId, dialogId);

const createDialog = (title, body, titlePl, bodyPl, createdById) =>
  db.prepare(
    'INSERT INTO dialogs (title, body, title_pl, body_pl, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(title, body, titlePl || null, bodyPl || null, createdById || null);

const getAllDialogs = () =>
  db.prepare(
    `SELECT d.id, d.title, d.body, d.title_pl, d.body_pl, d.created_at,
            u.display_name AS created_by_name,
            (SELECT COUNT(*) FROM dialog_reads r WHERE r.dialog_id = d.id) AS read_count
     FROM dialogs d
     LEFT JOIN users u ON u.id = d.created_by
     ORDER BY d.id ASC`
  ).all();

const deleteDialog = (id) =>
  db.prepare('DELETE FROM dialogs WHERE id = ?').run(id);

// ── Settings queries ─────────────────────────────────────────────────────────
const getChannelProfile = () => {
  const name = db.prepare("SELECT value FROM settings WHERE key = 'channel_name'").get()?.value || 'Mysticle Archive';
  const avatar = db.prepare("SELECT value FROM settings WHERE key = 'channel_avatar'").get()?.value || null;
  const banner = db.prepare("SELECT value FROM settings WHERE key = 'channel_banner'").get()?.value || null;
  const vhsPassword = db.prepare("SELECT value FROM settings WHERE key = 'channel_vhs_password'").get()?.value || null;
  return { channel_name: name, channel_avatar: avatar, channel_banner: banner, channel_vhs_password: vhsPassword };
};

const getSetting = (key, defaultValue = null) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : defaultValue;
};

const setSetting = (key, value) => {
  const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  stmt.run(key, value);
};

const updateChannelProfile = ({ channel_name, channel_avatar, channel_banner, channel_vhs_password }) => {
  const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  if (channel_name !== undefined) stmt.run('channel_name', channel_name);
  if (channel_avatar !== undefined) stmt.run('channel_avatar', channel_avatar);
  if (channel_banner !== undefined) stmt.run('channel_banner', channel_banner);
  if (channel_vhs_password !== undefined) stmt.run('channel_vhs_password', channel_vhs_password);
};

// ── Audit log queries ────────────────────────────────────────────────────────
const createAuditLog = ({ userId = null, action, details = null, ipAddress = null, userAgent = null } = {}) =>
  db.prepare(
    'INSERT INTO audit_logs (user_id, action, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).run(
    userId || null,
    String(action || ''),
    details == null ? null : String(details),
    ipAddress == null ? null : String(ipAddress),
    userAgent == null ? null : String(userAgent)
  );

const getRecentAuditLogs = (limit = 200) =>
  db.prepare(
    `SELECT l.id, l.user_id, l.action, l.details, l.ip_address, l.user_agent, l.created_at,
            u.username, u.display_name
     FROM audit_logs l
     LEFT JOIN users u ON u.id = l.user_id
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT ?`
  ).all(Math.max(1, Math.min(Number(limit) || 200, 1000)));

// ── User queries ──────────────────────────────────────────────────────────────
const getUserByUsername = (username) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(username);

const getUserById = (id) =>
  db.prepare('SELECT id, username, display_name, avatar_path, role, created_at, last_login, can_upload, can_download, volume FROM users WHERE id = ?').get(id);

const getAllUsers = () =>
  db.prepare('SELECT id, username, display_name, avatar_path, role, created_at, last_login, can_upload, can_download, volume FROM users ORDER BY created_at ASC').all();

const createUser = (username, passwordHash, displayName, role = 'viewer') =>
  db.prepare(
    'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
  ).run(username, passwordHash, displayName || username, role);

const updateUser = (id, fields) => {
  const allowed = ['display_name', 'role', 'password_hash', 'avatar_path', 'twofa_secret', 'twofa_enabled', 'can_upload', 'can_download', 'volume'];
  const sets = Object.keys(fields)
    .filter((k) => allowed.includes(k))
    .map((k) => `${k} = ?`)
    .join(', ');
  if (!sets) return;
  const values = Object.keys(fields)
    .filter((k) => allowed.includes(k))
    .map((k) => fields[k]);
  return db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...values, id);
};

const deleteUser = (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id);

const touchLastLogin = (id) =>
  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(id);

const getUserAvatarPathById = (id) =>
  db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(id)?.avatar_path || null;

// ── Channel queries ───────────────────────────────────────────────────────────
const getChannelByUserId = (userId) =>
  db.prepare('SELECT * FROM channels WHERE user_id = ?').get(userId);

const getChannelById = (id) =>
  db.prepare('SELECT * FROM channels WHERE id = ?').get(id);

const getAllChannels = () =>
  db.prepare('SELECT * FROM channels ORDER BY name ASC').all();

const createChannel = (userId, name, avatarPath = null) => {
  const res = db.prepare(
    'INSERT INTO channels (user_id, name, avatar_path) VALUES (?, ?, ?)'
  ).run(userId, name, avatarPath);
  return getChannelById(res.lastInsertRowid);
};

const updateChannel = (id, fields) => {
  const allowed = ['name', 'avatar_path', 'banner_path', 'vhs_password'];
  const sets = Object.keys(fields)
    .filter((k) => allowed.includes(k))
    .map((k) => `${k} = ?`)
    .join(', ');
  if (!sets) return;
  const values = Object.keys(fields)
    .filter((k) => allowed.includes(k))
    .map((k) => fields[k]);
  
  db.prepare(`UPDATE channels SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, id);
  return getChannelById(id);
};

// ── Video queries ─────────────────────────────────────────────────────────────
const getVideoById = (id) =>
  db.prepare(`
    SELECT v.*, 
           CASE WHEN v.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_name') ELSE c.name END AS channel_name, 
           CASE WHEN v.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_avatar') ELSE c.avatar_path END AS channel_avatar_path 
    FROM videos v 
    LEFT JOIN channels c ON c.id = v.channel_id 
    WHERE v.id = ?
  `).get(id);

const getVideoByPath = (filepath) =>
  db.prepare(`
    SELECT v.*, 
           CASE WHEN v.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_name') ELSE c.name END AS channel_name, 
           CASE WHEN v.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_avatar') ELSE c.avatar_path END AS channel_avatar_path 
    FROM videos v 
    LEFT JOIN channels c ON c.id = v.channel_id 
    WHERE v.filepath = ?
  `).get(filepath);

const getAllVideos = ({ category, search, page = 1, limit = 40, sort = 'title_asc', userId = null, isAdmin = false, personId = null, channelId = null, includeVhs = false, unlockedVhsChannels = [] } = {}) => {
  let where = [];
  let params = [];

  if (!includeVhs) {
    where.push('v.is_vhs = 0');
  } else if (!isAdmin) {
    if (unlockedVhsChannels && unlockedVhsChannels.length > 0) {
      const numericIds = unlockedVhsChannels.filter(id => id !== 'main').map(id => parseInt(id, 10)).filter(id => !isNaN(id));
      const hasMain = unlockedVhsChannels.includes('main');
      
      let vhsConds = [];
      if (numericIds.length > 0) {
         const qs = numericIds.map(() => '?').join(',');
         vhsConds.push(`v.channel_id IN (${qs})`);
         params.push(...numericIds);
      }
      if (hasMain) {
         vhsConds.push('v.channel_id IS NULL');
      }
      
      if (vhsConds.length > 0) {
        where.push(`(v.is_vhs = 0 OR (v.is_vhs = 1 AND (${vhsConds.join(' OR ')})))`);
      } else {
        where.push('v.is_vhs = 0');
      }
    } else {
      where.push('v.is_vhs = 0');
    }
  }

  if (category && category !== 'all') {
    where.push('v.category = ?');
    params.push(category);
  }
  if (search) {
    where.push('(v.title LIKE ? OR v.description LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term);
  }
  if (personId !== null && personId !== undefined) {
    where.push(`(
      EXISTS (SELECT 1 FROM video_people vp WHERE vp.video_id = v.id AND vp.person_id = ?)
      OR EXISTS (SELECT 1 FROM video_people_auto vpa WHERE vpa.video_id = v.id AND vpa.person_id = ?)
    )`);
    params.push(personId, personId);
  }
  if (channelId !== null && channelId !== undefined) {
    if (channelId === 'main') {
      where.push('v.channel_id IS NULL');
    } else {
      where.push('v.channel_id = ?');
      params.push(channelId);
    }
  }

  // Access control: non-admins only see videos they have access to
  if (!isAdmin && userId !== null) {
    where.push(`(
      EXISTS (SELECT 1 FROM video_access_all vaa WHERE vaa.video_id = v.id)
      OR EXISTS (SELECT 1 FROM video_access_users vau WHERE vau.video_id = v.id AND vau.user_id = ?)
      OR EXISTS (
        SELECT 1 FROM video_people vp2
        JOIN people p2 ON p2.id = vp2.person_id
        WHERE vp2.video_id = v.id AND p2.user_id = ?
      )
      OR EXISTS (
        SELECT 1 FROM video_people_auto vpa2
        JOIN people p2 ON p2.id = vpa2.person_id
        WHERE vpa2.video_id = v.id AND p2.user_id = ?
      )
      OR EXISTS (
        SELECT 1 FROM channels c
        WHERE c.id = v.channel_id AND c.user_id = ?
      )
    )`);
    params.push(userId, userId, userId, userId);
  } else if (!isAdmin) {
    // No userId provided — show nothing
    where.push('1 = 0');
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (Math.max(1, page) - 1) * limit;

  const effectiveDateExpr = `COALESCE(v.content_date, v.file_created_at, v.scanned_at)`;

  const isPeopleSort = sort === 'people_asc' || sort === 'people_desc';
  const joinClause = isPeopleSort
    ? `LEFT JOIN (
         SELECT video_id, MIN(p.name) as first_person_name
         FROM (
           SELECT video_id, person_id FROM video_people
           UNION
           SELECT video_id, person_id FROM video_people_auto
         ) tagged
         JOIN people p ON p.id = tagged.person_id
         GROUP BY video_id
       ) vp_sort ON vp_sort.video_id = v.id`
    : '';

  const sortMap = {
    title_asc: 'v.title ASC',
    title_desc: 'v.title DESC',
    name_asc: 'v.title ASC',
    name_desc: 'v.title DESC',
    people_asc: `COALESCE(vp_sort.first_person_name, '') COLLATE NOCASE ASC, v.title COLLATE NOCASE ASC`,
    people_desc: `COALESCE(vp_sort.first_person_name, '') COLLATE NOCASE DESC, v.title COLLATE NOCASE ASC`,
    oldest: `${effectiveDateExpr} ASC, v.title ASC`,
    newest: `${effectiveDateExpr} DESC, v.title ASC`,
  };
  const orderBy = sortMap[sort] || sortMap.title_asc;

  const rows = db
    .prepare(
      `SELECT v.id, v.filename, v.filepath, v.title, v.original_title, v.description, v.category, v.content_date, v.file_created_at,
              v.duration, v.file_size, v.thumbnail_path, v.video_width, v.video_height, v.view_count, v.scanned_at, v.channel_id, v.is_vhs, v.vhs_start_date, v.vhs_end_date, v.has_chapters, v.chapters_json,
              CASE WHEN v.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_name') ELSE c.name END AS channel_name, 
              CASE WHEN v.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_avatar') ELSE c.avatar_path END AS channel_avatar_path
       FROM videos v 
       LEFT JOIN channels c ON c.id = v.channel_id
       ${joinClause} ${whereClause}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM videos v ${whereClause}`)
    .get(...params).count;

  return { videos: rows, total, page: Number(page), limit, pages: Math.ceil(total / limit) };
};

const upsertVideo = (data) => {
  const parsed = parseEmbeddedVideoDateAndTitle(data.title, data.file_created_at);
  const normalizedTitle = parsed.title;
  const normalizedContentDate = data.force_content_date || parsed.contentDateIso;
  const existing = getVideoByPath(data.filepath);
  if (existing) {
    // Only update technical metadata; preserve custom title/description/category
    const result = db
      .prepare(
        `UPDATE videos
         SET filename = ?, file_size = ?, duration = ?, file_created_at = COALESCE(file_created_at, ?),
             content_date = COALESCE(content_date, ?),
             thumbnail_path = COALESCE(?, thumbnail_path),
             video_width = COALESCE(?, video_width), video_height = COALESCE(?, video_height),
             channel_id = COALESCE(?, channel_id),
             is_vhs = COALESCE(?, is_vhs),
             vhs_start_date = COALESCE(?, vhs_start_date),
             vhs_end_date = COALESCE(?, vhs_end_date),
             has_chapters = COALESCE(?, has_chapters),
             chapters_json = COALESCE(?, chapters_json),
             scanned_at = CURRENT_TIMESTAMP
         WHERE filepath = ?`
      )
      .run(
        data.filename,
        data.file_size,
        data.duration,
        normalizedContentDate || data.file_created_at || null,
        normalizedContentDate || null,
        data.thumbnail_path || null,
        data.video_width || 0,
        data.video_height || 0,
        data.channel_id || null,
        data.is_vhs !== undefined ? data.is_vhs : null,
        data.vhs_start_date !== undefined ? data.vhs_start_date : null,
        data.vhs_end_date !== undefined ? data.vhs_end_date : null,
        data.has_chapters !== undefined ? data.has_chapters : null,
        data.chapters_json !== undefined ? data.chapters_json : null,
        data.filepath
      );
    syncAutoTaggedPeopleForVideo(existing.id, existing.title);
    return result;
  }
  const result = db
    .prepare(
      `INSERT INTO videos (filename, filepath, title, original_title, description, category, content_date, file_created_at, duration, file_size, thumbnail_path, video_width, video_height, channel_id, is_vhs, vhs_start_date, vhs_end_date, has_chapters, chapters_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.filename,
      data.filepath,
      normalizedTitle,
      data.title,
      data.description || '',
      data.category,
      normalizedContentDate,
      normalizedContentDate || data.file_created_at || null,
      data.duration || 0,
      data.file_size || 0,
      data.thumbnail_path || null,
      data.video_width || 0,
      data.video_height || 0,
      data.channel_id || null,
      data.is_vhs || 0,
      data.vhs_start_date || null,
      data.vhs_end_date || null,
      data.has_chapters || 0,
      data.chapters_json || '[]'
    );
  const inserted = getVideoByPath(data.filepath);
  if (inserted) syncAutoTaggedPeopleForVideo(inserted.id, inserted.title);
  return result;
};

const updateVideoMeta = (id, { title, description, category, location, is_vhs, vhs_start_date, vhs_end_date, has_chapters, chapters_json, content_date }) => {
  const current = getVideoById(id);
  if (!current) return null;

  const sets = [];
  const vals = [];

  if (title !== undefined && title !== null) {
    sets.push('title = ?');
    vals.push(String(title).trim());
    
    // Only auto-parse date from title if content_date was NOT explicitly provided
    if (content_date === undefined) {
      const parsed = parseEmbeddedVideoDateAndTitle(title, current?.file_created_at || current?.scanned_at);
      if (parsed.contentDateIso) {
        sets.push('content_date = ?');
        vals.push(parsed.contentDateIso);
      }
      if (parsed.title && parsed.title !== title) {
        sets.push('original_title = ?');
        vals.push(parsed.title);
      }
    }
  }

  if (content_date !== undefined) {
    sets.push('content_date = ?');
    vals.push(content_date ? String(content_date).trim() : null);
  }

  if (location !== undefined) {
    sets.push('location = ?');
    vals.push(location !== null ? String(location).trim() : null);
  }

  if (description !== undefined && description !== null) {
    sets.push('description = ?');
    vals.push(String(description).trim());
  }

  if (category !== undefined && category !== null && ['video', 'livestream'].includes(category)) {
    sets.push('category = ?');
    vals.push(category);
  }

  if (is_vhs !== undefined && is_vhs !== null) {
    sets.push('is_vhs = ?');
    vals.push(is_vhs ? 1 : 0);
  }

  if (vhs_start_date !== undefined) {
    sets.push('vhs_start_date = ?');
    vals.push(vhs_start_date);
  }

  if (vhs_end_date !== undefined) {
    sets.push('vhs_end_date = ?');
    vals.push(vhs_end_date);
  }

  if (has_chapters !== undefined) {
    sets.push('has_chapters = ?');
    vals.push(has_chapters ? 1 : 0);
  }

  if (chapters_json !== undefined) {
    sets.push('chapters_json = ?');
    vals.push(chapters_json);
  }

  if (sets.length > 0) {
    sets.push('updated_at = CURRENT_TIMESTAMP');
    db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (e) {}
  }
  
  if (current) syncAutoTaggedPeopleForVideo(id, String(title || current.title).trim());
  
  return getVideoById(id);
};

const updateVideoFilepath = (id, filename, filepath, file_size) => {
  db.prepare(`UPDATE videos SET filename = ?, filepath = ?, file_size = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(filename, filepath, file_size, id);
};

const setVideoThumbnail = (id, thumbnailPath) =>
  db
    .prepare(
      `UPDATE videos
       SET thumbnail_path = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .run(thumbnailPath, id);

const incrementViewCount = (id) =>
  db.prepare('UPDATE videos SET view_count = view_count + 1 WHERE id = ?').run(id);

const removeStaleVideos = (livePaths) => {
  if (!livePaths.length) return;
  const placeholders = livePaths.map(() => '?').join(', ');
  const staleCandidates = db.prepare(`SELECT id, filepath FROM videos WHERE filepath NOT IN (${placeholders})`).all(...livePaths);
  const toDelete = staleCandidates.filter(c => !fs.existsSync(c.filepath)).map(c => c.id);
  
  if (toDelete.length > 0) {
    const delPlaceholders = toDelete.map(() => '?').join(', ');
    db.prepare(`DELETE FROM videos WHERE id IN (${delPlaceholders})`).run(...toDelete);
  }
};

const getCommentsByVideoId = (videoId, viewerUserId = null) =>
  db
    .prepare(
      `SELECT c.id, c.video_id, c.user_id, c.parent_comment_id, c.content, c.gif_url, c.created_at, c.updated_at,
              u.username, u.display_name, u.avatar_path,
              COUNT(DISTINCT cl.user_id) AS like_count,
              COUNT(DISTINCT ch.user_id) AS heart_count,
              (COUNT(DISTINCT cl.user_id) + COUNT(DISTINCT ch.user_id)) AS reaction_total,
              MAX(CASE WHEN cl.user_id = ? THEN 1 ELSE 0 END) AS viewer_liked,
              MAX(CASE WHEN ch.user_id = ? THEN 1 ELSE 0 END) AS viewer_hearted
       FROM comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN comment_likes cl ON cl.comment_id = c.id
       LEFT JOIN comment_hearts ch ON ch.comment_id = c.id
       WHERE c.video_id = ?
       GROUP BY c.id, c.video_id, c.user_id, c.parent_comment_id, c.content, c.gif_url, c.created_at, c.updated_at,
                u.username, u.display_name, u.avatar_path
       ORDER BY c.created_at ASC`
    )
    .all(viewerUserId || -1, viewerUserId || -1, videoId);

const addComment = (videoId, userId, content, parentCommentId = null, gifUrl = null) =>
  db
    .prepare('INSERT INTO comments (video_id, user_id, content, parent_comment_id, gif_url) VALUES (?, ?, ?, ?, ?)')
    .run(videoId, userId, content, parentCommentId, gifUrl);

const getCommentById = (id) =>
  db.prepare('SELECT * FROM comments WHERE id = ?').get(id);

const updateComment = (id, content) =>
  db
    .prepare('UPDATE comments SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(content, id);

const deleteComment = (id) => db.prepare('DELETE FROM comments WHERE id = ?').run(id);

const getCommentReaction = (commentId, userId) =>
  db
    .prepare('SELECT reaction_type FROM comment_reactions WHERE comment_id = ? AND user_id = ?')
    .get(commentId, userId);

const upsertCommentReaction = (commentId, userId, reactionType) =>
  db
    .prepare(
      `INSERT INTO comment_reactions (comment_id, user_id, reaction_type)
       VALUES (?, ?, ?)
       ON CONFLICT(comment_id, user_id) DO UPDATE SET
         reaction_type = excluded.reaction_type,
         created_at = CURRENT_TIMESTAMP`
    )
    .run(commentId, userId, reactionType);

const deleteCommentReaction = (commentId, userId) =>
  db
    .prepare('DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ?')
    .run(commentId, userId);

const hasCommentLike = (commentId, userId) =>
  Boolean(db.prepare('SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_id = ?').get(commentId, userId));

const addCommentLike = (commentId, userId) =>
  db.prepare('INSERT OR IGNORE INTO comment_likes (comment_id, user_id) VALUES (?, ?)').run(commentId, userId);

const removeCommentLike = (commentId, userId) =>
  db.prepare('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?').run(commentId, userId);

const hasCommentHeart = (commentId, userId) =>
  Boolean(db.prepare('SELECT 1 FROM comment_hearts WHERE comment_id = ? AND user_id = ?').get(commentId, userId));

const addCommentHeart = (commentId, userId) =>
  db.prepare('INSERT OR IGNORE INTO comment_hearts (comment_id, user_id) VALUES (?, ?)').run(commentId, userId);

const removeCommentHeart = (commentId, userId) =>
  db.prepare('DELETE FROM comment_hearts WHERE comment_id = ? AND user_id = ?').run(commentId, userId);

// ── Notification queries ─────────────────────────────────────────────────────
const getNotifications = (userId, limit = 20) => {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  return db.prepare(`
    SELECT c.id, c.video_id, c.user_id, c.content, c.created_at AS created_at,
           u.display_name, u.username, u.avatar_path, v.title AS video_title,
           CASE WHEN cr.user_id IS NULL THEN 0 ELSE 1 END AS is_read,
           CASE WHEN pc.user_id = ? THEN 1 ELSE 0 END AS is_reply_to_me,
           'comment' AS type
    FROM comments c
    JOIN users u ON u.id = c.user_id
    JOIN videos v ON v.id = c.video_id
    LEFT JOIN comments pc ON c.parent_comment_id = pc.id
    LEFT JOIN comment_reads cr ON cr.comment_id = c.id AND cr.user_id = ?
    WHERE c.user_id != ?
      AND (
        EXISTS (SELECT 1 FROM video_access_all vaa WHERE vaa.video_id = v.id)
        OR EXISTS (SELECT 1 FROM video_access_users vau WHERE vau.video_id = v.id AND vau.user_id = ?)
        OR EXISTS (
          SELECT 1 FROM video_people vp
          JOIN people p ON p.id = vp.person_id
          WHERE vp.video_id = v.id AND p.user_id = ?
        )
        OR EXISTS (
          SELECT 1 FROM video_people_auto vpa
          JOIN people p ON p.id = vpa.person_id
          WHERE vpa.video_id = v.id AND p.user_id = ?
        )
      )
    UNION ALL
    SELECT cn.id, cn.video_id, IFNULL(cn.channel_id, 0) as user_id, 'New upload' as content, cn.created_at AS created_at,
           CASE WHEN cn.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_name') ELSE ch.name END as display_name,
           'channel' as username,
           CASE WHEN cn.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_avatar') ELSE ch.avatar_path END as avatar_path,
           v.title AS video_title,
           cn.is_read AS is_read,
           0 AS is_reply_to_me,
           'channel_upload' AS type
    FROM channel_notifications cn
    JOIN videos v ON v.id = cn.video_id
    LEFT JOIN channels ch ON ch.id = cn.channel_id
    WHERE cn.user_id = ?
    UNION ALL
    SELECT f.id, 0 AS video_id, f.user_id, 'Friend request' AS content, f.created_at AS created_at,
           u2.display_name, u2.username, u2.avatar_path, '' AS video_title,
           0 AS is_read,
           0 AS is_reply_to_me,
           'friend_request' AS type
    FROM friends f
    JOIN users u2 ON u2.id = f.user_id
    WHERE f.friend_id = ? AND f.status = 'pending'
    ORDER BY 5 DESC
    LIMIT ?
  `).all(userId, userId, userId, userId, userId, userId, userId, userId, safeLimit);
};

const markNotificationRead = (userId, id, type = 'comment') => {
  const safeId = Number(id);
  if (!Number.isInteger(safeId) || safeId <= 0) return;
  if (type === 'channel_upload') {
    db.prepare(`UPDATE channel_notifications SET is_read = 1 WHERE id = ? AND user_id = ?`).run(safeId, userId);
  } else {
    db.prepare(`
      INSERT OR IGNORE INTO comment_reads (user_id, comment_id) VALUES (?, ?)
    `).run(userId, safeId);
  }
};

// ── Progress queries ────────────────────────────────────────────────────────
const upsertProgress = (userId, videoId, position) =>
  db
    .prepare(
      `INSERT INTO video_progress (user_id, video_id, position, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, video_id) DO UPDATE SET
         position = excluded.position,
         updated_at = CURRENT_TIMESTAMP`
    )
    .run(userId, videoId, position);

const getProgress = (userId, videoId) =>
  db
    .prepare('SELECT position FROM video_progress WHERE user_id = ? AND video_id = ?')
    .get(userId, videoId);

const getAllProgressForUser = (userId) =>
  db
    .prepare(
      `SELECT vp.video_id, vp.position AS last_position, v.duration
       FROM video_progress vp
       JOIN videos v ON v.id = vp.video_id
       WHERE vp.user_id = ?`
    )
    .all(userId);

const getWatchHistory = (userId, limit = 40) =>
  db
    .prepare(
      `SELECT v.id, v.title, v.filename, v.category, v.duration, v.file_size,
              v.thumbnail_path, v.view_count, v.content_date, v.file_created_at, v.scanned_at,
              vp.position AS last_position, vp.updated_at AS watched_at,
              CASE WHEN v.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_name') ELSE c.name END AS channel_name, 
              CASE WHEN v.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_avatar') ELSE c.avatar_path END AS channel_avatar_path
       FROM video_progress vp
       JOIN videos v ON v.id = vp.video_id
       LEFT JOIN channels c ON c.id = v.channel_id
       WHERE vp.user_id = ?
       ORDER BY vp.updated_at DESC
       LIMIT ?`
    )
    .all(userId, limit);

const addFavorite = (userId, videoId) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO user_favorites (user_id, video_id)
       VALUES (?, ?)`
    )
    .run(userId, videoId);

const removeFavorite = (userId, videoId) =>
  db
    .prepare('DELETE FROM user_favorites WHERE user_id = ? AND video_id = ?')
    .run(userId, videoId);

const getFavoriteVideoIds = (userId) =>
  db
    .prepare(
      `SELECT video_id
       FROM user_favorites
       WHERE user_id = ?`
    )
    .all(userId)
    .map((row) => row.video_id);

// ── People queries ───────────────────────────────────────────────────────────
const createPerson = (name, bio = '', titleTags = '', channel_id = null, second_name = '', surname = '') =>
  db.prepare('INSERT INTO people (name, bio, title_tags, channel_id, second_name, surname) VALUES (?, ?, ?, ?, ?, ?)').run(name, bio, titleTags, channel_id, second_name, surname);

const updatePerson = (id, fields) => {
  const allowed = ['name', 'bio', 'title_tags', 'channel_id', 'second_name', 'surname'];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k)).map((k) => `${k} = ?`);
  if (!sets.length) return;
  const vals = Object.keys(fields).filter((k) => allowed.includes(k)).map((k) => fields[k]);
  return db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
};

const deletePerson = (id) => {
  db.prepare('DELETE FROM person_vhs_photos WHERE person_id = ?').run(id);
  return db.prepare('DELETE FROM people WHERE id = ?').run(id);
};

const getAllPeople = ({ userId = null, isAdmin = true } = {}) =>
  db
    .prepare(
      `SELECT * FROM (
        SELECT p.id, p.name, p.second_name, p.surname, p.bio, p.title_tags, p.image_path, p.user_id, p.channel_id, p.created_at,
               u.username, u.display_name AS linked_display_name,
               COALESCE((
                 SELECT COUNT(*)
                 FROM (
                   SELECT vp.video_id
                   FROM video_people vp
                   WHERE vp.person_id = p.id
                   UNION
                   SELECT vpa.video_id
                   FROM video_people_auto vpa
                   WHERE vpa.person_id = p.id
                 ) tagged_videos
                 JOIN videos v ON v.id = tagged_videos.video_id
                   AND (
                     ? = 1
                     OR EXISTS (SELECT 1 FROM video_access_all vaa WHERE vaa.video_id = tagged_videos.video_id)
                     OR EXISTS (SELECT 1 FROM video_access_users vau WHERE vau.video_id = tagged_videos.video_id AND vau.user_id = ?)
                     OR EXISTS (
                       SELECT 1
                       FROM video_people vp2
                       JOIN people p2 ON p2.id = vp2.person_id
                       WHERE vp2.video_id = tagged_videos.video_id AND p2.user_id = ?
                     )
                     OR EXISTS (
                       SELECT 1 FROM channels c
                       WHERE c.id = v.channel_id AND c.user_id = ?
                     )
                   )
               ), 0) AS video_count
        FROM people p
        LEFT JOIN users u ON u.id = p.user_id
      ) sub
      WHERE sub.video_count > 0 OR ? = 1
      ORDER BY sub.name ASC`
    )
    .all(isAdmin ? 1 : 0, userId, userId, userId, isAdmin ? 1 : 0);

const getPersonById = (id) =>
  db.prepare('SELECT * FROM people WHERE id = ?').get(id);

const setPersonImage = (id, filename) =>
  db.prepare('UPDATE people SET image_path = ? WHERE id = ?').run(filename || null, id);

const setPersonUserLink = (personId, userId) =>
  db.prepare('UPDATE people SET user_id = ? WHERE id = ?').run(userId, personId);

const syncAutoTaggedPeopleForVideo = (videoId, title) => {
  const autoPeople = getPeopleWithTitleTags().filter((person) => titleMatchesAnyTag(title, person.title_tags));
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM video_people_auto WHERE video_id = ?').run(videoId);
    const stmt = db.prepare('INSERT OR IGNORE INTO video_people_auto (video_id, person_id) VALUES (?, ?)');
    for (const person of autoPeople) stmt.run(videoId, person.id);
  });
  tx();
};

const syncAutoTaggedPeopleForPerson = (personId) => {
  const person = getPersonById(personId);
  if (!person) return;
  const tags = splitTitleTags(person.title_tags);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM video_people_auto WHERE person_id = ?').run(personId);
    if (!tags.length) return;
    const stmt = db.prepare('INSERT OR IGNORE INTO video_people_auto (video_id, person_id) VALUES (?, ?)');
    const videos = db.prepare('SELECT id, title FROM videos').all();
    for (const video of videos) {
      if (titleMatchesAnyTag(video.title, tags.join(','))) {
        stmt.run(video.id, personId);
      }
    }
  });
  tx();
};

// ── Video people queries ──────────────────────────────────────────────────────
// ── Person VHS era photos ─────────────────────────────────────────────────────
/** Convert YYYY / YYYY-MM / YYYY-MM-DD / ISO into sortable YYYYMMDD number, or null. */
function dateToSortKey(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number' && Number.isFinite(val)) {
    if (val >= 1900 && val <= 2100 && Number.isInteger(val)) return val * 10000 + 101; // mid-ish year Jan 1
    return null;
  }
  const s = String(val).trim();
  if (/^\d{4}$/.test(s)) {
    const y = Number(s);
    if (y < 1900 || y > 2100) return null;
    return y * 10000 + 701; // mid-year for year-only
  }
  const m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = m[3] ? Number(m[3]) : 15;
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12) return null;
  return y * 10000 + mo * 100 + Math.min(Math.max(d, 1), 28);
}

function resolveVideoEraSortKey(video) {
  if (!video) return null;
  const startKey = dateToSortKey(video.vhs_start_date);
  const endKey = dateToSortKey(video.vhs_end_date);
  if (startKey && endKey) return Math.floor((startKey + endKey) / 2);
  if (startKey) return startKey;
  if (endKey) return endKey;
  const contentKey = dateToSortKey(video.content_date);
  if (contentKey) return contentKey;
  return dateToSortKey(video.file_created_at || video.scanned_at);
}

const getPersonVhsPhotos = (personId) =>
  db
    .prepare(
      `SELECT id, person_id, image_path, effective_date, label, created_at
       FROM person_vhs_photos
       WHERE person_id = ?
       ORDER BY
         CASE WHEN effective_date IS NULL OR effective_date = '' THEN 1 ELSE 0 END,
         effective_date ASC,
         id ASC`
    )
    .all(personId);

const getPersonVhsPhotoById = (photoId) =>
  db.prepare('SELECT * FROM person_vhs_photos WHERE id = ?').get(photoId);

const addPersonVhsPhoto = (personId, imagePath, effectiveDate = null, label = '') => {
  const result = db
    .prepare(
      `INSERT INTO person_vhs_photos (person_id, image_path, effective_date, label)
       VALUES (?, ?, ?, ?)`
    )
    .run(personId, imagePath, effectiveDate || null, label || '');
  return getPersonVhsPhotoById(result.lastInsertRowid);
};

const updatePersonVhsPhoto = (photoId, fields = {}) => {
  const allowed = ['effective_date', 'label', 'image_path'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!sets.length) return getPersonVhsPhotoById(photoId);
  vals.push(photoId);
  db.prepare(`UPDATE person_vhs_photos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getPersonVhsPhotoById(photoId);
};

const deletePersonVhsPhoto = (photoId) =>
  db.prepare('DELETE FROM person_vhs_photos WHERE id = ?').run(photoId);

const deletePersonVhsPhotosForPerson = (personId) =>
  db.prepare('DELETE FROM person_vhs_photos WHERE person_id = ?').run(personId);

/**
 * Pick the best VHS era photo for a person at a given video era date.
 * Prefers the latest photo with effective_date <= video date; otherwise undated
 * fallback photos; otherwise the closest dated photo.
 */
function pickBestVhsPhoto(photos, videoSortKey) {
  if (!photos || !photos.length) return null;
  if (!videoSortKey) {
    // Prefer undated default, else first
    return photos.find((p) => !p.effective_date) || photos[0];
  }

  const dated = [];
  const undated = [];
  for (const p of photos) {
    const key = dateToSortKey(p.effective_date);
    if (key == null) undated.push(p);
    else dated.push({ photo: p, key });
  }

  const beforeOrOn = dated.filter((d) => d.key <= videoSortKey).sort((a, b) => b.key - a.key);
  if (beforeOrOn.length) return beforeOrOn[0].photo;
  if (undated.length) return undated[0];
  if (dated.length) {
    dated.sort((a, b) => Math.abs(a.key - videoSortKey) - Math.abs(b.key - videoSortKey));
    return dated[0].photo;
  }
  return null;
}

const getVideoPeople = (videoId) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT p.id, p.name, p.second_name, p.surname, p.bio, p.title_tags, p.image_path, p.user_id,
              u.username, u.display_name AS linked_display_name
       FROM video_people vp
       JOIN people p ON p.id = vp.person_id
       LEFT JOIN users u ON u.id = p.user_id
       WHERE vp.video_id = ?
       UNION
       SELECT DISTINCT p.id, p.name, p.second_name, p.surname, p.bio, p.title_tags, p.image_path, p.user_id,
              u.username, u.display_name AS linked_display_name
       FROM video_people_auto vpa
       JOIN people p ON p.id = vpa.person_id
       LEFT JOIN users u ON u.id = p.user_id
       WHERE vpa.video_id = ?
       ORDER BY p.name ASC`
    )
    .all(videoId, videoId);

  const video = getVideoById(videoId);
  if (!video || !video.is_vhs) return rows;

  const eraKey = resolveVideoEraSortKey(video);
  return rows.map((person) => {
    const photos = getPersonVhsPhotos(person.id);
    const best = pickBestVhsPhoto(photos, eraKey);
    if (!best) return person;
    return {
      ...person,
      vhs_photo_id: best.id,
      vhs_photo_date: best.effective_date || null,
    };
  });
};


const setVideoPeople = (videoId, personIds) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM video_people WHERE video_id = ?').run(videoId);
    const stmt = db.prepare('INSERT OR IGNORE INTO video_people (video_id, person_id) VALUES (?, ?)');
    for (const pid of personIds) stmt.run(videoId, pid);
  });
  tx();
};

// ── Video access queries ──────────────────────────────────────────────────────
const getVideoAccess = (videoId) => {
  const allAccess = db.prepare('SELECT 1 FROM video_access_all WHERE video_id = ?').get(videoId);
  const userRows = db.prepare('SELECT user_id FROM video_access_users WHERE video_id = ?').all(videoId);
  return {
    all_users: Boolean(allAccess),
    user_ids: userRows.map((r) => r.user_id),
  };
};

const setVideoAccess = (videoId, { all_users, user_ids = [] }) => {
  const tx = db.transaction(() => {
    if (all_users) {
      db.prepare('INSERT OR IGNORE INTO video_access_all (video_id) VALUES (?)').run(videoId);
    } else {
      db.prepare('DELETE FROM video_access_all WHERE video_id = ?').run(videoId);
    }
    db.prepare('DELETE FROM video_access_users WHERE video_id = ?').run(videoId);
    const stmt = db.prepare('INSERT OR IGNORE INTO video_access_users (video_id, user_id) VALUES (?, ?)');
    for (const uid of user_ids) stmt.run(videoId, uid);
  });
  tx();
};

const canUserAccessVideo = (videoId, userId) => {
  if (db.prepare('SELECT 1 FROM video_access_all WHERE video_id = ?').get(videoId)) return true;
  if (db.prepare('SELECT 1 FROM video_access_users WHERE video_id = ? AND user_id = ?').get(videoId, userId)) return true;
  if (db.prepare(
    `SELECT 1 FROM video_people vp
     JOIN people p ON p.id = vp.person_id
     WHERE vp.video_id = ? AND p.user_id = ?`
  ).get(videoId, userId)) return true;
  if (db.prepare(
    `SELECT 1 FROM video_people_auto vpa
     JOIN people p ON p.id = vpa.person_id
     WHERE vpa.video_id = ? AND p.user_id = ?`
  ).get(videoId, userId)) return true;
  if (db.prepare(
    `SELECT 1 FROM videos v
     JOIN channels c ON c.id = v.channel_id
     WHERE v.id = ? AND c.user_id = ?`
  ).get(videoId, userId)) return true;
  return false;
};

// ── Series queries ────────────────────────────────────────────────────────────
const createSeries = ({ name, description = '', createdBy = null }) =>
  db
    .prepare('INSERT INTO series (name, description, created_by) VALUES (?, ?, ?)')
    .run(name, description, createdBy);

const updateSeries = (id, { name, description }) => {
  const sets = [];
  const values = [];
  if (name !== undefined) {
    sets.push('name = ?');
    values.push(name);
  }
  if (description !== undefined) {
    sets.push('description = ?');
    values.push(description);
  }
  if (!sets.length) return;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  return db.prepare(`UPDATE series SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
};

const deleteSeries = (id) =>
  db.prepare('DELETE FROM series WHERE id = ?').run(id);

const getSeriesById = (id) =>
  db
    .prepare(
      `SELECT s.id, s.name, s.description, s.created_by, s.created_at, s.updated_at,
              u.username AS created_by_username,
              u.display_name AS created_by_display_name
       FROM series s
       LEFT JOIN users u ON u.id = s.created_by
       WHERE s.id = ?`
    )
    .get(id);

const canUserAccessSeries = (seriesId, userId) => {
  if (db.prepare('SELECT 1 FROM series_access_all WHERE series_id = ?').get(seriesId)) return true;
  if (db.prepare('SELECT 1 FROM series_access_users WHERE series_id = ? AND user_id = ?').get(seriesId, userId)) return true;
  return false;
};

const getSeriesAccess = (seriesId) => {
  const allAccess = db.prepare('SELECT 1 FROM series_access_all WHERE series_id = ?').get(seriesId);
  const userRows = db.prepare('SELECT user_id FROM series_access_users WHERE series_id = ?').all(seriesId);
  return {
    all_users: Boolean(allAccess),
    user_ids: userRows.map((r) => r.user_id),
  };
};

const setSeriesAccess = (seriesId, { all_users, user_ids = [] }) => {
  const tx = db.transaction(() => {
    if (all_users) {
      db.prepare('INSERT OR IGNORE INTO series_access_all (series_id) VALUES (?)').run(seriesId);
    } else {
      db.prepare('DELETE FROM series_access_all WHERE series_id = ?').run(seriesId);
    }
    db.prepare('DELETE FROM series_access_users WHERE series_id = ?').run(seriesId);
    const stmt = db.prepare('INSERT OR IGNORE INTO series_access_users (series_id, user_id) VALUES (?, ?)');
    for (const uid of user_ids) stmt.run(seriesId, uid);
  });
  tx();
};

const getSeriesVideos = ({ seriesId, userId = null, isAdmin = false, limit = 500, offset = 0 } = {}) => {
  const params = [seriesId];
  let accessWhere = '';

  if (!isAdmin) {
    if (userId === null || userId === undefined) {
      accessWhere = 'AND 1 = 0';
    } else {
      accessWhere = `
        AND (
          EXISTS (SELECT 1 FROM video_access_all vaa WHERE vaa.video_id = v.id)
          OR EXISTS (SELECT 1 FROM video_access_users vau WHERE vau.video_id = v.id AND vau.user_id = ?)
          OR EXISTS (
            SELECT 1 FROM video_people vp
            JOIN people p ON p.id = vp.person_id
            WHERE vp.video_id = v.id AND p.user_id = ?
          )
          OR EXISTS (
            SELECT 1 FROM video_people_auto vpa
            JOIN people p ON p.id = vpa.person_id
            WHERE vpa.video_id = v.id AND p.user_id = ?
          )
        )`;
      params.push(userId, userId, userId);
    }
  }

  return db
    .prepare(
      `SELECT v.id, v.filename, v.title, v.original_title, v.description, v.category,
              v.content_date, v.file_created_at, v.duration, v.file_size, v.thumbnail_path,
              v.video_width, v.video_height, v.view_count, v.scanned_at
       FROM series_videos sv
       JOIN videos v ON v.id = sv.video_id
       WHERE sv.series_id = ?
       ${accessWhere}
       ORDER BY sv.sort_order ASC, sv.created_at ASC, v.title ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, Math.max(1, Math.min(Number(limit) || 500, 1000)), Math.max(0, Number(offset) || 0));
};

const getAllSeries = ({ userId = null, isAdmin = false } = {}) => {
  if (isAdmin) {
    return db
      .prepare(
        `SELECT s.id, s.name, s.description, s.created_by, s.created_at, s.updated_at,
                u.username AS created_by_username,
                u.display_name AS created_by_display_name,
                COALESCE((SELECT COUNT(*) FROM series_videos sv WHERE sv.series_id = s.id), 0) AS total_videos,
                COALESCE((SELECT COUNT(*) FROM series_videos sv WHERE sv.series_id = s.id), 0) AS visible_videos,
                COALESCE((
                  SELECT GROUP_CONCAT(svp.video_id)
                  FROM (
                    SELECT sv.video_id
                    FROM series_videos sv
                    WHERE sv.series_id = s.id
                    ORDER BY sv.sort_order ASC, sv.created_at ASC
                    LIMIT 3
                  ) svp
                ), '') AS preview_video_ids
         FROM series s
         LEFT JOIN users u ON u.id = s.created_by
         ORDER BY s.updated_at DESC, s.id DESC`
      )
      .all();
  }

  if (userId === null || userId === undefined) return [];

  return db
    .prepare(
      `SELECT s.id, s.name, s.description, s.created_by, s.created_at, s.updated_at,
              u.username AS created_by_username,
              u.display_name AS created_by_display_name,
              COALESCE((SELECT COUNT(*) FROM series_videos sv WHERE sv.series_id = s.id), 0) AS total_videos,
              COALESCE((
                SELECT COUNT(*)
                FROM series_videos sv
                JOIN videos v ON v.id = sv.video_id
                WHERE sv.series_id = s.id
                  AND (
                    EXISTS (SELECT 1 FROM video_access_all vaa WHERE vaa.video_id = v.id)
                    OR EXISTS (SELECT 1 FROM video_access_users vau WHERE vau.video_id = v.id AND vau.user_id = ?)
                    OR EXISTS (
                      SELECT 1 FROM video_people vp
                      JOIN people p ON p.id = vp.person_id
                      WHERE vp.video_id = v.id AND p.user_id = ?
                    )
                    OR EXISTS (
                      SELECT 1 FROM video_people_auto vpa
                      JOIN people p ON p.id = vpa.person_id
                      WHERE vpa.video_id = v.id AND p.user_id = ?
                    )
                  )
              ), 0) AS visible_videos,
              COALESCE((
                SELECT GROUP_CONCAT(svp.video_id)
                FROM (
                  SELECT sv.video_id
                  FROM series_videos sv
                  JOIN videos v ON v.id = sv.video_id
                  WHERE sv.series_id = s.id
                    AND (
                      EXISTS (SELECT 1 FROM video_access_all vaa WHERE vaa.video_id = v.id)
                      OR EXISTS (SELECT 1 FROM video_access_users vau WHERE vau.video_id = v.id AND vau.user_id = ?)
                      OR EXISTS (
                        SELECT 1 FROM video_people vp
                        JOIN people p ON p.id = vp.person_id
                        WHERE vp.video_id = v.id AND p.user_id = ?
                      )
                      OR EXISTS (
                        SELECT 1 FROM video_people_auto vpa
                        JOIN people p ON p.id = vpa.person_id
                        WHERE vpa.video_id = v.id AND p.user_id = ?
                      )
                    )
                  ORDER BY sv.sort_order ASC, sv.created_at ASC
                  LIMIT 3
                ) svp
              ), '') AS preview_video_ids
       FROM series s
       LEFT JOIN users u ON u.id = s.created_by
       WHERE EXISTS (SELECT 1 FROM series_access_all saa WHERE saa.series_id = s.id)
          OR EXISTS (SELECT 1 FROM series_access_users sau WHERE sau.series_id = s.id AND sau.user_id = ?)
       ORDER BY s.updated_at DESC, s.id DESC`
    )
    .all(userId, userId, userId, userId, userId, userId, userId);
};

const addVideosToSeries = (seriesId, videoIds) => {
  const tx = db.transaction(() => {
    const currentMax = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM series_videos WHERE series_id = ?').get(seriesId);
    let nextOrder = Number(currentMax?.max_order || 0);
    const stmt = db.prepare('INSERT OR IGNORE INTO series_videos (series_id, video_id, sort_order) VALUES (?, ?, ?)');
    for (const videoId of videoIds) {
      nextOrder += 1;
      stmt.run(seriesId, videoId, nextOrder);
    }
    db.prepare('UPDATE series SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(seriesId);
  });
  tx();
};

const removeVideoFromSeries = (seriesId, videoId) => {
  const result = db.prepare('DELETE FROM series_videos WHERE series_id = ? AND video_id = ?').run(seriesId, videoId);
  db.prepare('UPDATE series SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(seriesId);
  return result;
};

const setSeriesVideoOrder = (seriesId, orderedVideoIds = []) => {
  const tx = db.transaction(() => {
    const currentIds = db
      .prepare('SELECT video_id FROM series_videos WHERE series_id = ? ORDER BY sort_order ASC, created_at ASC')
      .all(seriesId)
      .map((r) => Number(r.video_id));

    const currentSet = new Set(currentIds);
    const requested = Array.from(new Set((orderedVideoIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
    const orderedExisting = requested.filter((id) => currentSet.has(id));
    const missingTail = currentIds.filter((id) => !orderedExisting.includes(id));
    const finalOrder = [...orderedExisting, ...missingTail];

    const stmt = db.prepare('UPDATE series_videos SET sort_order = ? WHERE series_id = ? AND video_id = ?');
    finalOrder.forEach((videoId, idx) => stmt.run(idx + 1, seriesId, videoId));
    db.prepare('UPDATE series SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(seriesId);
  });
  tx();
};

const getFavoriteVideos = (userId, limit = 100) =>
  db
    .prepare(
      `SELECT v.id, v.filename, v.title, v.original_title, v.description, v.category,
              v.content_date, v.file_created_at, v.duration, v.file_size, v.thumbnail_path,
              v.video_width, v.video_height, v.view_count, v.scanned_at, f.created_at AS favorited_at,
              CASE WHEN v.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_name') ELSE c.name END AS channel_name, 
              CASE WHEN v.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_avatar') ELSE c.avatar_path END AS channel_avatar_path
       FROM user_favorites f
       JOIN videos v ON v.id = f.video_id
       LEFT JOIN channels c ON c.id = v.channel_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC
       LIMIT ?`
    )
    .all(userId, limit);

// ── Video Shares ─────────────────────────────────────────────────────────────

const createVideoShare = (videoId) => {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`
    INSERT INTO video_shares (video_id, token) 
    VALUES (?, ?) 
    ON CONFLICT(video_id) DO UPDATE SET token = excluded.token, created_at = CURRENT_TIMESTAMP
  `).run(videoId, token);
  return token;
};

const getVideoShareToken = (videoId) => {
  const row = db.prepare('SELECT token FROM video_shares WHERE video_id = ?').get(videoId);
  return row ? row.token : null;
};

const getAllVideoShares = () => {
  const stmt = db.prepare(`
    SELECT vs.token, vs.created_at, v.id as video_id, v.title as video_title
    FROM video_shares vs
    JOIN videos v ON vs.video_id = v.id
    ORDER BY vs.created_at DESC
  `);
  return stmt.all();
};

const deleteVideoShare = (videoId) => {
  db.prepare('DELETE FROM video_shares WHERE video_id = ?').run(videoId);
};

const getVideoByShareToken = (token) => {
  const row = db.prepare(`
    SELECT v.* 
    FROM video_shares vs
    JOIN videos v ON v.id = vs.video_id
    WHERE vs.token = ?
  `).get(token);
  return row || null;
};

// ── Channel Community & Overhaul queries ─────────────────────────────────────
const createCommunityPost = (channelId, content, imagePath = null) =>
  db.prepare('INSERT INTO community_posts (channel_id, content, image_path) VALUES (?, ?, ?)').run(channelId, content, imagePath);

const updateCommunityPost = (id, channelId, content, imagePath = null) =>
  db.prepare('UPDATE community_posts SET content = ?, image_path = COALESCE(?, image_path), is_edited = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND IFNULL(channel_id, 0) = IFNULL(?, 0)').run(content, imagePath, id, channelId);

const deleteCommunityPost = (id, channelId) =>
  db.prepare('DELETE FROM community_posts WHERE id = ? AND IFNULL(channel_id, 0) = IFNULL(?, 0)').run(id, channelId);

const getCommunityPosts = (channelId, limit = 20) =>
  db.prepare(`
    SELECT cp.*, 
           CASE WHEN cp.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_name') ELSE c.name END as channel_name,
           CASE WHEN cp.channel_id IS NULL THEN (SELECT value FROM settings WHERE key = 'channel_avatar') ELSE c.avatar_path END as channel_avatar
    FROM community_posts cp
    LEFT JOIN channels c ON c.id = cp.channel_id
    WHERE IFNULL(cp.channel_id, 0) = IFNULL(?, 0)
    ORDER BY cp.created_at DESC LIMIT ?
  `).all(channelId, limit);

const toggleSubscription = (userId, channelId) => {
  const existing = db.prepare('SELECT 1 FROM channel_subscriptions WHERE user_id = ? AND IFNULL(channel_id, 0) = IFNULL(?, 0)').get(userId, channelId);
  if (existing) {
    db.prepare('DELETE FROM channel_subscriptions WHERE user_id = ? AND IFNULL(channel_id, 0) = IFNULL(?, 0)').run(userId, channelId);
    return false;
  } else {
    db.prepare('INSERT INTO channel_subscriptions (user_id, channel_id) VALUES (?, ?)').run(userId, channelId);
    return true;
  }
};

const getSubscriptionStatus = (userId, channelId) =>
  !!db.prepare('SELECT 1 FROM channel_subscriptions WHERE user_id = ? AND IFNULL(channel_id, 0) = IFNULL(?, 0)').get(userId, channelId);

const getSubscriberCount = (channelId) =>
  db.prepare('SELECT COUNT(*) as count FROM channel_subscriptions WHERE IFNULL(channel_id, 0) = IFNULL(?, 0)').get(channelId).count;

const getVideoCount = (channelId) =>
  db.prepare('SELECT COUNT(*) as count FROM videos WHERE IFNULL(channel_id, 0) = IFNULL(?, 0)').get(channelId).count;

const getSubscribers = (channelId) =>
  db.prepare('SELECT user_id FROM channel_subscriptions WHERE IFNULL(channel_id, 0) = IFNULL(?, 0)').all(channelId).map(r => r.user_id);

const addChannelNotification = (channelId, videoId) => {
  const subs = getSubscribers(channelId);
  const stmt = db.prepare('INSERT INTO channel_notifications (user_id, channel_id, video_id) VALUES (?, ?, ?)');
  const tx = db.transaction((subIds) => {
    for (const id of subIds) {
      stmt.run(id, channelId, videoId);
    }
  });
  tx(subs);
};

const markChannelNotificationRead = (userId, notifId) =>
  db.prepare('UPDATE channel_notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(notifId, userId);

// ── Friend queries ───────────────────────────────────────────────────────────
const sendFriendRequest = (userId, friendId) => {
  // Check if reverse friendship already exists
  const existing = db.prepare(
    'SELECT id, status FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)'
  ).get(userId, friendId, friendId, userId);
  if (existing) {
    if (existing.status === 'accepted') return { error: 'Already friends.' };
    if (existing.status === 'pending') return { error: 'Friend request already pending.' };
    if (existing.status === 'blocked') return { error: 'Cannot send request.' };
  }
  db.prepare(
    'INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)'
  ).run(userId, friendId, 'pending');
  return { ok: true };
};

const acceptFriendRequest = (userId, fromUserId) => {
  // The request was sent BY fromUserId TO userId
  const req = db.prepare(
    'SELECT id FROM friends WHERE user_id = ? AND friend_id = ? AND status = ?'
  ).get(fromUserId, userId, 'pending');
  if (!req) return { error: 'No pending request found.' };
  db.prepare(
    "UPDATE friends SET status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND friend_id = ?"
  ).run(fromUserId, userId);
  // Create the reverse relationship too
  db.prepare(
    "INSERT OR IGNORE INTO friends (user_id, friend_id, status) VALUES (?, ?, 'accepted')"
  ).run(userId, fromUserId);
  return { ok: true };
};

const getPersonVhsChannels = (personId) => {
  const rows = db.prepare(`
    SELECT DISTINCT v.channel_id
    FROM videos v
    WHERE v.is_vhs = 1 AND (
      EXISTS (SELECT 1 FROM video_people vp WHERE vp.video_id = v.id AND vp.person_id = ?)
      OR EXISTS (SELECT 1 FROM video_people_auto vpa WHERE vpa.video_id = v.id AND vpa.person_id = ?)
    )
  `).all(personId, personId);
  return rows.map(r => r.channel_id === null ? 'main' : String(r.channel_id));
};

const denyFriendRequest = (userId, fromUserId) => {
  const req = db.prepare(
    'SELECT id FROM friends WHERE user_id = ? AND friend_id = ? AND status = ?'
  ).get(fromUserId, userId, 'pending');
  if (!req) return { error: 'No pending request found.' };
  db.prepare(
    'DELETE FROM friends WHERE user_id = ? AND friend_id = ?'
  ).run(fromUserId, userId);
  return { ok: true };
};

const removeFriend = (userId, friendId) => {
  db.prepare(
    'DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)'
  ).run(userId, friendId, friendId, userId);
  return { ok: true };
};

const getFriends = (userId) =>
  db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_path, f.created_at AS friends_since
    FROM friends f
    JOIN users u ON u.id = CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END
    WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
    GROUP BY u.id
    ORDER BY u.display_name ASC
  `).all(userId, userId, userId);

const getPendingFriendRequests = (userId) =>
  db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_path, f.created_at
    FROM friends f
    JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(userId);

const getSentFriendRequests = (userId) =>
  db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_path, f.created_at
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(userId);

const getFriendship = (userId, friendId) =>
  db.prepare(
    'SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)'
  ).get(userId, friendId, friendId, userId);

module.exports = {
  initDatabase,
  // users
  getUserByUsername,
  getUserById,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  touchLastLogin,
  getUserAvatarPathById,
  // channels
  getChannelByUserId,
  getChannelById,
  getAllChannels,
  createChannel,
  updateChannel,
  // videos
  getVideoById,
  getVideoByPath,
  getAllVideos,
  upsertVideo,
  updateVideoMeta,
  updateVideoFilepath,
  setVideoThumbnail,
  incrementViewCount,
  removeStaleVideos,
  createVideoShare,
  getVideoShareToken,
  deleteVideoShare,
  getVideoByShareToken,
  getAllVideoShares,
  // comments
  getCommentsByVideoId,
  addComment,
  getCommentById,
  updateComment,
  deleteComment,
  getCommentReaction,
  upsertCommentReaction,
  deleteCommentReaction,
  hasCommentLike,
  addCommentLike,
  removeCommentLike,
  hasCommentHeart,
  addCommentHeart,
  removeCommentHeart,
  // notifications
  getNotifications,
  markNotificationRead,
  // progress
  upsertProgress,
  getProgress,
  getAllProgressForUser,
  getWatchHistory,
  // favorites
  addFavorite,
  removeFavorite,
  getFavoriteVideoIds,
  getFavoriteVideos,
  // people
  createPerson,
  updatePerson,
  deletePerson,
  getAllPeople,
  getPersonById,
  setPersonImage,
  setPersonUserLink,
  getPersonVhsPhotos,
  getPersonVhsChannels,
  getPersonVhsPhotoById,
  addPersonVhsPhoto,
  updatePersonVhsPhoto,
  deletePersonVhsPhoto,
  deletePersonVhsPhotosForPerson,
  // video people
  getVideoPeople,
  setVideoPeople,
  // video access
  getVideoAccess,
  setVideoAccess,
  canUserAccessVideo,
  // series
  createSeries,
  updateSeries,
  deleteSeries,
  getSeriesById,
  getAllSeries,
  getSeriesVideos,
  addVideosToSeries,
  removeVideoFromSeries,
  setSeriesVideoOrder,
  getSeriesAccess,
  setSeriesAccess,
  canUserAccessSeries,
  syncAutoTaggedPeopleForVideo,
  syncAutoTaggedPeopleForPerson,
  // dialogs
  getPendingDialogsForUser,
  markDialogRead,
  createDialog,
  getAllDialogs,
  deleteDialog,
  // settings
  getChannelProfile,
  updateChannelProfile,
  getSetting,
  setSetting,
  // audit logs
  createAuditLog,
  getRecentAuditLogs,
  
  // channel community & overhaul
  createCommunityPost,
  updateCommunityPost,
  deleteCommunityPost,
  getCommunityPosts,
  toggleSubscription,
  getSubscriptionStatus,
  getSubscriberCount,
  getVideoCount,
  addChannelNotification,
  markChannelNotificationRead,
  // friends
  sendFriendRequest,
  acceptFriendRequest,
  denyFriendRequest,
  removeFriend,
  getFriends,
  getPendingFriendRequests,
  getSentFriendRequests,
  getFriendship,
  // shutdown
  closeDatabase: () => { try { if (db) db.close(); } catch (e) { console.warn('[DB] Close error:', e.message); } },
};
