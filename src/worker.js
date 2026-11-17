// Cloudflare Worker: سحب متعدد المصادر (Round Robin) + تخزين الصور في تلغرام + API
//  - scheduled : يسحب فصلًا واحدًا جديدًا من المصدر الحالي ثم ينتقل للمصدر التالي
//  - /fetch_chapter : يعيد روابط صور فصل محفوظ
//  - /tg_file/<bot>/<file_id> : يبث الصورة من تلغرام دون كشف توكن البوت
//  - /api/* : وسيط الواجهة (موجود مسبقًا في manhwa-sit)
import { handleProxy } from './proxy.js';
import { SOURCES, ADAPTERS } from './sources.js';

// ---------- الإعدادات ----------
const IMG_MAX_WIDTH = 1000;
const IMG_QUALITY = 78;            // WebP بجودة 0.78
const MAX_IMAGES_PER_CHAPTER = 150;
const UPLOAD_CONCURRENCY = 3;
const MAX_SERIES_PER_RUN = 6;      // أقصى عدد أعمال تُفحص في تشغيل واحد بحثًا عن فصل جديد
const MAX_FAILS = 3;               // بعد 3 محاولات فاشلة يُتخطى الفصل
const CACHE_WEEK = 'public, max-age=604800';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// ---------- أدوات ----------
const normChapter = (v) => {
  const s = String(v ?? '').trim();
  return /^\d+(\.\d+)?$/.test(s) ? String(Number.isInteger(+s) ? parseInt(s, 10) : +s) : s;
};
const normName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

function getBots(env) {
  const bots = [];
  for (let i = 1; i <= 3; i++) {
    const token = env['TELEGRAM_BOT_TOKEN_' + i], chat = env['TELEGRAM_CHAT_ID_' + i];
    if (token && chat) bots.push({ n: i, token, chat });
  }
  return bots;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---------- معالجة الصور ----------
const extOf = (ct) => ({ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/avif': 'avif', 'image/gif': 'gif' }[ct] || 'bin');

async function downloadAndCompress(env, url, referer) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': UA, Referer: referer, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
  });
  if (!r.ok) throw new Error('image HTTP ' + r.status);
  const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\//.test(type) && type !== 'application/octet-stream') throw new Error('not an image: ' + type);
  const buf = await r.arrayBuffer();

  // ضغط + تحويل إلى WebP عبر Images binding، وعند الفشل نرفع الأصل
  if (env.IMAGES) {
    try {
      const res = await env.IMAGES.input(new Blob([buf]).stream())
        .transform({ width: IMG_MAX_WIDTH, fit: 'scale-down' })
        .output({ format: 'image/webp', quality: IMG_QUALITY });
      const out = await res.response().arrayBuffer();
      if (out.byteLength > 0) return { bytes: out, type: 'image/webp', ext: 'webp' };
    } catch (e) {
      console.warn('compress failed, using original:', String((e && e.message) || e));
    }
  }
  const t = /^image\//.test(type) ? type : 'image/jpeg';
  return { bytes: buf, type: t, ext: extOf(t) };
}

// ---------- الرفع إلى تلغرام (Round Robin + Failover) ----------
async function uploadToTelegram(bots, startIdx, img, filename) {
  let lastErr = new Error('no telegram bot configured');
  for (let t = 0; t < bots.length; t++) {
    const bot = bots[(startIdx + t) % bots.length];
    try {
      const fd = new FormData();
      fd.append('chat_id', bot.chat);
      fd.append('disable_notification', 'true');
      fd.append('document', new Blob([img.bytes], { type: img.type }), filename);
      const r = await fetch('https://api.telegram.org/bot' + bot.token + '/sendDocument', { method: 'POST', body: fd });
      const j = await r.json().catch(() => null);
      const id = j && j.ok && j.result && j.result.document && j.result.document.file_id;
      if (id) return { b: bot.n, f: id };
      lastErr = new Error('telegram bot ' + bot.n + ': ' + ((j && j.description) || 'HTTP ' + r.status));
    } catch (e) {
      lastErr = new Error('telegram bot ' + bot.n + ': ' + String((e && e.message) || e));
    }
  }
  throw lastErr;
}

