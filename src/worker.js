// Cloudflare Worker: سحب كثيف متعدد المصادر (Round Robin) + تخزين الصور في تلغرام + API
//  - scheduled      : دورة سحب (≤ 25 ثانية): عدة فصول بالتوازي من المصدر الحالي ثم ينتقل للتالي
//  - /fetch_chapter : يعيد روابط صور فصل؛ وإن لم يكن في D1 يسحبه فورًا من المصدر (On-Demand)
//  - /tg_file/<bot>/<id>[.<id>...] : يبث الصورة من تلغرام (ويجمّع الأجزاء إن كانت مقسّمة)
//  - /api/*         : وسيط الواجهة
//
// الخطة المجانية: 10ms CPU و50 طلبًا خارجيًا لكل استدعاء، لذلك:
//  * لا ضغط ولا تحويل للصور إطلاقًا — كل شيء يُرفع كمستند (document) كما هو.
//  * الرفع الأساسي عبر رابط الصورة (sendMediaGroup/sendDocument بنوع document): طلب واحد لكل 10 صور.
//    وإن رفض الموقع جلب تلغرام للصورة: نُحمّلها ونرفعها كما هي (طلبان للصورة).
//  * الملف الذي يتجاوز 19MB يُقسّم بايتيًا (دون فك ترميز) ويُجمَّع عند العرض في /tg_file.
import { handleProxy } from './proxy.js';
import { SOURCE_NAMES, createAdapters, makeBudget, BudgetError, rankCandidates, USER_AGENT } from './sources.js';

// ---------- الإعدادات (يمكن تجاوزها بمتغيرات بيئية اختيارية) ----------
const DEF = {
  TIME_LIMIT_MS: 25000,        // أقصى مدة لدورة Cron
  ON_DEMAND_LIMIT_MS: 45000,   // أقصى مدة لطلب /fetch_chapter
  CONCURRENCY: 5,              // عدد الفصول في نفس الوقت
  PACE_MS: 1500,               // انتظار بين كل رفعتين (صورة/مجموعة) داخل الفصل
  CHAPTER_GAP_MS: 3000,        // انتظار بين بدء كل فصل والذي يليه
  GROUP_SIZE: 10,              // عدد الصور في طلب تلغرام واحد (1 = صورة بصورة)
};
const SAFETY_MS = 3000;            // لا نبدأ طلبًا جديدًا إن بقي أقل من هذا
const PART_BYTES = 19 * 1024 * 1024;   // حد getFile في تلغرام 20MB
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const MAX_IMAGES_PER_CHAPTER = 200;
const MAX_SERIES_PER_WAVE = 8;
const MAX_WAVES = 6;
const MAX_FAILS = 3;
const CACHE_WEEK = 'public, max-age=604800';
const URL_ERR = /HTTP URL|wrong type|wrong file|failed to get|wrong remote|wrong web page|URL host is empty|can't parse URL|too big|dimensions|file is too big/i;

