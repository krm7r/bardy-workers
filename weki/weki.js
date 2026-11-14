const WIKIPEDIA_API = "https://ar.wikipedia.org/w/api.php";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

const MAX_QUERY_LENGTH = 200;
const MAX_INFO_RESULTS = 4;
const MAX_IMAGES = 10;
const MAX_VIDEOS = 4;
const MAX_TEXT_CHARS = 2500;
const CACHE_TTL_SECONDS = 300;
const CACHE_S_MAXAGE_SECONDS = 900;
const API_TIMEOUT_MS = 12000;
const API_RETRIES = 2;
const MAX_PAGE = 100;
const USER_AGENT = "Arabic-Wikipedia-Wikidata-Worker/2.0";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

function json(data, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      ...corsHeaders(),
    },
  });
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function limitText(value) {
  return cleanText(value).slice(0, MAX_TEXT_CHARS).trim();
}

function normalizeText(value) {
  return cleanText(value)
    .toLocaleLowerCase("ar")
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\u0600-\u06FFa-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|ref_src$)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
    return url.toString();
  } catch {
    return cleanText(value).toLowerCase();
  }
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(getKey(item) || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeInfo(items) {
  const seenUrls = new Set();
  const seenIds = new Set();
  const seenDescriptions = new Set();
  return items.filter((item) => {
    const urlKey = normalizeUrl(item.url);
    const idKey = cleanText(item.source_id);
    const descriptionKey = normalizeText(item.description);
    if ((urlKey && seenUrls.has(urlKey)) || (idKey && seenIds.has(idKey)) || (descriptionKey && seenDescriptions.has(descriptionKey))) return false;
    if (urlKey) seenUrls.add(urlKey);
    if (idKey) seenIds.add(idKey);
    if (descriptionKey) seenDescriptions.add(descriptionKey);
    return true;
  });
}

function cleanQuery(value) {
  const query = cleanText(value);
  return query && query.length <= MAX_QUERY_LENGTH && !/[\u0000-\u001f\u007f]/.test(query) ? query : null;
}

async function apiRequest(endpoint, params, userAgent = USER_AGENT) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  let lastError;
  for (let attempt = 0; attempt <= API_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": userAgent }, signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`${endpoint} returned ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const body = await response.text();
      if (new TextEncoder().encode(body).length > 5 * 1024 * 1024) throw new Error("External response is too large");
      return JSON.parse(body);
    } catch (error) {
      lastError = error;
      const retryable = error?.name === "AbortError" || error?.status === 429 || error?.status >= 500;
      if (attempt < API_RETRIES && retryable) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      else if (!retryable) throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("External request failed");
}

async function searchWikipedia(query, page = 1) {
  const searchData = await apiRequest(WIKIPEDIA_API, {
    action: "query", list: "search", srsearch: query, sroffset: String((page - 1) * MAX_INFO_RESULTS), srlimit: MAX_INFO_RESULTS, srprop: "snippet", format: "json", formatversion: "2", utf8: "1",
  });
  const searchResults = searchData.query?.search || [];
  const totalResults = Number(searchData.query?.searchinfo?.totalhits || searchResults.length);
  const pageIds = searchResults.map((item) => item.pageid).filter(Boolean).join("|");
  if (!pageIds) return { results: [], totalResults };
  const pagesData = await apiRequest(WIKIPEDIA_API, {
    action: "query", pageids: pageIds, redirects: "1", prop: "extracts|info|pageimages", explaintext: "1", exchars: String(MAX_TEXT_CHARS), inprop: "url", piprop: "thumbnail", pithumbsize: "800", format: "json", formatversion: "2", utf8: "1",
  });
  const searchById = new Map(searchResults.map((item) => [item.pageid, item]));
  const normalizedQuery = normalizeText(query);
  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  const pages = (pagesData.query?.pages || []).map((page) => {
    const searchItem = searchById.get(page.pageid);
    const text = limitText(page.extract || searchItem?.snippet || page.title);
    const title = cleanText(page.title);
    const normalizedTitle = normalizeText(title);
    const matchedWords = queryWords.filter((word) => normalizedTitle.includes(word)).length;
    const relevance =
      (normalizedTitle === normalizedQuery ? 1_000_000 : 0) +
      (normalizedQuery && normalizedTitle.includes(normalizedQuery) ? 100_000 : 0) +
      (matchedWords === queryWords.length ? 10_000 : 0) +
      matchedWords * 1_000;
    return {
      type: "info", title, url: page.fullurl || `https://ar.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      description: text, text, image_url: page.thumbnail?.source || "", image_alt: title,
      source: "Wikipedia", source_id: String(page.pageid || ""), _relevance: relevance, _textLength: text.length,
    };
  });
  return { results: pages.sort((a, b) => b._relevance - a._relevance || b._textLength - a._textLength), totalResults };
}

async function searchWikidata(query) {
  const data = await apiRequest(WIKIDATA_API, { action: "wbsearchentities", search: query, language: "ar", uselang: "ar", type: "item", limit: 10, format: "json", formatversion: "2" });
  return data.search?.find((item) => normalizeText(item.label) === normalizeText(query)) || data.search?.[0] || null;
}

function claimValue(claim) { return claim?.mainsnak?.datavalue?.value ?? null; }
function bestClaim(entity, property) { return (entity.claims?.[property] || []).find((claim) => claim.rank !== "deprecated") || entity.claims?.[property]?.[0] || null; }
function getEntityId(entity, property) { const value = claimValue(bestClaim(entity, property)); return value && typeof value === "object" ? value.id || null : null; }
function getQuantity(entity, property) { const value = claimValue(bestClaim(entity, property)); return value && typeof value === "object" && value.amount ? value.amount.replace(/^\+/, "") : null; }
function getCoordinate(entity) { const value = claimValue(bestClaim(entity, "P625")); return value && typeof value === "object" ? { latitude: value.latitude ?? null, longitude: value.longitude ?? null } : null; }
function commonsFileUrl(value) { return typeof value === "string" && value ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(value)}` : ""; }

async function getWikidataInfo(entityId, searchItem) {
  if (!entityId) return null;
  const data = await apiRequest(WIKIDATA_API, { action: "wbgetentities", ids: entityId, props: "labels|descriptions|claims|sitelinks", languages: "ar|en", format: "json", formatversion: "2" });
  const entity = data.entities?.[entityId];
  if (!entity) return null;
  const labels = [];
  const relatedIds = ["P17", "P36", "P31", "P37", "P38"].map((property) => getEntityId(entity, property)).filter(Boolean);
  if (relatedIds.length) {
    const labelData = await apiRequest(WIKIDATA_API, { action: "wbgetentities", ids: [...new Set(relatedIds)].join("|"), props: "labels", languages: "ar|en", format: "json", formatversion: "2" });
    for (const related of Object.values(labelData.entities || {})) labels.push([related.id, related.labels?.ar?.value || related.labels?.en?.value || related.id]);
  }
  const labelMap = new Map(labels);
  const relation = (property, prefix) => { const id = getEntityId(entity, property); return id ? `${prefix}: ${labelMap.get(id) || id}` : ""; };
  const lines = [
    entity.labels?.ar?.value || entity.labels?.en?.value || searchItem?.label || "",
    entity.descriptions?.ar?.value || entity.descriptions?.en?.value || "",
    relation("P31", "النوع"), relation("P17", "الدولة"), relation("P36", "العاصمة"), relation("P37", "اللغة الرسمية"), relation("P38", "العملة"),
    getQuantity(entity, "P1082") ? `عدد السكان: ${getQuantity(entity, "P1082")}` : "",
    getQuantity(entity, "P2046") ? `المساحة: ${getQuantity(entity, "P2046")}` : "",
  ].filter(Boolean);
  const information = limitText(lines.join("\n"));
  return {
    id: entity.id, name: entity.labels?.ar?.value || entity.labels?.en?.value || searchItem?.label || "",
    information, wikipedia_ar: entity.sitelinks?.arwiki?.url || null, coordinates: getCoordinate(entity),
    image_url: commonsFileUrl(claimValue(bestClaim(entity, "P18"))), image_alt: entity.labels?.ar?.value || entity.labels?.en?.value || "",
  };
}

async function searchCommonsMedia(query) {
  const data = await apiRequest(COMMONS_API, { action: "query", generator: "search", gsrsearch: query, gsrnamespace: "6", gsrlimit: "30", prop: "imageinfo", iiprop: "url|mime|size", iiurlwidth: "1000", format: "json", formatversion: "2" });
  const images = [], videos = [];
  for (const page of data.query?.pages || []) {
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;
    const mime = String(info.mime || "").toLowerCase();
    if (!mime.startsWith("image/") && !mime.startsWith("video/")) continue;
    const title = cleanText(page.title?.replace(/^File:/i, ""));
    const pageUrl = `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title || "").replaceAll(" ", "_"))}`;
    const media = { type: mime.startsWith("video/") ? "video" : "image", title, url: pageUrl, description: "", text: "", image_url: info.thumburl || info.url, image_alt: title, source: "Wikimedia Commons", source_id: page.title || "", original_url: info.url, width: info.width || null, height: info.height || null };
    if (media.type === "video" && videos.length < MAX_VIDEOS) videos.push(media);
    if (media.type === "image" && images.length < MAX_IMAGES) images.push(media);
  }
  return { images: uniqueBy(images, (item) => normalizeUrl(item.original_url)), videos: uniqueBy(videos, (item) => normalizeUrl(item.original_url)) };
}

async function handleSearch(url) {
  const query = cleanQuery(url.searchParams.get("q") || url.searchParams.get("name"));
  if (!query) return json({ success: false, error: "أرسل كلمة البحث في q", example: "/api/search?q=مصر" }, 400);
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const warnings = [];
  const settled = await Promise.allSettled([searchWikipedia(query, page), searchWikidata(query), searchCommonsMedia(query)]);
  const wikipedia = settled[0].status === "fulfilled" ? settled[0].value : { results: [], totalResults: 0 };
  if (settled[0].status === "rejected") warnings.push("wikipedia");
  const wikidataSearch = settled[1].status === "fulfilled" ? settled[1].value : null;
  if (settled[1].status === "rejected") warnings.push("wikidata");
  const commons = settled[2].status === "fulfilled" ? settled[2].value : { images: [], videos: [] };
  if (settled[2].status === "rejected") warnings.push("commons");
  let wikidata = null;
  try { wikidata = await getWikidataInfo(wikidataSearch?.id, wikidataSearch); } catch { warnings.push("wikidata_entity"); }

  // اجمع كل بطاقات المعلومات قبل القص والترتيب. الصلة بالبحث أولًا،
  // وطول النص عامل ترجيح عند تساوي الصلة.
  const infoCandidates = dedupeInfo(wikipedia.results);
  if (wikidata?.information && normalizeText(wikidata.information) !== normalizeText(infoCandidates[0]?.description)) {
    const wikidataItem = { type: "info", title: wikidata.name, url: wikidata.wikipedia_ar || `https://www.wikidata.org/wiki/${wikidata.id}`, description: limitText(wikidata.information), text: limitText(wikidata.information), image_url: wikidata.image_url || "", image_alt: wikidata.image_alt || wikidata.name || "", source: "Wikidata", source_id: wikidata.id };
    if (!infoCandidates.some((item) => normalizeText(item.description) === normalizeText(wikidataItem.description))) infoCandidates.push(wikidataItem);
  }
  const info = dedupeInfo(infoCandidates)
    .sort((a, b) => {
      const relevanceDifference = (b._relevance || 0) - (a._relevance || 0);
      if (relevanceDifference !== 0) return relevanceDifference;
      const lengthDifference = (b.description || b.text || "").length - (a.description || a.text || "").length;
      if (lengthDifference !== 0) return lengthDifference;
      return normalizeText(a.title).localeCompare(normalizeText(b.title), "ar");
    })
    .slice(0, MAX_INFO_RESULTS)
    .map(({ _relevance, _textLength, ...item }) => item);
  const firstTwo = info.slice(0, 2);
  const lastTwo = info.slice(2, 4);
  const images = uniqueBy(commons.images, (item) => normalizeUrl(item.image_url)).slice(0, MAX_IMAGES).map(({ original_url, width, height, ...item }) => item);
  const videos = uniqueBy(commons.videos, (item) => normalizeUrl(item.url)).slice(0, MAX_VIDEOS).map(({ original_url, width, height, ...item }) => item);
  const items = [...firstTwo, ...images, ...lastTwo, ...videos];
  const hasMore = wikipedia.totalResults > page * MAX_INFO_RESULTS;
  return json({ success: true, type: "info", query, fetchedAt: new Date().toISOString(), page, page_size: items.length, count: items.length, has_more: hasMore, items, ...(warnings.length ? { warnings } : {}) }, 200, `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_S_MAXAGE_SECONDS}`);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== "GET") return json({ success: false, error: "استخدم GET فقط" }, 405);
    if (env?.API_KEY && request.headers.get("X-API-Key") !== env.API_KEY) return json({ success: false, error: "Unauthorized" }, 401);
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/api/search" || url.pathname === "/search") {
      try {
        return await handleSearch(url);
      } catch (error) {
        // لا نسمح باستثناء غير معالج يؤدي إلى Cloudflare 1101؛ أعد JSON ثابتًا.
        console.error("unhandled_search_error", error instanceof Error ? error.message : String(error));
        return json({ success: false, type: "info", query: cleanText(url.searchParams.get("q")), page: 1, page_size: 0, count: 0, has_more: false, items: [], error: "حدث خطأ أثناء تجهيز النتائج" }, 502);
      }
    }
    return json({ success: true, service: "Arabic Wikipedia + Wikidata + Commons Info API", endpoint: "/api/search?q=مصر" });
  },
};