// ---------- حالة السحب (D1) ----------
async function loadStatus(env) {
  let row = await env.DB.prepare(
    'SELECT current_source_index, last_chapter_scraped_per_source, bot_index FROM crawler_status WHERE id = 1'
  ).first();
  if (!row) {
    await env.DB.prepare('INSERT OR IGNORE INTO crawler_status (id) VALUES (1)').run();
    row = { current_source_index: 0, last_chapter_scraped_per_source: '{}', bot_index: 0 };
  }
  let per = {};
  try { per = JSON.parse(row.last_chapter_scraped_per_source || '{}') || {}; } catch {}
  return { idx: row.current_source_index || 0, per, bot: row.bot_index || 0 };
}

async function saveStatus(env, st) {
  await env.DB.prepare(
    "UPDATE crawler_status SET current_source_index = ?, last_chapter_scraped_per_source = ?, bot_index = ?, updated_at = strftime('%s','now') WHERE id = 1"
  ).bind(st.idx, JSON.stringify(st.per), st.bot).run();
}

const freshState = () => ({ page: 1, mi: 0, cursor: null, last: null, failed: {} });

// ---------- سحب مصدر واحد ----------
// يمرّ على مكتبة المصدر من حيث توقّف، ويسحب أول فصل غير موجود في D1
async function crawlSource(env, name, ss, status) {
  const src = ADAPTERS[name];
  const bots = getBots(env);
  if (!bots.length) throw new Error('no Telegram bots configured');

  const pages = new Map();
  const getPage = async (p, cursor) => {
    if (!pages.has(p)) pages.set(p, await src.listManga(p, cursor));
    return pages.get(p);
  };

  for (let looked = 0; looked < MAX_SERIES_PER_RUN;) {
    const list = await getPage(ss.page, ss.cursor);
    if (!list.items.length) {
      // انتهت المكتبة: نبدأ دورة جديدة من الصفحة الأولى
      if (ss.page === 1 && ss.mi === 0) return;
      Object.assign(ss, { page: 1, mi: 0, cursor: null });
      pages.clear();
      looked++;
      continue;
    }
    if (ss.mi >= list.items.length) {
      Object.assign(ss, { page: ss.page + 1, mi: 0, cursor: list.nextCursor || null });
      continue;
    }

    const item = list.items[ss.mi];
    looked++;
    const series = await src.listChapters(item.slug);
    const mangaName = normName(series.title || item.title || item.slug);

    const { results } = await env.DB.prepare('SELECT chapter_number FROM chapters WHERE manga_name = ?').bind(mangaName).all();
    const have = new Set((results || []).map((r) => r.chapter_number));
    const next = series.chapters.find((c) => {
      const key = mangaName + '|' + c.num;
      return !have.has(normChapter(c.num)) && (ss.failed[key] || 0) < MAX_FAILS;
    });
    if (!next) { ss.mi++; continue; }

    const key = mangaName + '|' + next.num;
    try {
      const { urls, referer } = await src.chapterImages(item.slug, next);
      if (!urls.length) throw new Error('no images found');
      if (urls.length > MAX_IMAGES_PER_CHAPTER) throw new Error('too many images: ' + urls.length);

      const base = status.bot;
      const fileIds = await mapLimit(urls, UPLOAD_CONCURRENCY, async (u, i) => {
        const img = await downloadAndCompress(env, u, referer);
        return uploadToTelegram(bots, (base + i) % bots.length, img, String(i + 1).padStart(3, '0') + '.' + img.ext);
      });
      status.bot = (base + urls.length) % bots.length;

      await env.DB.prepare('INSERT OR IGNORE INTO chapters (manga_name, chapter_number, source, file_ids) VALUES (?, ?, ?, ?)')
        .bind(mangaName, normChapter(next.num), name, JSON.stringify(fileIds)).run();
      ss.last = { manga: mangaName, chapter: normChapter(next.num) };
      delete ss.failed[key];
      console.log('saved', name, mangaName, next.num, fileIds.length + ' images');
      return;
    } catch (e) {
      ss.failed[key] = (ss.failed[key] || 0) + 1;
      const keys = Object.keys(ss.failed);
      if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete ss.failed[k];
      throw e;
    }
  }
}