const cfg = (env, k) => { const v = parseInt(env && env[k], 10); return Number.isFinite(v) && v >= 0 ? v : DEF[k]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => String((e && e.message) || e);
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

// StopError: انتهى الوقت أو حدّ تلغرام — يُحفظ التقدم ولا يُحتسب فشلًا
class StopError extends Error {}
class TgError extends Error { constructor(m, urlProblem) { super(m); this.urlProblem = urlProblem; } }
const isStop = (e) => e instanceof StopError || e instanceof BudgetError;

// ---------- سياق التشغيل المشترك ----------
function makeRun(env, bots, bud, limitMs, botStart) {
  return {
    env, bots, bud,
    limitAt: Date.now() + limitMs,
    safety: Math.min(SAFETY_MS, Math.floor(limitMs * 0.15)),
    cursor: botStart % Math.max(1, bots.length),
    paceMs: cfg(env, 'PACE_MS'),
    groupSize: Math.max(1, Math.min(10, cfg(env, 'GROUP_SIZE'))),
  };
}
const timeLeft = (g) => g.limitAt - Date.now();

// انتظار آمن: لا ننام إن كان سيتجاوز الحد
async function safeSleep(g, ms) {
  if (ms <= 0) return;
  if (timeLeft(g) < ms + g.safety) throw new StopError('time limit');
  await sleep(ms);
}

// ---------- تلغرام ----------
async function tg(g, pace, bot, method, fd) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await safeSleep(g, pace.last + g.paceMs - Date.now());       // تأخير بين الرفعات
    if (timeLeft(g) < g.safety) throw new StopError('time limit');
    g.bud.spend();
    let j = null, status = 0;
    try {
      const r = await fetch('https://api.telegram.org/bot' + bot.token + '/' + method, {
        method: 'POST', body: fd, signal: AbortSignal.timeout(Math.max(4000, timeLeft(g) + 2000)),
      });
      status = r.status;
      j = await r.json().catch(() => null);
    } catch (e) {
      pace.last = Date.now();
      throw new TgError('telegram bot ' + bot.n + ': ' + errMsg(e), false);
    }
    pace.last = Date.now();
    if (j && j.ok) return j.result;
    const d = (j && j.description) || 'HTTP ' + status;
    const ra = j && j.parameters && j.parameters.retry_after;
    if (status === 429 || ra) {
      if (attempt === 0 && ra && timeLeft(g) > ra * 1000 + g.safety) { await sleep(ra * 1000); continue; }
      throw new StopError('telegram rate limit (retry_after=' + (ra || '?') + 's)');
    }
    throw new TgError('telegram bot ' + bot.n + ': ' + d, URL_ERR.test(d));
  }
  throw new StopError('telegram rate limit');
}

// رفع مجموعة روابط (≤10) كمستندات — تلغرام يجلب الصور بنفسه
async function sendByUrl(g, pace, bot, urls) {
  const fd = new FormData();
  fd.append('chat_id', bot.chat);
  fd.append('disable_notification', 'true');
  if (urls.length === 1) {
    fd.append('document', urls[0]);
    return [(await tg(g, pace, bot, 'sendDocument', fd)).document.file_id];
  }
  fd.append('media', JSON.stringify(urls.map((u) => ({ type: 'document', media: u }))));
  const res = await tg(g, pace, bot, 'sendMediaGroup', fd);
  const ids = res.map((m) => m.document && m.document.file_id);
  if (ids.length !== urls.length || ids.some((x) => !x)) throw new TgError('telegram: incomplete media group', false);
  return ids;
}

const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/avif': 'avif', 'image/gif': 'gif' };

// تنزيل الصورة كما هي ثم رفعها كمستند؛ إن زادت عن 19MB تُقسّم بايتيًا (بدون فك ترميز)
// تُرجع file_id واحدًا أو عدة معرّفات مفصولة بنقطة (الأجزاء بالترتيب)
async function sendByUpload(g, pace, bot, url, referer, idx) {
  g.bud.spend();
  const r = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Referer: referer, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
    signal: AbortSignal.timeout(Math.max(4000, timeLeft(g))),
  });
  if (!r.ok) throw new Error('image HTTP ' + r.status);
  const len = +r.headers.get('content-length') || 0;
  if (len > MAX_FILE_BYTES) throw new Error('image too large: ' + len);
  const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type && !/^image\//.test(type) && type !== 'application/octet-stream' && type !== 'binary/octet-stream') throw new Error('not an image: ' + type);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_FILE_BYTES) throw new Error('image too large: ' + buf.byteLength);
  const ext = EXT[type] || 'jpg';
  const base = String(idx + 1).padStart(3, '0');
  const parts = Math.max(1, Math.ceil(buf.byteLength / PART_BYTES));
  const ids = [];
  for (let k = 0; k < parts; k++) {
    const fd = new FormData();
    fd.append('chat_id', bot.chat);
    fd.append('disable_notification', 'true');
    const slice = parts === 1 ? buf : buf.slice(k * PART_BYTES, (k + 1) * PART_BYTES);
    fd.append('document', new Blob([slice], { type: type || 'application/octet-stream' }), parts === 1 ? base + '.' + ext : base + '_p' + (k + 1) + '.' + ext);
    ids.push((await tg(g, pace, bot, 'sendDocument', fd)).document.file_id);
  }
  return ids.join('.');
}

