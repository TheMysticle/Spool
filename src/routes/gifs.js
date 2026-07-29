'use strict';

const express = require('express');
const { getSetting } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const FALLBACK_GIFS = [
  { id: 'fallback-1', title: 'Happy', url: 'https://media.tenor.com/eY6m0a4q4mUAAAAM/happy-dance.gif' },
  { id: 'fallback-2', title: 'Wow', url: 'https://media.tenor.com/eV9N9Jw2j6kAAAAM/wow-oh-wow.gif' },
  { id: 'fallback-3', title: 'LOL', url: 'https://media.tenor.com/X3xMIBqQ9S4AAAAM/laughing-lol.gif' },
  { id: 'fallback-4', title: 'Thumbs up', url: 'https://media.tenor.com/2roX3uxz_68AAAAM/thumbs-up.gif' },
  { id: 'fallback-5', title: 'Excited', url: 'https://media.tenor.com/Tz6yA9Xl8cwAAAAM/excited-happy.gif' },
  { id: 'fallback-6', title: 'Facepalm', url: 'https://media.tenor.com/3x63SNMKPogAAAAM/facepalm-really.gif' },
  { id: 'fallback-7', title: 'Thank you', url: 'https://media.tenor.com/zt8zjP0vNFAAAAAM/thank-you-thanks.gif' },
  { id: 'fallback-8', title: 'Cute', url: 'https://media.tenor.com/3ZZiQf9i4GgAAAAM/cute-cat.gif' },
];

function fallbackForQuery(query) {
  if (!query) return FALLBACK_GIFS;
  const q = query.toLowerCase();
  const filtered = FALLBACK_GIFS.filter((gif) => gif.title.toLowerCase().includes(q));
  return filtered.length ? filtered : FALLBACK_GIFS;
}

function sanitizeForLog(str, maxLen = 400) {
  if (typeof str !== 'string') return '';
  return str.replace(/\s+/g, ' ').slice(0, maxLen);
}

router.get('/', authenticate, async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const limitRaw = Number.parseInt(String(req.query.limit || '24'), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 40) : 24;
  const localeRaw = typeof req.query.locale === 'string' && req.query.locale.trim()
    ? req.query.locale.trim()
    : 'en_US';
  const locale = localeRaw.split(/[-_]/)[0] || 'en';
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  console.info(`[GIF][${reqId}] Incoming request query="${query}" limit=${limit} locale=${locale}`);

  const KLIPY_API_KEY = getSetting('klipy_api_key', '');
  if (!KLIPY_API_KEY) {
    console.warn(`[GIF][${reqId}] Missing KLIPY_API_KEY in settings; returning fallback`);
    const fallback = fallbackForQuery(query).slice(0, limit);
    return res.json({ gifs: fallback, degraded: true, provider: 'fallback', reason: 'key_missing', request_id: reqId });
  }

  try {
    const endpoint = query
      ? `https://api.klipy.com/v2/search?key=${encodeURIComponent(KLIPY_API_KEY)}&q=${encodeURIComponent(query)}&limit=${limit}&locale=${encodeURIComponent(locale)}`
      : `https://api.klipy.com/v2/featured?key=${encodeURIComponent(KLIPY_API_KEY)}&limit=${limit}&locale=${encodeURIComponent(locale)}`;

    console.info(`[GIF][${reqId}] Provider request ${endpoint.replace(KLIPY_API_KEY, '***')}`);

    const response = await fetch(endpoint);
    let data;

    if (response.ok) {
      data = await response.json();
      const results = Array.isArray(data.results) ? data.results : [];
      const gifs = results
        .map((item) => {
          const url = item?.media_formats?.tinygif?.url
            || item?.media_formats?.gif?.url
            || null;
          if (!url) return null;
          return {
            id: item.id,
            url,
            title: item.title || item.content_description || 'GIF',
          };
        })
        .filter(Boolean);

      console.info(`[GIF][${reqId}] Provider success status=${response.status} results=${results.length} mapped=${gifs.length}`);

      if (gifs.length > 0) {
        return res.json({ gifs, degraded: false, provider: 'klipy_v2', request_id: reqId });
      }

      console.warn(`[GIF][${reqId}] Provider returned no usable GIF URLs; falling back`);
    } else {
      const raw = await response.text();
      console.warn(`[GIF][${reqId}] Provider HTTP ${response.status}: ${sanitizeForLog(raw)}`);
    }

    const fallback = fallbackForQuery(query).slice(0, limit);
    return res.json({
      gifs: fallback,
      degraded: true,
      reason: `provider_http_${response.status}`,
      provider: 'fallback',
      request_id: reqId,
    });
  } catch (err) {
    console.warn(`[GIF][${reqId}] Klipy fetch failed:`, err?.message || err);
    const fallback = fallbackForQuery(query).slice(0, limit);
    return res.json({
      gifs: fallback,
      degraded: true,
      reason: 'provider_unreachable',
      provider: 'fallback',
      request_id: reqId,
    });
  }
});

module.exports = router;