async function crawlOnce(env) {
  const status = await loadStatus(env);
  const idx = status.idx % SOURCES.length;
  const name = SOURCES[idx];
  const ss = Object.assign(freshState(), status.per[name] || {});
  try {
    await crawlSource(env, name, ss, status);
  } catch (e) {
    console.error('crawl error [' + name + ']:', String((e && e.message) || e));
  } finally {
    status.per[name] = ss;
    status.idx = (idx + 1) % SOURCES.length; // Round Robin
    await saveStatus(env, status);
  }
}

// ---------- API ----------
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const jsonRes = (o, status = 200, extra = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra } });

// GET /fetch_chapter?manga_name=...&chapter_number=...   (أو POST بجسم JSON)
async function handleFetchChapter(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'POST') return jsonRes({ error: 'method not allowed' }, 405, { 'cache-control': 'no-store' });
  const u = new URL(request.url);
  let name = u.searchParams.get('manga_name'), num = u.searchParams.get('chapter_number');
  if (request.method === 'POST') {
    try { const b = await request.json(); name = b.manga_name ?? name; num = b.chapter_number ?? num; } catch {}
  }
  name = normName(name);
  num = normChapter(num);
  if (!name || !num) return jsonRes({ error: 'manga_name and chapter_number are required' }, 400, { 'cache-control': 'no-store' });

  const row = await env.DB.prepare('SELECT manga_name, chapter_number, source, file_ids FROM chapters WHERE manga_name = ? AND chapter_number = ?')
    .bind(name, num).first();
  if (!row) return jsonRes({ error: 'chapter not found' }, 404, { 'cache-control': 'no-store' });

  let ids = [];
  try { ids = JSON.parse(row.file_ids); } catch {}
  const images = ids.map((x) => u.origin + '/tg_file/' + x.b + '/' + x.f);
  return jsonRes(
    { manga_name: row.manga_name, chapter_number: row.chapter_number, source: row.source, count: images.length, images },
    200,
    { 'cache-control': 'max-age=604800' }
  );
}

const MIME = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', avif: 'image/avif', gif: 'image/gif' };

// GET /tg_file/<bot>/<file_id> -> بايتات الصورة (مخبأة أسبوعًا)
async function handleTgFile(request, env, ctx) {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
  const m = /^\/tg_file\/([1-3])\/([\w-]{10,200})$/.exec(new URL(request.url).pathname);
  if (!m) return new Response('bad request', { status: 400 });
  const bot = getBots(env).find((b) => b.n === +m[1]);
  if (!bot) return new Response('not found', { status: 404 });

  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  try {
    const g = await fetch('https://api.telegram.org/bot' + bot.token + '/getFile?file_id=' + encodeURIComponent(m[2]));
    const j = await g.json().catch(() => null);
    const path = j && j.ok && j.result && j.result.file_path;
    if (!path) return new Response('file not found', { status: 404 });
    const f = await fetch('https://api.telegram.org/file/bot' + bot.token + '/' + path);
    if (!f.ok) return new Response('upstream ' + f.status, { status: 502 });
    const ext = (path.split('.').pop() || '').toLowerCase();
    const resp = new Response(f.body, {
      status: 200,
      headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': CACHE_WEEK + ', immutable', 'access-control-allow-origin': '*' },
    });
    ctx.waitUntil(cache.put(request, resp.clone()));
    return resp;
  } catch {
    return new Response('fetch failed', { status: 502 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/fetch_chapter') return handleFetchChapter(request, env);
    if (pathname.startsWith('/tg_file/')) return handleTgFile(request, env, ctx);
    const proxied = await handleProxy(request);
    if (proxied) return proxied;
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(crawlOnce(env));
  },
};