// يرفع مجموعة صور ويضيف نتائجها مباشرة إلى sink (ليبقى التقدم محفوظًا عند التوقف)
async function sendChunk(g, pace, chunk, referer, base, sink) {
  const n = g.bots.length;
  let lastErr = null;
  if (!pace.noUrl) {
    for (let t = 0; t < n; t++) {
      const bot = g.bots[(g.cursor + t) % n];
      try {
        const ids = await sendByUrl(g, pace, bot, chunk);
        ids.forEach((f) => sink.push({ b: bot.n, f }));
        g.cursor = (g.cursor + t + 1) % n;
        return;
      } catch (e) {
        if (isStop(e)) throw e;
        lastErr = e;
        if (e instanceof TgError && e.urlProblem) { pace.noUrl = true; break; } // الموقع يمنع جلب تلغرام
      }
    }
  }
  // احتياطي: تنزيل ثم رفع كما هي (+ Failover بين البوتات)
  for (let k = 0; k < chunk.length; k++) {
    if (g.bud.left() < 2) throw new BudgetError('not enough subrequests for upload fallback');
    let ok = false;
    for (let t = 0; t < n && !ok; t++) {
      const bot = g.bots[(g.cursor + t) % n];
      try {
        const f = await sendByUpload(g, pace, bot, chunk[k], referer, base + k);
        sink.push({ b: bot.n, f });
        g.cursor = (g.cursor + t + 1) % n;
        ok = true;
      } catch (e) {
        if (isStop(e)) throw e;
        lastErr = e;
        if (!(e instanceof TgError)) break; // خطأ تنزيل: تغيير البوت لا يفيد
      }
    }
    if (!ok) throw lastErr || new Error('upload failed');
  }
}

// يرفع باقي صور الفصل (يكمل من item.done)
async function uploadRest(g, item, urls, referer) {
  const pace = { last: 0, noUrl: false };
  if (item.done.length > urls.length) item.done = [];
  while (item.done.length < urls.length) {
    const i = item.done.length;
    await sendChunk(g, pace, urls.slice(i, i + g.groupSize), referer, i, item.done);
  }
}

// ---------- D1 ----------
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

async function saveChapter(env, names, num, source, ids) {
  const json = JSON.stringify(ids);
  for (const n of new Set(names.map(normName).filter(Boolean))) {
    await env.DB.prepare('INSERT OR IGNORE INTO chapters (manga_name, chapter_number, source, file_ids) VALUES (?, ?, ?, ?)')
      .bind(n, num, source, json).run();
  }
}

const getRow = (env, name, num) =>
  env.DB.prepare('SELECT manga_name, chapter_number, source, file_ids FROM chapters WHERE manga_name = ? AND chapter_number = ?').bind(name, num).first();

// ---------- سحب فصل (من الطابور) ----------
// يعيد: 'done' | 'stopped' (وقت/حد: يبقى في الطابور مع تقدمه) | 'retry' | 'dropped'
async function runItem(g, adapter, sourceName, item, startDelay) {
  const num = normChapter(item.ch.num);
  try {
    if (startDelay) await safeSleep(g, startDelay);       // فاصل بين الفصول
    if (await getRow(g.env, item.manga, num)) return 'done'; // وُجد مسبقًا
    const { urls, referer } = await adapter.chapterImages(item.slug, item.ch);
    if (!urls.length) throw new Error('no images found');
    if (urls.length > MAX_IMAGES_PER_CHAPTER) throw new Error('too many images: ' + urls.length);
    await uploadRest(g, item, urls, referer);
    await saveChapter(g.env, [item.manga], num, sourceName, item.done);
    console.log('saved', sourceName, item.manga, num, item.done.length + ' images');
    return 'done';
  } catch (e) {
    if (isStop(e)) { console.log('stopped', item.manga, num, '(' + item.done.length + ' uploaded):', errMsg(e)); return 'stopped'; }
    item.fails = (item.fails || 0) + 1;
    item.err = errMsg(e).slice(0, 200);
    console.error('chapter failed', sourceName, item.manga, num, item.err);
    return item.fails >= MAX_FAILS ? 'dropped' : 'retry';
  }
}

