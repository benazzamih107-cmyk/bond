// وسيط الواجهة (منقول من manhwa-sit دون تغيير في المنطق)
// المواقع المسموح جلبها نصيًا (HTML/JSON) — أي نطاق آخر مرفوض لمنع إساءة استخدام الوسيط
const TEXT_HOSTS = [
  'olympustaff.com', 'hijala.com', 'azorafly.com', '3asq.online', 'shadowss.net',
  'mangadar.com', 'mangatik.com', 'kawaiimanga.org', 'kawaii-anime.com',
  'mangalik.net', 'mnga4all.com', 'mangatime.org', 'lavascans.com',
];

const hostOk = (host, list) =>
  list.some((h) => host === h || host.endsWith('.' + h));

// يمنع استدعاء الوسيط من مواقع أخرى (يسمح بنفس النطاق فقط)
function sameSite(request) {
  const self = new URL(request.url).host;
  const o = request.headers.get('Origin') || request.headers.get('Referer') || '';
  if (!o) return true; // طلبات <img> بدون Referer
  try { const h = new URL(o).host; return h === self || h === 'localhost'; } catch { return false; }
}

const BLOCK_HDRS = new Set([
  'host', 'content-length', 'connection', 'cookie', 'cf-connecting-ip',
  'x-forwarded-for', 'x-real-ip', 'accept-encoding',
]);

function cleanHeaders(h) {
  const out = new Headers();
  for (const [k, v] of Object.entries(h || {})) {
    if (BLOCK_HDRS.has(k.toLowerCase()) || /^(cf-|sec-|x-forwarded)/i.test(k)) continue;
    try { out.set(k, String(v)); } catch {}
  }
  return out;
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// POST /api/fetch  { url, method, headers, body }  ->  { st, d, h }
// بديل CapacitorHttp في المتصفح: يجلب الصفحة من جهة Cloudflare فلا تظهر مشكلة CORS

async function handleFetch(request) {
  if (!sameSite(request)) return json({ st: 403, d: 'forbidden' }, 403);
  let p;
  try { p = await request.json(); } catch { return json({ st: 400, d: 'bad request' }, 400); }

  let u;
  try { u = new URL(p.url); } catch { return json({ st: 400, d: 'bad url' }, 400); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return json({ st: 400, d: 'bad url' }, 400);
  if (!hostOk(u.hostname, TEXT_HOSTS)) return json({ st: 403, d: 'host not allowed' }, 403);

  const method = p.method === 'POST' ? 'POST' : 'GET';
  const headers = cleanHeaders(p.headers);
  let body;
  if (method === 'POST') {
    if (p.body && typeof p.body === 'object') {
      body = new URLSearchParams(p.body).toString();
      if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
    } else if (typeof p.body === 'string') {
      body = p.body;
    }
  }

  try {
    const r = await fetch(u.toString(), { method, headers, body, redirect: 'follow' });
    const d = await r.text();
    return json({ st: r.status, d, h: { 'content-type': r.headers.get('content-type') || '' } });
  } catch (e) {
    return json({ st: 0, d: String((e && e.message) || e) }, 200);
  }
}

// GET /api/img?u=<رابط الصورة>&r=<Referer>  ->  بايتات الصورة
// بديل blobFallback: بعض مواقع الصور تحجب الطلب بدون Referer صحيح

const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i;

async function handleImg(request) {
  if (!sameSite(request)) return new Response('forbidden', { status: 403 });
  const q = new URL(request.url).searchParams;
  let u;
  try { u = new URL(q.get('u')); } catch { return new Response('bad url', { status: 400 }); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return new Response('bad url', { status: 400 });
  if (PRIVATE.test(u.hostname) || !u.hostname.includes('.')) return new Response('blocked', { status: 403 });

  const ref = q.get('r') || '';
  const h = new Headers({
    'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
    Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
  });
  if (/^https?:\/\//.test(ref)) h.set('Referer', ref);

  try {
    const r = await fetch(u.toString(), { headers: h, redirect: 'follow', cf: { cacheEverything: true, cacheTtl: 86400 } });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\//i.test(ct)) return new Response('upstream ' + r.status, { status: r.ok ? 415 : r.status });
    return new Response(r.body, {
      status: 200,
      headers: { 'content-type': ct, 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' },
    });
  } catch {
    return new Response('fetch failed', { status: 502 });
  }
}

// POST /api/imgs { urls:[...], r:<Referer>, ua:<User-Agent> } -> طلب واحد يرجع عدة صور مجمّعة
// الإطار لكل صورة: [ok u8][ctLen u8][content-type][len u32 BE][bytes]  (ok=0 عند الفشل)
async function handleImgs(request) {
  if (!sameSite(request)) return new Response('forbidden', { status: 403 });
  let p;
  try { p = await request.json(); } catch { return new Response('bad request', { status: 400 }); }
  const urls = Array.isArray(p.urls) ? p.urls.slice(0, 12) : [];
  if (!urls.length) return new Response('empty', { status: 400 });
  const ref = typeof p.r === 'string' && /^https?:\/\//.test(p.r) ? p.r : '';
  const ua = typeof p.ua === 'string' && p.ua.length < 300 ? p.ua : (request.headers.get('User-Agent') || 'Mozilla/5.0');
  const got = await Promise.all(urls.map(async (u) => {
    try {
      const x = new URL(u);
      if ((x.protocol !== 'https:' && x.protocol !== 'http:') || !hostOk(x.hostname, TEXT_HOSTS)) return null;
      const h = new Headers({ 'User-Agent': ua, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' });
      if (ref) h.set('Referer', ref);
      const r = await fetch(x.toString(), { headers: h, redirect: 'follow' });
      const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
      if (!r.ok || !/^image\//i.test(ct)) return null;
      return { ct, buf: new Uint8Array(await r.arrayBuffer()) };
    } catch { return null; }
  }));
  const enc = new TextEncoder();
  const parts = [];
  for (const g of got) {
    if (!g) { parts.push(new Uint8Array([0, 0, 0, 0, 0, 0])); continue; }
    const ct = enc.encode(g.ct).slice(0, 60);
    const head = new Uint8Array(2 + ct.length + 4);
    head[0] = 1; head[1] = ct.length; head.set(ct, 2);
    new DataView(head.buffer).setUint32(2 + ct.length, g.buf.length);
    parts.push(head, g.buf);
  }
  return new Response(new Blob(parts), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
  });
}

// يعيد Response إن كان المسار من مسارات الوسيط، وإلا null
export async function handleProxy(request) {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/fetch' && request.method === 'POST') return handleFetch(request);
  if (pathname === '/api/img' && request.method === 'GET') return handleImg(request);
  if (pathname === '/api/imgs' && request.method === 'POST') return handleImgs(request);
  if (pathname.startsWith('/api/')) return new Response('not found', { status: 404 });
  return null;
}
