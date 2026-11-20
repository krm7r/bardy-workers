// لا يُسمح بأي Origin: leeg يُستدعى من الخادم (Pages Function) فقط، وليس من المتصفح.
const ALLOWED_ORIGINS = new Set([]);

const RESULT_LIMIT = 10;
const NEWS_RESULT_LIMIT = 50;
const IMAGE_LIMIT = 10;
const INFO_PAGE_SIZE = 10;
const INFO_LIMIT = 10;
const MAX_INFO_ITEMS = 32;
const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_SECONDS = 300;
const CACHE_S_MAXAGE_SECONDS = 300;
const PROVIDER_TIMEOUT_MS = 15000; // default for plain search providers
// Per-route limits: Firecrawl-backed routes (web, images) are slower than YouTube / Sheets / Wikipedia.
const ROUTE_TIMEOUT_MS = { web: 20000, images: 25000, videos: 12000, news: 15000, info: 15000, events: 12000 };
const ANSWERS_TIMEOUT_MS = 30000; // AI answers may run search tools first
const MAX_ANSWER_QUERY_LENGTH = 1000;
// حدود الاستعلام لكل نوع. الإجابات لا تُقيَّد عمليًا (حتى 1000 حرف).
const ROUTE_QUERY_LIMITS = { web: 350, images: 350, videos: 200, events: 200 };
const FAILURE_CACHE_SECONDS = 20; // short negative cache: avoids hammering a failing provider
const MAX_ANSWER_SOURCES = 6;

const PROVIDERS = {
  web: { type: "web", urlSecret: "WEB_API_URL", keySecret: "WEB_API_KEY" },
  answers: { type: "answers", urlSecret: "ANSWERS_API_URL", keySecret: "ANSWERS_API_KEY" },
  info: { type: "info", urlSecret: "INFO_API_URL", keySecret: "INFO_API_KEY" },
  images: { type: "images", urlSecret: "IMAGES_API_URL", keySecret: "IMAGES_API_KEY" },
  videos: { type: "videos", urlSecret: "VIDEOS_API_URL", keySecret: "VIDEOS_API_KEY" },
  news: { type: "news", urlSecret: "NEWS_API_URL", keySecret: "NEWS_API_KEY" },
  events: { type: "events", urlSecret: "EVENTS_API_URL", keySecret: "EVENTS_API_KEY" },
};

function responseHeaders(request, extra = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Bardy-Key",
    ...extra,
  };
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

function json(request, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders(request, extra) });
}

function cleanText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanText(value).toLocaleLowerCase("ar").normalize("NFKC").replace(/[\u064B-\u065F\u0670]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[^\u0600-\u06FFa-z0-9]+/gi, " ").replace(/\s+/g, " ").trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$|ref_src$)/i.test(key)) url.searchParams.delete(key);
    url.pathname = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
    return url.toString();
  } catch {
    return cleanText(value).toLowerCase();
  }
}