// ---------- Cron ----------
const freshState = () => ({ page: 1, mi: 0, cursor: null, last: null, failed: {}, queue: [], err: null });

// يملأ الطابور بفصول ناقصة (الأقدم أولًا) من المكتبة، من حيث توقف السحب
async function fillQueue(env, ss, adapter, bud, slots, pages) {
  const getPage = async (p, cursor) => {
    if (!pages.has(p)) pages.set(p, await adapter.listManga(p, cursor));
    return pages.get(p);
  };
  for (let looked = 0; ss.queue.length < slots && looked < MAX_SERIES_PER_WAVE && bud.left() > 10;) {
    const list = await getPage(ss.page, ss.cursor);
    if (!list.items.length) {
      if (ss.page === 1 && ss.mi === 0) return;      // مصدر فارغ
      Object.assign(ss, { page: 1, mi: 0, cursor: null });   // دورة جديدة
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
    const series = await adapter.listChapters(item.slug);
    const manga = normName(series.title || item.title || item.slug);
    const { results } = await env.DB.prepare('SELECT chapter_number FROM chapters WHERE manga_name = ?').bind(manga).all();
    const skip = new Set((results || []).map((r) => r.chapter_number));
    ss.queue.forEach((q) => { if (q.manga === manga) skip.add(normChapter(q.ch.num)); });
    const missing = series.chapters.filter((c) => !skip.has(normChapter(c.num)) && (ss.failed[manga + '|' + normChapter(c.num)] || 0) < MAX_FAILS);
    const take = missing.slice(0, slots - ss.queue.length);
    take.forEach((c) => ss.queue.push({ slug: item.slug, manga, ch: { num: c.num, ref: c.ref }, done: [], fails: 0 }));
    if (missing.length <= take.length) ss.mi++;       // اكتمل هذا العمل: ننتقل للتالي
  }
}

async function crawlSource(env, name, ss, status, g, adapter) {
  const slots = Math.max(1, cfg(env, 'CONCURRENCY'));
  const gap = cfg(env, 'CHAPTER_GAP_MS');
  const pages = new Map();
  for (let wave = 0; wave < MAX_WAVES; wave++) {
    if (timeLeft(g) < Math.min(8000, g.safety * 3) || g.bud.left() < 10) break;
    await fillQueue(env, ss, adapter, g.bud, slots, pages);
    if (!ss.queue.length) break;

    const batch = ss.queue.slice(0, slots);
    // تشغيل متوازٍ لكن متدرّج: الفصل k يبدأ بعد k × 3 ثوانٍ
    const res = await Promise.all(batch.map((it, k) => runItem(g, adapter, name, it, k * gap)));
    let progressed = false;
    batch.forEach((it, k) => {
      const key = it.manga + '|' + normChapter(it.ch.num);
      if (res[k] === 'done') { progressed = true; ss.last = { manga: it.manga, chapter: normChapter(it.ch.num) }; }
      if (res[k] === 'dropped') ss.failed[key] = MAX_FAILS;
      if (res[k] === 'done' || res[k] === 'dropped') ss.queue = ss.queue.filter((q) => q !== it);
    });
    const fk = Object.keys(ss.failed);
    if (fk.length > 300) for (const k of fk.slice(0, fk.length - 300)) delete ss.failed[k];
    if (!progressed) break; // توقف بسبب الوقت/الحد/الأخطاء: نحفظ ونخرج
  }
}

async function crawlOnce(env) {
  const t0 = Date.now();
  const status = await loadStatus(env);
  const idx = status.idx % SOURCE_NAMES.length;
  const name = SOURCE_NAMES[idx];
  const ss = Object.assign(freshState(), status.per[name] || {});
  if (!Array.isArray(ss.queue)) ss.queue = [];
  console.log('cron start: source=' + name + ' queued=' + ss.queue.length);
  try {
    const bots = getBots(env);
    if (!bots.length) throw new Error('no Telegram bots configured (TELEGRAM_BOT_TOKEN_n / TELEGRAM_CHAT_ID_n)');
    const bud = makeBudget(env);
    const g = makeRun(env, bots, bud, cfg(env, 'TIME_LIMIT_MS'), status.bot);
    await crawlSource(env, name, ss, status, g, createAdapters(env, bud)[name]);
    status.bot = g.cursor;
    ss.err = null;
  } catch (e) {
    ss.err = errMsg(e).slice(0, 300);
    console.error('crawl error [' + name + ']:', ss.err);
  } finally {
    status.per[name] = ss;
    status.idx = (idx + 1) % SOURCE_NAMES.length; // Round Robin
    await saveStatus(env, status);
    console.log('cron end: ' + (Date.now() - t0) + 'ms');
  }
}

// ---------- On-Demand: سحب الفصل مباشرة عند عدم وجوده ----------
async function fetchOnDemand(env, name, num, preferred) {
  const bots = getBots(env);
  if (!bots.length) return { error: 'no Telegram bots configured', status: 500 };
  const bud = makeBudget(env);
  const ad = createAdapters(env, bud);
  const status = await loadStatus(env);
  const g = makeRun(env, bots, bud, cfg(env, 'ON_DEMAND_LIMIT_MS'), status.bot);
  const order = [...SOURCE_NAMES];
  const pi = order.findIndex((s) => s.toLowerCase() === String(preferred || '').toLowerCase());
  if (pi > 0) order.unshift(order.splice(pi, 1)[0]);

  const problems = [];
  let stopped = false;
  for (const sn of order) {
    if (bud.left() < 6 || timeLeft(g) < Math.min(8000, g.safety * 3)) break;
    try {
      const cands = rankCandidates(await ad[sn].search(name), name).slice(0, 2);
      for (const c of cands) {
        const series = await ad[sn].listChapters(c.slug);
        const ch = series.chapters.find((x) => normChapter(x.num) === num);
        if (!ch) continue;
        const item = { slug: c.slug, manga: name, ch: { num: ch.num, ref: ch.ref }, done: [] };
        const { urls, referer } = await ad[sn].chapterImages(c.slug, item.ch);
        if (!urls.length) throw new Error('no images found');
        if (urls.length > MAX_IMAGES_PER_CHAPTER) throw new Error('too many images: ' + urls.length);
        await uploadRest(g, item, urls, referer);
        await saveChapter(env, [name, series.title], num, sn, item.done);
        env.DB.prepare('UPDATE crawler_status SET bot_index = ? WHERE id = 1').bind(g.cursor).run().catch(() => {});
        return { row: await getRow(env, name, num) };
      }
    } catch (e) {
      problems.push(sn + ': ' + errMsg(e).slice(0, 120));
      if (isStop(e)) { stopped = true; break; }
    }
  }
  if (stopped) return { error: 'chapter is large or rate limited; retry shortly', status: 503, problems };
  return { error: 'chapter not found', status: 404, problems };
}

// ---------- API ----------
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const jsonRes = (o, status = 200, extra = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra } });
const NOSTORE = { 'cache-control': 'no-store' };

