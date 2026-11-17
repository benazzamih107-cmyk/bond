// محوّلات المصادر الأربعة: TeamX, Hijala, Azora, MangaTime
// كل مصدر يوفّر:
//   listManga(page, cursor)      -> { items: [{ slug, title }], nextCursor }
//   listChapters(slug)           -> { title, chapters: [{ num, ref }] }  (تصاعدي)
//   chapterImages(slug, chapter) -> { urls: [...], referer }

export const SOURCES = ['TeamX', 'Hijala', 'Azora', 'MangaTime'];

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const MAX_SERIES_PAGES = 15;

// ---------- أدوات عامة ----------
export async function getText(url, referer) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ar,en;q=0.8',
      ...(referer ? { Referer: referer } : {}),
    },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.text();
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmt = (v) => String(Number.isInteger(+v) ? parseInt(v, 10) : +v);
const isNum = (s) => /^\d+(\.\d+)?$/.test(String(s));

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEnt = (s) =>
  String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const clean = (s) =>
  decodeEnt(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/[\u2066-\u2069\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();

const abs = (u, base) => { try { return new URL(u, base).href; } catch { return ''; } };
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const sortAsc = (arr) => arr.sort((a, b) => +a.num - +b.num);

function attrs(tag) {
  const o = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) o[m[1].toLowerCase()] = decodeEnt(m[2] ?? m[3] ?? '');
  return o;
}
const imgTags = (html) => [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => attrs(m[0]));
function imgSrc(a) {
  for (const k of ['data-src', 'data-lazy-src', 'data-original', 'src']) {
    const v = (a[k] || '').trim();
    if (v && !v.startsWith('data:')) return v;
  }
  for (const k of ['data-srcset', 'srcset']) {
    const v = (a[k] || '').trim();
    if (v) { const c = v.split(',')[0].trim().split(' ')[0]; if (c && !c.startsWith('data:')) return c; }
  }
  return '';
}
const anchors = (html) =>
  [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({ a: attrs('<a ' + m[1] + '>'), inner: m[2] }));
const h1Text = (html) => { const m = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html); return m ? clean(m[1]) : ''; };
const metaContent = (html, prop) => {
  const m = new RegExp('<meta[^>]+(?:property|name)=["\']' + esc(prop) + '["\'][^>]*>', 'i').exec(html);
  return m ? (attrs(m[0]).content || '') : '';
};
const uniq = (arr) => [...new Set(arr)];

// ====================== TeamX (olympustaff.com) ======================
const OL = 'https://olympustaff.com';
const TeamX = {
  referer: OL + '/',
  async listManga(page) {
    const html = await getText(OL + '/series?page=' + page, OL + '/');
    const slugs = uniq([...html.matchAll(/href=["'](?:https?:\/\/(?:www\.)?olympustaff\.com)?\/series\/([^\/"'?#]+)\/?["']/gi)].map((m) => dec(m[1])));
    return { items: slugs.map((s) => ({ slug: s, title: s })), nextCursor: null };
  },
  async listChapters(slug) {
    const url = OL + '/series/' + encodeURIComponent(slug);
    const html = await getText(url, OL + '/');
    const title = h1Text(html) || clean(metaContent(html, 'og:title').replace(' - مانجا مترجمة', '')) || slug;
    const re = new RegExp('/series/' + esc(encodeURIComponent(slug)) + '/(\\d+(?:\\.\\d+)?)/?(?:["\'?#])', 'gi');
    const reRaw = new RegExp('/series/' + esc(slug) + '/(\\d+(?:\\.\\d+)?)/?(?:["\'?#])', 'gi');
    const nums = new Set();
    const collect = (h) => { let n = 0; for (const rx of [re, reRaw]) for (const m of h.matchAll(rx)) if (!nums.has(m[1])) { nums.add(m[1]); n++; } return n; };
    collect(html);
    let mode = 'q';
    const pg = (p) => (mode === 'q' ? url + '?page=' + p : url + '/page/' + p + '/');
    for (let p = 2; p <= MAX_SERIES_PAGES; p++) {
      let added = 0;
      try { added = collect(await getText(pg(p), OL + '/')); } catch { added = 0; }
      if (!added && p === 2 && mode === 'q') {
        mode = 'path';
        try { added = collect(await getText(pg(p), OL + '/')); } catch { added = 0; }
      }
      if (!added) break;
    }
    return { title, chapters: sortAsc([...nums].map((n) => ({ num: fmt(n), ref: n }))) };
  },
  async chapterImages(slug, ch) {
    const html = await getText(OL + '/series/' + encodeURIComponent(slug) + '/' + ch.ref, OL + '/');
    const out = [];
    for (const a of imgTags(html)) {
      const s = imgSrc(a);
      if (s && (s.includes('/uploads/manga') || s.includes('/series/') || a.alt === 'image of episode')) {
        const f = abs(s, OL);
        if (f && !out.includes(f)) out.push(f);
      }
    }
    return { urls: out, referer: OL + '/' };
  },
};

