// Cloudflare Worker — Bardy Images API
// Environment variables:
// FIRECRAWL_API_KEY (optional legacy key)
// FIRECRAWL_API_KEY_1 ... FIRECRAWL_API_KEY_5 (recommended)
// FIRECRAWL_API_KEYS (optional comma/newline-separated fallback list)

const BLOCKED_WORDS = [
  // English
  'porn', 'porno', 'pornography', 'xxx', 'nsfw', 'n s f w', 'nude', 'nudes',
  'nudity', 'naked', 'nakedness', 'sexual', 'sex', 'sexy', 'erotic',
  'erotica', 'adult', 'adults only', 'adult content', 'hentai', 'explicit',
  'hardcore', 'softcore', 'camgirl', 'cam girls', 'escort', 'prostitute',
  'prostitution', 'onlyfans', 'fetish', 'bdsm', 'bondage', 'stripper',
  'strip club', 'playboy', 'xxx video', 'sex video', 'sex scene',
  // Arabic and common transliterations
  'سكس', 'جنس', 'جنسي', 'جنسية', 'عاري', 'عري', 'عارية', 'إباحية', 'اباحية',
  'إباحي', 'اباحي', 'للبالغين', 'محتوى للبالغين', 'مثير جنسيا', 'مثير جنسيًا',
  'فاحش', 'فحش', 'خادش للحياء', 'دعارة', 'عاهرة', 'بغاء', 'مومس', 'رقص تعري',
  'تعري', 'مواقع اباحية', 'مواقع إباحية', 'فيديو جنسي', 'صور عارية',
  'هنتاي', 'بورن', 'إكس إكس إكس', 'xxx',
].map(normWord);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
  'X-Content-Type-Options': 'nosniff',
};

function clean(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normWord(value) {
  return clean(value)
    .toLocaleLowerCase('ar')
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ؤئ]/g, 'ء')
    .replace(/[^\u0600-\u06FFa-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBlocked(value) {
  const text = ` ${normWord(value)} `;
  return BLOCKED_WORDS.some(word => word && text.includes(` ${word} `));
}

function short(value, length) {
  return clean(value).slice(0, length);
}

function validUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

// Images must be https: the site is served over https, so browsers silently block http images (mixed content).
function validImageUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

// If the secret API_KEY is set, callers must send it (Authorization: Bearer ... or X-API-Key).
function authorized(request, env) {
  const key = String(env.API_KEY || '');
  if (!key) return true;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || request.headers.get('x-api-key') || '';
  if (given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= given.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

const MAX_QUERY_LENGTH = 350;

function jsonResponse(data, status = 200, cacheControl = 'no-store', extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      ...CORS,
      ...extra,
    },
  });
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Bardy-Images-Worker/9.0',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body, headers = {}, timeoutMs = 15000) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }, timeoutMs);
}

function makeItem(title, description, imageUrl, sourceUrl) {
  const image = validImageUrl(imageUrl);
  const page = validUrl(sourceUrl);
  const text = `${title || ''} ${description || ''}`;
  if (!image || isBlocked(text)) return null;
  return {
    image_url: image,
    title: short(title || 'Untitled', 100),
    description: short(description || '', 250),
    source_url: page || undefined,
  };
}

function unique(items) {
  const seen = new Set();
  return items.filter(item => item?.image_url && !seen.has(item.image_url) && (seen.add(item.image_url), true));
}

function firecrawlKeys(env) {
  const indexed = Array.from({ length: 5 }, (_, i) => env[`FIRECRAWL_API_KEY_${i + 1}`]);
  const listed = String(env.FIRECRAWL_API_KEYS || '').split(/[\n,]+/);
  return [...new Set([...indexed, env.FIRECRAWL_API_KEY, ...listed].map(x => String(x || '').trim()).filter(Boolean))];
}

async function searchFirecrawl(query, page, limit, env, budgetMs = 7000) {
  const keys = firecrawlKeys(env);
  if (!keys.length) return { items: [], status: 'not_configured', provider: 'firecrawl', attempts: 0 };

  let lastError = 'unknown_error';
  // Each page owns a DISJOINT window of ceil(1.5 x limit) raw results; at most `limit` of them (the reachable ones)
  // are shown. Windows never overlap, so a page never repeats an image from the previous page.
  const windowSize = Math.ceil(limit * 1.5);
  const take = Math.min(100, windowSize * page);
  const deadline = Date.now() + budgetMs;
  let attempts = 0;
  for (let index = 0; index < keys.length; index++) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) break; // not enough time for another attempt
    attempts++;
    try {
      const data = await postJson('https://api.firecrawl.dev/v2/search', {
        query,
        sources: ['images'],
        limit: take,
      }, { Authorization: `Bearer ${keys[index]}` }, remaining);
      const raw = data.data?.images || data.images || [];
      const all = unique(raw
        .filter(item => !(Number(item.imageWidth) && Number(item.imageHeight) && (Number(item.imageWidth) < 200 || Number(item.imageHeight) < 120)))
        .map(item => makeItem(
          item.title || 'Firecrawl image',
          item.description || '',
          item.imageUrl || item.image_url,
          item.url || item.sourceUrl,
        )).filter(Boolean));
      return {
        items: all.slice((page - 1) * windowSize, page * windowSize),
        status: 'ok',
        provider: 'firecrawl',
        key_index: index + 1,
        has_more: all.length > page * windowSize || raw.length >= take,
        attempts,
      };
    } catch (error) {
      lastError = error.message || 'request_failed';
      if (error?.name === 'AbortError') break; // the whole budget is gone
    }
  }
  return { items: [], status: 'all_keys_failed', provider: 'firecrawl', error: lastError, attempts };
}