function chapterResponse(row, origin) {
  let ids = [];
  try { ids = JSON.parse(row.file_ids); } catch {}
  const images = ids.map((x) => origin + '/tg_file/' + x.b + '/' + x.f);
  return jsonRes(
    { manga_name: row.manga_name, chapter_number: row.chapter_number, source: row.source, count: images.length, images },
    200,
    { 'cache-control': 'max-age=604800' }
  );
}

// GET /fetch_chapter?manga_name=...&chapter_number=...[&source=TeamX]   (أو POST بجسم JSON)
async function handleFetchChapter(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'POST') return jsonRes({ error: 'method not allowed' }, 405, NOSTORE);
  const u = new URL(request.url);
  let name = u.searchParams.get('manga_name'), num = u.searchParams.get('chapter_number'), src = u.searchParams.get('source');
  if (request.method === 'POST') {
    try { const b = await request.json(); name = b.manga_name ?? name; num = b.chapter_number ?? num; src = b.source ?? src; } catch {}
  }
  name = normName(name);
  num = normChapter(num);
  if (!name || !num) return jsonRes({ error: 'manga_name and chapter_number are required' }, 400, NOSTORE);
  try {
    const row = await getRow(env, name, num);
    if (row) return chapterResponse(row, u.origin);
    const r = await fetchOnDemand(env, name, num, src);
    if (r.row) return chapterResponse(r.row, u.origin);
    return jsonRes({ error: r.error, ...(r.problems && r.problems.length ? { details: r.problems } : {}) }, r.status || 404, NOSTORE);
  } catch (e) {
    console.error('fetch_chapter error:', errMsg(e));
    return jsonRes({ error: 'internal error', details: errMsg(e).slice(0, 200) }, 500, NOSTORE);
  }
}