// ====================== Hijala (hijala.com) ======================
const HJ = 'https://hijala.com';
const HJ_SKIP = new Set('manga genres page blog bookmark call-us terms-of-use-and-copyright privacy-policy wp-content wp-json wp-admin author tag feed test cdn-cgi series az-list'.split(' '));
const validSlug = (v) => /^[\w\-.'!’,()~*]+$/.test(v || '');

function hjImagesFromScripts(html) {
  for (const sc of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const t = sc[1];
    if (!t.includes('"images"')) continue;
    const at = t.search(/"images"\s*:\s*\[/);
    if (at < 0) continue;
    const a = t.indexOf('[', at);
    let dep = 0, q = false, end = -1;
    for (let k = a; k < t.length; k++) {
      const ch = t[k];
      if (q) { if (ch === '\\') k++; else if (ch === '"') q = false; }
      else if (ch === '"') q = true;
      else if (ch === '[') dep++;
      else if (ch === ']') { dep--; if (!dep) { end = k; break; } }
    }
    if (end < 0) continue;
    try { const arr = JSON.parse(t.slice(a, end + 1)).map(String); if (arr.length) return arr; } catch {}
  }
  return [];
}

const Hijala = {
  referer: HJ + '/',
  async listManga(page) {
    const html = await getText(HJ + '/manga/?page=' + page + '&order=title', HJ + '/');
    const seen = new Map();
    for (const { a, inner } of anchors(html)) {
      const href = a.href;
      if (!href) continue;
      let u; try { u = new URL(href, HJ); } catch { continue; }
      if (u.hostname.replace('www.', '') !== 'hijala.com') continue;
      const m = /^\/([^\/?#]+)\/?$/.exec(u.pathname);
      if (!m) continue;
      const slug = dec(m[1]);
      if (HJ_SKIP.has(slug) || !validSlug(slug)) continue;
      const im = /<img\b[^>]*>/i.exec(inner);
      const title = clean(a.title) || (im ? clean(attrs(im[0]).alt) : '');
      if (!title) continue;
      if (!seen.has(slug)) seen.set(slug, title);
    }
    return { items: [...seen].map(([slug, title]) => ({ slug, title })), nextCursor: null };
  },
  async listChapters(slug) {
    const html = await getText(HJ + '/' + encodeURIComponent(slug) + '/', HJ + '/');
    const title = h1Text(html) || slug;
    const map = new Map();
    for (const m of html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
      if (!/data-num=/.test(m[1])) continue;
      const am = /<a\b[^>]*href=["']([^"']+)["']/i.exec(m[2]);
      if (!am) continue;
      let n = (attrs('<li ' + m[1] + '>')['data-num'] || '').trim();
      const href = abs(am[1], HJ);
      if (!isNum(n)) {
        const mm = /-(\d+(?:-\d+)?)\/?$/.exec(dec(new URL(href).pathname));
        n = mm ? mm[1].replace('-', '.') : '';
      }
      if (isNum(n) && !map.has(fmt(n))) map.set(fmt(n), href);
    }
    if (!map.size) {
      const re = new RegExp('/' + esc(slug) + '-(\\d+(?:-\\d+)?)/?$');
      for (const { a } of anchors(html)) {
        if (!a.href) continue;
        const u = new URL(abs(a.href, HJ));
        const mm = re.exec(dec(u.pathname));
        if (mm) { const k = fmt(mm[1].replace('-', '.')); if (!map.has(k)) map.set(k, u.href); }
      }
    }
    return { title, chapters: sortAsc([...map].map(([num, ref]) => ({ num, ref }))) };
  },
  async chapterImages(slug, ch) {
    const html = await getText(ch.ref || HJ + '/' + encodeURIComponent(slug) + '-' + ch.num.replace('.', '-') + '/', HJ + '/');
    let list = hjImagesFromScripts(html);
    if (!list.length) {
      const i = html.search(/id=["']readerarea["']/i);
      const seg = i >= 0 ? html.slice(i) : html;
      list = imgTags(seg).map(imgSrc).filter(Boolean);
    }
    const out = [];
    for (const s of list) {
      const f = abs(s.trim(), HJ).replace(/^http:\/\//i, 'https://').replace(/^https:\/\/www\.hijala\.com/i, 'https://hijala.com');
      const low = f.toLowerCase();
      if (!f || out.includes(f) || low.endsWith('.svg') || low.includes('cropped-') || low.includes('/logo')) continue;
      out.push(f);
    }
    return { urls: out, referer: HJ + '/' };
  },
};

// ====================== Azora (azorafly.com) ======================
const AZ = 'https://azorafly.com';
const azSeriesUrl = (s) => AZ + '/series/' + encodeURIComponent(s).replace(/%27/g, "'").replace(/%21/g, '!');
const azSrc = (a) => {
  let s = imgSrc(a);
  if (s && s.includes('/_next/image')) {
    try { const q = new URL(s, AZ).searchParams.get('url'); if (q) s = q; } catch {}
  }
  return s;
};

const Azora = {
  referer: AZ + '/',
  async listManga(page) {
    const html = await getText(AZ + '/series/?page=' + page, AZ + '/');
    const map = new Map();
    for (const { a, inner } of anchors(html)) {
      if (!a.href) continue;
      let u; try { u = new URL(a.href, AZ); } catch { continue; }
      if (u.hostname.replace('www.', '') !== 'azorafly.com') continue;
      const m = /^\/series\/([^\/?#]+)\/?$/.exec(dec(u.pathname));
      if (!m || !validSlug(m[1])) continue;
      const im = /<img\b[^>]*>/i.exec(inner);
      const alt = im ? clean(attrs(im[0]).alt).replace(/^Cover of\s+/, '') : '';
      const t = clean(a.title) || alt;
      if (!map.has(m[1]) || (t && !map.get(m[1]))) map.set(m[1], t);
    }
    if (map.size < 6) {
      const raw = html.replace(/\\"/g, '"').replace(/\\\//g, '/');
      for (const m of raw.matchAll(/"slug":"([^"\\]{1,120})"/g)) {
        if (!map.has(m[1]) && validSlug(m[1]) && raw.includes('/series/' + m[1])) map.set(m[1], '');
      }
    }
    return { items: [...map].map(([slug, title]) => ({ slug, title: title || slug.replace(/[-_]+/g, ' ') })), nextCursor: null };
  },
  async listChapters(slug) {
    const html = await getText(azSeriesUrl(slug), AZ + '/');
    let title = h1Text(html) || clean(metaContent(html, 'og:title')) || slug;
    const nums = new Set();
    const raw = html.replace(/\\\//g, '/');
    for (const f of new Set([slug, encodeURIComponent(slug), encodeURIComponent(slug).replace(/%27/g, "'").replace(/%21/g, '!')])) {
      const re = new RegExp('/series/' + esc(f) + '/chapter-(\\d+(?:\\.\\d+)?)(?![\\d.])', 'g');
      for (const m of raw.matchAll(re)) nums.add(fmt(m[1]));
    }
    return { title, chapters: sortAsc([...nums].map((n) => ({ num: n, ref: n }))) };
  },
  async chapterImages(slug, ch) {
    const html = await getText(azSeriesUrl(slug) + '/chapter-' + ch.ref, azSeriesUrl(slug));
    const out = [];
    const push = (s, strict) => {
      if (!s) return;
      const f = abs(s.trim(), AZ), low = f.toLowerCase();
      if (!f || low.endsWith('.svg') || low.includes('/featured/') || low.includes('chapter-featured') || /logo|avatar|favicon/.test(low)) return;
      if (strict && !low.includes('/upload/series/')) return;
      if (!low.includes('/public/') && !out.includes(f)) out.push(f);
    };
    const tags = imgTags(html);
    for (const a of tags) {
      const s = azSrc(a);
      if (s && (/page\s*\d+/i.test(a.alt || '') || s.toLowerCase().includes('page-') || /\/WP-manga\/data\//i.test(s))) push(s, false);
    }
    if (!out.length) for (const a of tags) push(azSrc(a), true);
    if (!out.length) {
      for (const m of html.matchAll(/https:\\?\/\\?\/storage\.azorafly\.com[^"'\s\\]*?\.(?:webp|jpe?g|png)/g)) push(m[0].replace(/\\\//g, '/'), true);
    }
    if (!out.length) {
      const raw = html.replace(/\\u002[Ff]/g, '/').replace(/\\\//g, '/');
      const junk = ['featured', 'logo', 'avatar', 'icon', 'banner', 'favicon', 'sprite', 'emoji'];
      for (const m of raw.matchAll(/https?:\/\/[A-Za-z0-9.\-]*azorafly\.com\/[^"'\s\\)>&]+?\.(?:webp|jpe?g|png|avif)/gi)) {
        if (!junk.some((j) => m[0].toLowerCase().includes(j))) push(m[0], false);
      }
    }
    return { urls: out, referer: AZ + '/' };
  },
};

// ====================== MangaTime (mangatime.org) — tRPC ======================
const MG = 'https://mangatime.org';
const MG_API = MG + '/api/trpc';
const MG_IMG = '?w=800&format=webp&q=72';
const mgOk = (s) => typeof s === 'string' && /^[^\s\/?#]+$/.test(s);

async function mgCall(calls) {
  const names = calls.map((c) => c[0]).join(',');
  const inp = {};
  calls.forEach((c, i) => { inp[i] = { json: c[1] || {} }; });
  const txt = await getText(MG_API + '/' + names + '?batch=1&input=' + encodeURIComponent(JSON.stringify(inp)), MG + '/');
  let r; try { r = JSON.parse(txt); } catch { throw new Error('MangaTime: invalid JSON'); }
  const arr = Array.isArray(r) ? r : [r];
  return calls.map((c, i) => {
    const x = arr[i];
    if (!x) throw new Error('MangaTime: empty response');
    if (x.error) {
      const d = (x.error.json && x.error.json.data) || x.error.data || {};
      throw new Error('MangaTime: ' + (d.code || d.httpStatus || 'error'));
    }
    const d = x.result && x.result.data;
    return d && d.json !== undefined ? d.json : d;
  });
}
const mgOne = async (p, i) => (await mgCall([[p, i]]))[0];

function mgItems(v, d = 0) {
  if (!v || d > 4) return [];
  const ok = (x) => x && typeof x === 'object' && mgOk(x.slug) && (x.nameEn || x.title || x.nameAr) && x.seriesCount === undefined;
  if (Array.isArray(v)) {
    if (v.some(ok)) return v.filter(ok);
    for (const x of v) { const r = mgItems(x, d + 1); if (r.length) return r; }
    return [];
  }
  if (typeof v === 'object') {
    for (const k of ['items', 'works', 'results', 'series', 'data']) {
      if (Array.isArray(v[k])) { const r = mgItems(v[k], d + 1); if (r.length) return r; }
    }
    for (const k of Object.keys(v)) {
      if (k === 'genres' || k === 'filters' || k === 'meta') continue;
      const r = mgItems(v[k], d + 1); if (r.length) return r;
    }
  }
  return [];
}

function mgPageUrls(j, id) {
  const re = /\.(webp|jpe?g|png|avif|gif)(\?|#|$)/i;
  const toUrl = (x) => {
    let s = null;
    if (typeof x === 'string') s = x;
    else if (x && typeof x === 'object') {
      for (const k of ['url', 'src', 'path', 'imageUrl', 'image', 'file', 'filename', 'name', 'key']) {
        if (typeof x[k] === 'string' && (re.test(x[k]) || x[k].includes('/uploads/'))) { s = x[k]; break; }
      }
    }
    if (!s || !(re.test(s) || s.includes('/uploads/'))) return null;
    if (/^https?:\/\//i.test(s) || s[0] === '/') return abs(s, MG);
    return MG + '/uploads/chapters/' + id + '/' + s;
  };
  let best = [];
  const walk = (v, d) => {
    if (!v || d > 5) return;
    if (Array.isArray(v)) {
      const us = v.map(toUrl);
      if (us.length && us.every(Boolean) && us.length > best.length) best = us;
      v.forEach((x) => { if (x && typeof x === 'object') walk(x, d + 1); });
    } else if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (k === 'nextChapter' || k === 'prevChapter' || k === 'pageDimensions') continue;
        walk(v[k], d + 1);
      }
    }
  };
  walk(j, 0);
  return best;
}

const MangaTime = {
  referer: MG + '/',
  // الترقيم بالمؤشر: cursor للصفحة الحالية، وnextCursor للتالية
  async listManga(page, cursor) {
    if (page > 1 && !cursor) return { items: [], nextCursor: null };
    const inp = { feed: 'mixed', genres: [], completionStatus: [], sort: 'popular', limit: 24 };
    if (cursor) inp.cursor = cursor;
    const j = await mgOne('search.searchWorks', inp);
    const nc = j && (j.nextCursor || (j.pageInfo && j.pageInfo.nextCursor)) || null;
    const items = mgItems(j)
      .filter((m) => m.type !== 'novel' && m.kind !== 'novel')
      .map((m) => ({ slug: m.slug, title: clean(m.nameEn || m.title || m.nameAr || m.slug) }));
    return { items, nextCursor: nc };
  },
  async listChapters(slug) {
    const s = await mgOne('content.getSeriesBySlug', { slug });
    if (!s || !s.id) throw new Error('MangaTime: series not found');
    const c = await mgOne('content.getChapters', { seriesId: s.id, limit: -1, includeUnavailable: true });
    let chs = Array.isArray(c && c.chapters) ? c.chapters : Array.isArray(c) ? c : [];
    chs = chs.filter((x) => x && x.id && x.number != null && !isNaN(+x.number) && !x.isBlocked && (!x.format || x.format === 'images'));
    const ar = chs.filter((x) => !x.language || x.language === 'ar');
    if (ar.length) chs = ar;
    const ids = new Map();
    for (const x of chs) {
      const k = fmt(x.number);
      const locked = !!x.isPremium && x.isUnlocked !== true;
      if (locked) continue; // الفصول المدفوعة تُتجاهل
      if (!ids.has(k)) ids.set(k, { id: x.id, pc: +x.pageCount || 0 });
    }
    return {
      title: clean(s.nameEn || s.title || s.nameAr || slug),
      chapters: sortAsc([...ids].map(([num, ref]) => ({ num, ref }))),
    };
  },
  async chapterImages(slug, ch) {
    const m = ch.ref;
    let urls = [], pc = m.pc;
    try {
      const j = await mgOne('content.getChapterPagesWeb', { seriesSlug: slug, chapterNumber: +ch.num });
      urls = mgPageUrls(j, m.id);
      if (!(pc > 0)) pc = +(j && j.pageCount) || (Array.isArray(j && j.pageDimensions) ? j.pageDimensions.length : 0);
    } catch {}
    if (urls.length) return { urls: urls.map((u) => (u.startsWith(MG + '/uploads/') && !u.includes('?') ? u + MG_IMG : u)), referer: MG + '/' };
    const out = [];
    for (let i = 1; i <= pc; i++) out.push(MG + '/uploads/chapters/' + m.id + '/' + String(i).padStart(3, '0') + '.webp' + MG_IMG);
    return { urls: out, referer: MG + '/' };
  },
};

export const ADAPTERS = { TeamX, Hijala, Azora, MangaTime };