async function searchWikimedia(query, page, limit, timeoutMs = 6000) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrsearch', query);
  url.searchParams.set('gsrnamespace', '6');
  url.searchParams.set('gsrlimit', String(Math.min(50, limit * page)));
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|extmetadata');
  url.searchParams.set('iiurlwidth', '1000');

  const data = await fetchJson(url.href, {}, timeoutMs);
  const pages = Object.values(data.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  const all = unique(pages.map(pageItem => {
    const info = pageItem.imageinfo?.[0] || {};
    const meta = info.extmetadata || {};
    const description = meta.ImageDescription?.value || meta.Caption?.value || '';
    return makeItem(
      clean(pageItem.title || '').replace(/^File:/i, ''),
      description,
      info.thumburl || info.url,
      `https://commons.wikimedia.org/wiki/${encodeURIComponent(pageItem.title || '')}`,
    );
  }).filter(Boolean));
  return {
    items: all.slice((page - 1) * limit, page * limit),
    status: 'ok',
    provider: 'wikimedia_commons',
    has_more: Boolean(data.continue) || all.length > page * limit,
  };
}

async function searchInternetArchive(query, page, limit, timeoutMs = 6000) {
  const url = new URL('https://archive.org/advancedsearch.php');
  url.searchParams.set('q', `(${query}) AND mediatype:(image)`);
  url.searchParams.set('fl[]', 'identifier');
  url.searchParams.append('fl[]', 'title');
  url.searchParams.append('fl[]', 'description');
  url.searchParams.set('rows', String(Math.min(50, limit * page)));
  url.searchParams.set('page', String(page));
  url.searchParams.set('output', 'json');

  const data = await fetchJson(url.href, {}, timeoutMs);
  const docs = data.response?.docs || [];
  const items = unique(docs.map(doc => {
    const identifier = clean(doc.identifier);
    return makeItem(
      doc.title || identifier,
      Array.isArray(doc.description) ? doc.description.join(' ') : doc.description || '',
      identifier ? `https://archive.org/services/img/${encodeURIComponent(identifier)}` : '',
      identifier ? `https://archive.org/details/${encodeURIComponent(identifier)}` : '',
    );
  }).filter(Boolean));
  const found = Number(data.response?.numFound || 0);
  return {
    items: items.slice(0, limit),
    status: 'ok',
    provider: 'internet_archive',
    has_more: page * limit < found,
  };
}