function hostSource(value) {
  try { return new URL(String(value || "")).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function unifiedInfoItem(item) {
  const description = cleanText(item?.description || item?.text).slice(0, 2500).trim();
  const url = cleanText(item?.url);
  return {
    // المفتاح ٢ يعيد ترتيبًا ثابتًا: info ثم image ثم info ثم video.
    // لا نعيد تصنيف العناصر هنا حتى لا تتحول الصور والفيديوهات إلى info.
    type: ["info", "image", "video"].includes(item?.type) ? item.type : "info",
    title: cleanText(item?.title),
    url,
    description,
    text: description,
    image_url: cleanText(item?.image_url),
    image_alt: cleanText(item?.image_alt || item?.title),
    source: cleanText(item?.source) || hostSource(url),
    source_id: cleanText(item?.source_id),
  };
}

function genericItem(item, type) {
  const description = cleanText(item?.description || item?.snippet || item?.summary || item?.content || item?.excerpt || item?.answer).trim();
  const url = cleanText(item?.url || item?.link || item?.source_url || item?.web_url || item?.watch_url || item?.pageUrl || item?.videoUrl);
  return {
    type,
    title: cleanText(item?.title || item?.name || item?.headline || item?.label),
    url,
    description,
    text: cleanText(item?.text).trim(),
    image_url: cleanText(item?.image_url || item?.image || item?.thumbnail || item?.thumbnail_url || item?.cover || item?.url_to_image),
    image_alt: cleanText(item?.image_alt || item?.alt || item?.title),
    video_url: cleanText(item?.video_url || item?.videoUrl || item?.watch_url),
    source: cleanText(typeof item?.source === "object" ? item.source.name : item?.sourceName || item?.source || item?.domain) || hostSource(url),
    category: cleanText(item?.category),
    source_id: cleanText(item?.source_id || item?.page_id || item?.id),
  };
}

function imageSource(item) {
  const value = `${item?.source || ""} ${item?.image_url || item?.url || ""}`.toLowerCase();
  if (value.includes("archive.org")) return "Internet Archive";
  if (value.includes("wikimedia.org") || value.includes("commons")) return "Wikimedia Commons";
  return cleanText(item?.source) || "مصدر الصور";
}

function imageItem(item, source = "") {
  return {
    type: "image",
    title: cleanText(item?.title || item?.name || "صورة بدون عنوان"),
    image_url: cleanText(item?.image_url || item?.url || item?.thumbnail || item?.thumbnail_url),
    source: source || imageSource(item),
  };
}

function answerItem(payload, query) {
  const answer = cleanText(payload?.answer || payload?.response || payload?.text);
  return {
    type: "answers",
    title: "إجابة بردي",
    url: "",
    description: answer.slice(0, 12000),
    text: answer.slice(0, 12000),
    image_url: "",
    image_alt: "",
    source: "noisy",
    source_id: `noisy:${query}`,
  };
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  for (const field of ["items", "results", "data", "answers", "articles", "images", "videos", "news", "webPages"]) {
    if (Array.isArray(payload?.[field])) return payload[field];
    if (Array.isArray(payload?.[field]?.value)) return payload[field].value;
  }
  return [];
}

function dedupeItems(items) {
  const seenUrl = new Set(), seenId = new Set(), seenDescription = new Set();
  return items.filter((item) => {
    const url = normalizeUrl(item.url), id = cleanText(item.source_id), description = normalizeText(item.description);
    if ((url && seenUrl.has(url)) || (id && seenId.has(id)) || (description && seenDescription.has(description))) return false;
    if (url) seenUrl.add(url);
    if (id) seenId.add(id);
    if (description) seenDescription.add(description);
    return true;
  });
}

function buildProviderUrl(rawUrl, query, page, type, filters = {}) {
  const url = new URL(rawUrl);
  // Some source Workers expose health/help at the root and search under a typed API path.
  // Keep existing full URLs untouched, but route root URLs to their real search endpoints.
  const rootPaths = { videos: '/api/search', news: '/api/news', events: '/events' };
  if ((url.pathname === '/' || url.pathname === '') && rootPaths[type]) url.pathname = rootPaths[type];
  if (query) url.searchParams.set("q", query);
  url.searchParams.set("page", String(page));
  if (filters.category) url.searchParams.set("category", filters.category);
  if (filters.source) url.searchParams.set("source", filters.source);
  if (type !== "info") {
    const providerLimit = type === "images" ? IMAGE_LIMIT : type === "news" ? NEWS_RESULT_LIMIT : RESULT_LIMIT;
    url.searchParams.set("limit", String(providerLimit));
    url.searchParams.set("page_size", String(providerLimit));
  }
  return url;
}

function providerHeaders(apiKey) {
  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers["X-API-Key"] = apiKey;
  }
  return headers;
}

async function fetchJson(url, apiKey, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: providerHeaders(apiKey), signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonPost(url, body, apiKey, timeoutMs = ANSWERS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { ...providerHeaders(apiKey), "Content-Type": "application/json" };
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function emptyResult(type, query, page, success = true, error = "") {
  return { success, type, query, page, page_size: type === "info" ? INFO_PAGE_SIZE : type === "images" ? IMAGE_LIMIT : type === "news" ? NEWS_RESULT_LIMIT : RESULT_LIMIT, count: 0, has_more: false, items: [], ...(error ? { error } : {}) };
}

// Sanitizes the sources returned by the answers provider so the UI can show real, clickable citations.
function sanitizeAnswerSources(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const [position, item] of list.entries()) {
    let url = "";
    try { const parsed = new URL(String(item?.url || "")); if (parsed.protocol === "https:" || parsed.protocol === "http:") url = parsed.href; } catch {}
    const title = cleanText(item?.title).slice(0, 200);
    if (!url || !title) continue;
    out.push({ id: String(item?.id || position + 1), title, source: cleanText(item?.source) || hostSource(url), url, text: cleanText(item?.text || item?.description).slice(0, 600) });
    if (out.length >= MAX_ANSWER_SOURCES) break;
  }
  return out;
}

async function callProvider(request, env, route, query, page, filters = {}) {
  const provider = PROVIDERS[route];
  const apiUrl = env[provider.urlSecret];
  if (route === "answers") {
    try {
      const answerUrl = new URL(apiUrl);
      if (answerUrl.pathname === "/" || answerUrl.pathname === "") answerUrl.pathname = "/ask";
      // إجابة مستقلة: لا نجلب معلومات مسبقة ولا نمرر مصادر أو source_policy إلى مزود الـAI.
      const payload = await fetchJsonPost(answerUrl, { question: query, include_sources: true }, env[provider.keySecret] || "");
      const item = answerItem(payload, query);
      if (!item.description) throw new Error("Answer provider returned no answer");
      const sources = sanitizeAnswerSources(payload?.sources);
      return { success: true, type: "answers", query, page, page_size: 1, count: 1, has_more: false, items: [item], sources, grounding: sources.length ? "sources" : "none", status: payload?.status || (sources.length ? "generated" : "insufficient_sources") };
    } catch (error) {
      console.error("answers_provider_error", error instanceof Error ? error.message : String(error));
      return emptyResult(provider.type, query, page, false, "Answer provider is temporarily unavailable");
    }
  }
  if (!apiUrl) return emptyResult(provider.type, query, page, false, `Missing secret: ${provider.urlSecret}`);
  let url;
  try { url = buildProviderUrl(apiUrl, query, page, provider.type, filters); } catch { return emptyResult(provider.type, query, page, false, `Invalid URL in secret: ${provider.urlSecret}`); }
  try {
    const payload = await fetchJson(url, env[provider.keySecret] || "", ROUTE_TIMEOUT_MS[route] || PROVIDER_TIMEOUT_MS);
    if (provider.type === "events") {
      const upcoming = Array.isArray(payload?.upcoming) ? payload.upcoming : [];
      const past = Array.isArray(payload?.past) ? payload.past : [];
      const mapEvent = (item, status) => ({
        type: "event",
        title: cleanText(item?.["العنوان"] || item?.title || "مناسبة بدون عنوان"),
        description: cleanText(item?.["الوصف"] || item?.description),
        date: cleanText(item?.["التاريخ"] || item?.date),
        category: cleanText(item?.["النوع"] || item?.type),
        calendar: cleanText(item?.["التقويم"] || item?.calendar),
        status,
        days_until: Number.isFinite(item?.days_until) ? item.days_until : null,
        days_since: Number.isFinite(item?.days_since) ? item.days_since : null,
        next_date: cleanText(item?.next_date),
        approx: Boolean(item?.approx),
        url: "",
        source: "عامل المناسبات المصري",
      });
      const items = [...upcoming.map((item) => mapEvent(item, "upcoming")), ...past.map((item) => mapEvent(item, "past"))];
      return { success: true, type: "events", query: "", page: 1, page_size: items.length, count: items.length, has_more: false, items, upcoming: upcoming.map((item) => mapEvent(item, "upcoming")), past: past.map((item) => mapEvent(item, "past")), counts: payload?.counts || { upcoming: upcoming.length, past: past.length, total: items.length }, time_zone: payload?.time_zone || "Africa/Cairo", now: payload?.now || null, today: cleanText(payload?.today) };
    }
    const rawItems = provider.type === "images" && Array.isArray(payload?.groups) ? payload.groups.flatMap((group) => (group.items || []).map((item) => ({ ...item, source: group.source_name || group.source || item.source }))) : extractItems(payload);
    const normalizedItems = rawItems.map((item) => provider.type === "info" ? unifiedInfoItem(item) : provider.type === "images" ? imageItem(item) : genericItem(item, provider.type));
    const allItems = dedupeItems(normalizedItems);
    const pageSize = provider.type === "info" ? INFO_PAGE_SIZE : provider.type === "images" ? IMAGE_LIMIT : provider.type === "news" ? NEWS_RESULT_LIMIT : RESULT_LIMIT;
    const items = provider.type === "info" ? allItems.slice((page - 1) * pageSize, page * pageSize) : provider.type === "news" ? allItems : allItems.slice(0, pageSize);
    const groups = provider.type === "images" && payload?.groups ? (Array.isArray(payload.groups) ? Object.fromEntries(payload.groups.map((group) => [cleanText(group.source_name || group.source || "مصدر الصور"), dedupeItems((group.items || []).map((item) => imageItem(item, group.source_name || group.source))).slice(0, 10)])) : { wikimedia: dedupeItems((payload.groups.wikimedia || []).map((item) => imageItem(item, "Wikimedia Commons"))).slice(0, 10), internet_archive: dedupeItems((payload.groups.internet_archive || []).map((item) => imageItem(item, "Internet Archive"))).slice(0, 10) }) : undefined;
    const sources = groups ? Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, value.length])) : undefined;
    const hasMore = provider.type === "news" ? Boolean(payload?.has_more) : provider.type === "info" ? allItems.length > page * pageSize : Boolean(payload?.has_more ?? payload?.has_next);
    return { success: true, type: provider.type, query, page, page_size: items.length, count: items.length, has_more: hasMore, items, ...(provider.type === "news" ? { total: payload?.total ?? items.length, total_pages: payload?.total_pages ?? (hasMore ? page + 1 : page), categories: payload?.categories || [], sources: payload?.sources || [] } : {}), ...(groups ? { groups, sources } : {}) };
  } catch (error) {
    console.error(`${route}_provider_error`, error instanceof Error ? error.message : String(error));
    return emptyResult(provider.type, query, page, false, "Provider is temporarily unavailable");
  }
}