const MIME = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', avif: 'image/avif', gif: 'image/gif' };

async function tgPath(bot, id) {
  const g = await fetch('https://api.telegram.org/bot' + bot.token + '/getFile?file_id=' + encodeURIComponent(id));
  const j = await g.json().catch(() => null);
  return j && j.ok && j.result && j.result.file_path;
}

// GET /tg_file/<bot>/<id>[.<id>...] -> بايتات الصورة (الأجزاء المقسّمة تُجمَّع بالترتيب)
async function handleTgFile(request, env, ctx) {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
  const m = /^\/tg_file\/([1-3])\/([\w-]{10,200}(?:\.[\w-]{10,200}){0,9})$/.exec(new URL(request.url).pathname);
  if (!m) return new Response('bad request', { status: 400 });
  const bot = getBots(env).find((b) => b.n === +m[1]);
  if (!bot) return new Response('not found', { status: 404 });
  const ids = m[2].split('.');

  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const paths = await Promise.all(ids.map((id) => tgPath(bot, id)));
    if (paths.some((p) => !p)) return new Response('file not found', { status: 404 });
    const ext = (paths[0].split('.').pop() || '').toLowerCase();
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': CACHE_WEEK + ', immutable', 'access-control-allow-origin': '*' };
    const url = (p) => 'https://api.telegram.org/file/bot' + bot.token + '/' + p;

    if (paths.length === 1) {
      const f = await fetch(url(paths[0]));
      if (!f.ok) return new Response('upstream ' + f.status, { status: 502 });
      const resp = new Response(f.body, { status: 200, headers });
      ctx.waitUntil(cache.put(request, resp.clone()));
      return resp;
    }
    const { readable, writable } = new TransformStream();
    ctx.waitUntil((async () => {
      try {
        for (const p of paths) {
          const f = await fetch(url(p));
          if (!f.ok || !f.body) throw new Error('upstream ' + f.status);
          await f.body.pipeTo(writable, { preventClose: true });
        }
        await writable.close();
      } catch (e) { try { await writable.abort(e); } catch {} }
    })());
    return new Response(readable, { status: 200, headers });
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

  // ننتظر اكتمال الدورة داخل الدالة نفسها (وليس في الخلفية)
  async scheduled(event, env, ctx) {
    await crawlOnce(env);
  },
};