const TRUSTED_IMAGE_HOSTS = /(^|\.)(wikimedia\.org|archive\.org)$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Reads only the first bytes: confirms the URL answers, is really an image, and is not a tracking pixel / huge file.
// Returns true (good), false (broken) or null (inconclusive).
async function checkImage(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-1023', Accept: 'image/*', 'User-Agent': 'Mozilla/5.0 (compatible; BardyImageCheck/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    const total = Number(String(res.headers.get('content-range') || '').split('/')[1] || res.headers.get('content-length') || 0);
    try { await res.body?.cancel(); } catch {}
    // 401/403/429: many hosts block datacenter IPs yet serve browsers normally → inconclusive, not "broken".
    if ([401, 403, 429].includes(res.status)) return null;
    if (!(res.status === 200 || res.status === 206)) return false;
    if (!type.startsWith('image/') || /icon|svg/.test(type)) return false;
    if (total && (total < 4000 || total > 8_000_000)) return false;
    return true;
  } catch (error) {
    return error?.name === 'TimeoutError' || error?.name === 'AbortError' ? null : false; // timeout = inconclusive, DNS/connection error = dead
  }
}

// Keeps only images that actually load (so the page never shows broken cards). Workers allow ~6 parallel
// subrequests, so the budget is bounded; if too few pass (e.g. a host blocks our IPs) we pad with unchecked ones.
async function keepReachable(items, limit, { perImageMs = 2000, totalMs = 3500 } = {}) {
  const candidates = items.slice(0, Math.ceil(limit * 1.5));
  const verdict = new Array(candidates.length).fill(undefined); // undefined = still running
  const checks = candidates.map((item, i) => (TRUSTED_IMAGE_HOSTS.test(new URL(item.image_url).hostname)
    ? Promise.resolve(true)
    : checkImage(item.image_url, perImageMs)).then(ok => { verdict[i] = ok; }));
  await Promise.race([Promise.all(checks), sleep(totalMs)]);
  const good = candidates.filter((_, i) => verdict[i] === true);
  if (good.length >= Math.min(limit, 5)) return good.slice(0, limit);
  const inconclusive = candidates.filter((_, i) => verdict[i] === null || verdict[i] === undefined); // blocked-for-us, slow, or unchecked
  return [...good, ...inconclusive].slice(0, limit);
}

const FALLBACK_AFTER_MS = 2500; // start the free providers only if Firecrawl is slow or failed

async function run(request, env, ctx) {
  const original = clean(request.searchParams.get('q') || request.searchParams.get('query') || request.searchParams.get('name'));
  if (!original) return jsonResponse({ success: false, type: 'images', error: 'أرسل كلمة البحث في q' }, 400);
  if (original.length > MAX_QUERY_LENGTH) {
    return jsonResponse({ success: false, type: 'images', code: 'query_too_long', max_length: MAX_QUERY_LENGTH, error: `كلمة البحث طويلة، اختصرها إلى ${MAX_QUERY_LENGTH} حرفًا أو أقل` }, 400);
  }
  if (isBlocked(original)) {
    return jsonResponse({ success: false, type: 'images', error: 'لا يمكن تنفيذ هذا البحث' }, 422);
  }

  const page = Math.max(1, parseInt(request.searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(15, Math.max(1, parseInt(request.searchParams.get('limit') || '15', 10) || 15));
  const cacheKey = new Request(`https://images-cache.bardy.invalid/v19?q=${encodeURIComponent(normWord(original))}&page=${page}&limit=${limit}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('X-Bardy-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers });
  }

  // Firecrawl first. If it is slow (> 2.5 s) or fails, Wikimedia Commons and Internet Archive are queried in
  // PARALLEL, so the user waits for the fastest useful answer instead of 15 s x each provider in sequence.
  const shortQuery = original.split(' ').slice(0, 8).join(' ');
  const providers = [];
  const firecrawlPromise = searchFirecrawl(original, page, limit, env, Number(env.FIRECRAWL_BUDGET_MS || 7000)).catch(error => ({ provider: 'firecrawl', status: 'failed', error: error.message, items: [] }));
  let selected = null;
  const early = await Promise.race([firecrawlPromise, sleep(Number(env.IMAGES_FALLBACK_AFTER_MS || FALLBACK_AFTER_MS)).then(() => null)]);
  if (early?.items?.length) {
    providers.push(early);
    selected = early;
  } else {
    const fallbacks = Promise.all([
      searchWikimedia(shortQuery, page, limit).catch(error => ({ provider: 'wikimedia_commons', status: 'failed', error: error.message, items: [] })),
      searchInternetArchive(shortQuery, page, limit).catch(error => ({ provider: 'internet_archive', status: 'failed', error: error.message, items: [] })),
    ]);
    const firecrawl = early || await firecrawlPromise;
    providers.push(firecrawl);
    if (firecrawl.items.length) {
      selected = firecrawl;
    } else {
      const [commons, archive] = await fallbacks;
      providers.push(commons, archive);
      selected = [commons, archive].find(provider => provider.items.length) || firecrawl;
    }
  }

  const items = selected.items.length ? await keepReachable(selected.items, limit, { perImageMs: 2000, totalMs: Number(env.IMAGES_VALIDATE_TOTAL_MS || 3500) }) : [];
  const providerName = selected.provider;

  const out = jsonResponse({
    success: true,
    type: 'images',
    source: providerName,
    source_name: providerName === 'firecrawl' ? 'Firecrawl' : providerName === 'wikimedia_commons' ? 'Wikimedia Commons' : 'Internet Archive',
    query: original,
    search_query: original,
    page,
    limit,
    requested_total: limit,
    total_count: items.length,
    status: items.length ? 'ok' : 'no_results',
    has_more: Boolean(selected.has_more) && items.length > 0,
    pagination: { page, limit, next_page: selected.has_more && items.length ? page + 1 : null, previous_page: page > 1 ? page - 1 : null },
    items,
  }, 200, items.length ? 'public, max-age=900, s-maxage=3600, stale-while-revalidate=300' : 'public, max-age=30, s-maxage=60'); // do not pin an empty/failed result for an hour

  ctx?.waitUntil?.(caches.default.put(cacheKey, out.clone()));
  return out;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return jsonResponse({ success: false, error: 'استخدم GET فقط' }, 405);

    const url = new URL(request.url);
    if (['/', '/images', '/api/images', '/search'].includes(url.pathname)) {
      if (url.pathname !== '/' && !authorized(request, env) || (url.pathname === '/' && url.searchParams.has('q') && !authorized(request, env))) return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
      try {
        return await run(url, env, ctx);
      } catch {
        return jsonResponse({ success: false, type: 'images', items: [], error: 'حدث خطأ أثناء البحث في المصادر المتاحة' }, 502);
      }
    }

    return jsonResponse({
      success: true,
      service: 'Bardy Images API',
      sources: ['firecrawl', 'wikimedia_commons', 'internet_archive'],
      endpoints: ['/images?q=جبال', '/images?q=جبال&limit=10', '/images?q=جبال&page=2'],
    });
  },
};