function cacheKey(request, route, query, page, filters = {}) {
  const url = new URL(request.url);
  // v3 يعزل الردود القديمة التي حُفظت قبل تثبيت رؤوس CORS.
  const key = new URL(`${url.origin}/__api-cache/v16/${encodeURIComponent(route)}`);
  key.searchParams.set("q", query.toLocaleLowerCase("ar"));
  key.searchParams.set("page", String(page));
  if (filters.category) key.searchParams.set("category", filters.category);
  if (filters.source) key.searchParams.set("source", filters.source);
  return new Request(key.toString(), { method: "GET" });
}

async function cachedProvider(request, env, route, query, page, ctx, filters = {}) {
  const cache = caches.default;
  const key = cacheKey(request, route, query, page, filters);
  const cached = await cache.match(key);
  if (cached) {
    const headers = new Headers(cached.headers);
    const origin = request.headers.get("Origin");
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
    }
    headers.set("X-API-Cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }
  const result = await callProvider(request, env, route, query, page, filters);
  const status = result.success ? 200 : 502;
  const response = json(request, result, status, { "Cache-Control": result.success ? `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_S_MAXAGE_SECONDS}` : "no-store", "X-API-Cache": "MISS" });
  if (result.success) ctx.waitUntil(cache.put(key, response.clone()));
  else ctx.waitUntil(cache.put(key, json(request, result, status, { "Cache-Control": `public, max-age=${FAILURE_CACHE_SECONDS}, s-maxage=${FAILURE_CACHE_SECONDS}`, "X-API-Cache": "NEGATIVE" })));
  return response;
}

function routeName(pathname) {
  const value = pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  return value || "health";
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
  const secret = String(env.GATEWAY_KEY || "");
  if (!secret) return false; // لو المفتاح غير مضبوط يُقفل العامل بدل ما يفتح للجميع
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  // وسيط الموقع (Pages) يرسل المفتاح في X-Bardy-Key؛ ونقبل X-API-Key وBearer للاستدعاءات الأخرى
  return safeEqual(request.headers.get("X-Bardy-Key") || request.headers.get("X-API-Key") || bearer || "", secret);
}
function notFound() {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export default {
  async fetch(request, env, ctx) {
    if (!isAuthorized(request, env)) return notFound();
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(request) });
    if (request.method !== "GET") return json(request, { success: false, error: "Method not allowed" }, 405);
    const url = new URL(request.url);
    const route = routeName(url.pathname);
    if (route === "health") return json(request, { success: true, worker: "bardy-search-api", routes: Object.keys(PROVIDERS).map((item) => `/${item}`), cache: { enabled: true, ttl_seconds: CACHE_TTL_SECONDS, s_maxage_seconds: CACHE_S_MAXAGE_SECONDS }, output: "items" });
    if (!PROVIDERS[route]) return notFound();
    const query = cleanText(url.searchParams.get("q"));
    const pageValue = Number(url.searchParams.get("page") || 1);
    const page = Number.isFinite(pageValue) ? Math.max(1, Math.floor(pageValue)) : 1;
    const maxLength = route === "answers" ? MAX_ANSWER_QUERY_LENGTH : (ROUTE_QUERY_LIMITS[route] || MAX_QUERY_LENGTH);
    if (query.length > maxLength) {
      return json(request, { success: false, code: "query_too_long", max_length: maxLength, error: `كلمة البحث طويلة، اختصرها إلى ${maxLength} حرفًا أو أقل` }, 400);
    }
    // الأخبار تُرجع الأحدث تلقائيًا عند عدم وجود q؛ باقي المسارات تحتاج إلى بحث.
    if (!query && !["news", "events"].includes(route)) return json(request, emptyResult(PROVIDERS[route].type, "", page));
    const filters = { category: cleanText(url.searchParams.get("category")), source: cleanText(url.searchParams.get("source")) };
    return cachedProvider(request, env, route, query, page, ctx, filters);
  },
};
