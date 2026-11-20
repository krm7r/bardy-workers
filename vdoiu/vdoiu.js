// Cloudflare Worker — Bardy YouTube Video Search API
//
// Quota note: YouTube's search.list costs 100 units per call and the default quota is 10,000 units/day.
// So we fetch up to 50 results ONCE per query (same 100 units), cache them, and serve pages 1..5 from that
// cached list. Without this, every page / repeat query burned another 100 units.
//
// Secrets: YOUTUBE_API_KEY (required) · API_KEY (optional: if set, callers must send it)
// Optional vars: ALLOWED_ORIGIN (default "*"), YOUTUBE_SAFE_SEARCH ("moderate" | "strict" | "none")

const CACHE_TTL_SECONDS = 900;
const FAILURE_TTL_SECONDS = 60;
const FETCH_COUNT = 50;
const MAX_QUERY_LENGTH = 200;
const MAX_LIMIT = 15;

const clean = (value) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function corsHeaders(env) {
  return {
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-API-Key, Authorization',
  };
}

function reply(env, body, status = 200, cacheSeconds = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
      ...corsHeaders(env),
    },
  });
}

function authorized(request, env) {
  const key = String(env.API_KEY || '');
  if (!key) return true;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || request.headers.get('x-api-key') || '';
  if (given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= given.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

function mapItem(x) {
  const id = clean(x.id?.videoId);
  if (!id) return null;
  const s = x.snippet || {};
  const description = clean(s.description).slice(0, 1200);
  return {
    type: 'videos',
    title: clean(s.title),
    url: 'https://www.youtube.com/watch?v=' + id,
    description,
    text: description,
    image_url: clean(s.thumbnails?.high?.url || s.thumbnails?.medium?.url || s.thumbnails?.default?.url),
    image_alt: clean(s.title),
    video_url: 'https://www.youtube.com/watch?v=' + id,
    embed_url: 'https://www.youtube.com/embed/' + id,
    source: 'youtube',
    category: 'video',
    source_id: 'youtube:' + id,
    creator: clean(s.channelTitle),
    date: clean(s.publishedAt),
  };
}

// Returns the cached 50-result list for a query, or fetches it (one 100-unit call).
async function loadResults(q, env, ctx) {
  const cacheKey = new Request('https://youtube-cache.bardy.invalid/v2?q=' + encodeURIComponent(q.toLocaleLowerCase('ar')));
  const hit = await caches.default.match(cacheKey);
  if (hit) return { ...(await hit.json()), cached: true };

  const api = new URL('https://www.googleapis.com/youtube/v3/search');
  api.search = new URLSearchParams({
    part: 'snippet', q, type: 'video', maxResults: String(FETCH_COUNT), relevanceLanguage: 'ar', regionCode: 'EG',
    safeSearch: ['moderate', 'strict', 'none'].includes(env.YOUTUBE_SAFE_SEARCH) ? env.YOUTUBE_SAFE_SEARCH : 'moderate',
    videoEmbeddable: 'true', key: env.YOUTUBE_API_KEY,
  });

  const store = (payload, ttl) => ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}, s-maxage=${ttl}` },
  })));

  let response, data;
  try {
    response = await fetch(api, { signal: AbortSignal.timeout(10000) });
    data = await response.json();
  } catch (error) {
    console.error('youtube_fetch_failed', error instanceof Error ? error.message : String(error));
    const failure = { ok: false, reason: 'unavailable' };
    store(failure, FAILURE_TTL_SECONDS);
    return failure;
  }
  if (!response.ok) {
    const reason = data?.error?.errors?.[0]?.reason || 'http_' + response.status;
    console.error('youtube_api_error', reason); // e.g. quotaExceeded
    const failure = { ok: false, reason };
    store(failure, FAILURE_TTL_SECONDS); // short negative cache: stop retrying a failing/exhausted quota on every request
    return failure;
  }
  const payload = { ok: true, items: (data.items || []).map(mapItem).filter(Boolean) };
  store(payload, CACHE_TTL_SECONDS);
  return payload;
}


// ───────── حماية العامل: خاص بالموقع فقط ─────────
// العامل لا يرد على أي طلب بدون المفتاح السري API_KEY (يرجع 404 عادي كأنه غير موجود)،
// ولا يرسل أي ترويسة CORS، فلا يمكن استدعاؤه من المتصفح ولا من موقع آخر.
function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function isAuthorized(request, env) {
  const secret = String(env.API_KEY || "");
  if (!secret) return false; // لو المفتاح غير مضبوط يُقفل العامل بدل ما يفتح للجميع
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return safeEqual(request.headers.get("X-API-Key") || bearer || "", secret);
}
function notFound() {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export default {
  async fetch(request, env, ctx) {
    if (!isAuthorized(request, env)) return notFound();
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (request.method !== 'GET') return reply(env, { success: false, error: 'Only GET and OPTIONS are supported' }, 405);

    const u = new URL(request.url);
    if (u.pathname === '/health') return reply(env, { success: true, service: 'bardy-youtube-video-api', youtube_enabled: Boolean(env.YOUTUBE_API_KEY), cache_ttl_seconds: CACHE_TTL_SECONDS });
    if (u.pathname === '/' || u.pathname === '/help') return reply(env, { name: 'Bardy YouTube Video Search API', version: '2.0', source: 'youtube' });
    if (u.pathname !== '/api/search') return reply(env, { success: false, error: 'Not found' }, 404);
    if (!authorized(request, env)) return reply(env, { success: false, error: 'Unauthorized' }, 401);
    if (!env.YOUTUBE_API_KEY) return reply(env, { success: false, error: 'YOUTUBE_API_KEY is not configured' }, 503);

    const q = clean(u.searchParams.get('q'));
    if (q.length < 2) return reply(env, { success: false, error: 'Parameter q must contain at least 2 characters' }, 400);
    if (q.length > MAX_QUERY_LENGTH) return reply(env, { success: false, error: `Parameter q is limited to ${MAX_QUERY_LENGTH} characters` }, 400);

    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(u.searchParams.get('limit')) || 10));
    const page = Math.max(1, Math.floor(Number(u.searchParams.get('page')) || 1));

    const result = await loadResults(q, env, ctx);
    if (!result.ok) {
      return reply(env, { success: false, type: 'videos', query: q, page, page_size: 0, count: 0, has_more: false, items: [], error: 'YouTube provider is temporarily unavailable' }, 502);
    }

    const start = (page - 1) * limit;
    const items = result.items.slice(start, start + limit);
    return reply(env, {
      success: true, ok: true, type: 'videos', query: q, page, page_size: items.length, count: items.length,
      has_more: start + limit < result.items.length, items, results: items, sources: ['youtube'],
    }, 200, CACHE_TTL_SECONDS);
  },
};
