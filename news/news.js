// عامل Cloudflare Workers - الأخبار من Google Sheets فقط
// الأعمدة المستخدمة من الجدول:
// B = تاريخ الخبر، C = العنوان، E = الصورة، F = نص الخبر الكامل، H = القسم
// حقول التوافق القديمة موجودة أيضًا، لكن url وguid يظلان null لأنهما ليسا
// ضمن الأعمدة المطلوبة للاعتماد عليها.

const SHEET_ID = "1oqDtbOF3wC-nwzVBSK3UV6uveAsMYm5Ser5CvS2z8qQ";
const SHEET_GID = ""; // اتركه فارغًا للورقة الأولى، أو ضع gid الورقة المطلوبة.
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv${SHEET_GID ? `&gid=${encodeURIComponent(SHEET_GID)}` : ""}`;

const MAX_TOTAL = 500;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 60;
const FETCH_TIMEOUT_MS = 15000;
const CACHE_SECONDS = 300;
const CACHE_VERSION = "sheet-v2";
const CACHE_PARAMS = new Set(["q", "search", "category", "sort", "page", "page_size"]);
const SUMMARY_CHARS = 280;

export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    const headers = corsHeaders(env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, headers);

    if (env.API_KEY && request.headers.get("X-API-Key") !== env.API_KEY) {
      return json({ error: "Unauthorized" }, 401, headers);
    }

    try {
      const routeCategory = getRouteCategory(requestUrl.pathname);

      if (["/", "/health", "/status"].includes(requestUrl.pathname.toLowerCase())) {
        return json({
          ok: true,
          service: "arabic-news-worker",
          columns: { date: "B", title: "C", image: "E", text: "F", category: "H" },
          cache_seconds: CACHE_SECONDS,
          endpoints: {
            all_news: "/api/news",
            category: "/api/news?category=<category>",
            categories: "/api/categories",
            aliases: ["/news/<category>", "/category/<category>", "/<category>"],
          },
        }, 200, headers);
      }

      // Cache bypass is honoured only when API_KEY is configured (the global check above has then already authenticated
      // the caller). Otherwise any visitor could force a Google Sheets fetch on every request.
      const forceRefresh = Boolean(env.API_KEY) && (requestUrl.searchParams.get("refresh") === "1"
        || /no-cache/i.test(request.headers.get("Cache-Control") || ""));

      const cacheUrl = new URL(request.url);
      for (const key of [...cacheUrl.searchParams.keys()]) if (!CACHE_PARAMS.has(key)) cacheUrl.searchParams.delete(key);
      cacheUrl.searchParams.sort();
      cacheUrl.searchParams.set("cache_v", CACHE_VERSION);
      const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
      const edgeCache = caches.default;

      if (!forceRefresh) {
        const cached = await edgeCache.match(cacheKey);
        if (cached) {
          const cachedHeaders = new Headers(cached.headers);
          cachedHeaders.set("X-Worker-Cache", "HIT");
          return new Response(cached.body, { status: cached.status, headers: cachedHeaders });
        }
      }

      const articles = await getSheetArticles(env);
      const categories = getCategories(articles);

      if (requestUrl.pathname.toLowerCase() === "/api/categories") {
        const result = categories.map((category) => ({
          id: category.id,
          name: category.name,
          endpoint: `/api/news?category=${encodeURIComponent(category.name)}`,
        }));
        const response = json(result, 200, headers);
        response.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
        ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
        return response;
      }

      if (requestUrl.pathname.toLowerCase() === "/api/sources") {
        // يبقى endpoint للتوافق مع العملاء القدامى بدون إظهار مصدر البيانات.
        const response = json([], 200, headers);
        response.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
        ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
        return response;
      }

      const path = requestUrl.pathname.toLowerCase();
      const isNewsEndpoint = path === "/api/news" || Boolean(routeCategory);
      if (!isNewsEndpoint) {
        return json({ error: "Not found", available: ["/api/news", "/api/categories", "/api/sources"] }, 404, headers);
      }

      const requestedCategory = requestUrl.searchParams.get("category") || routeCategory;
      const category = requestedCategory ? findCategory(articles, requestedCategory) : null;
      if (requestedCategory && !category) {
        return json({ error: "Unknown category", available: categories }, 400, headers);
      }

      const query = (requestUrl.searchParams.get("q") || requestUrl.searchParams.get("search") || "").trim().slice(0, 200);
      const queryTokens = normalizeSearch(query).split(" ").filter(Boolean);
      const sort = (requestUrl.searchParams.get("sort") || "newest").toLowerCase() === "oldest"
        ? "oldest" : "newest";
      const page = clampInt(requestUrl.searchParams.get("page"), 1, 1, 10000);
      const pageSize = clampInt(requestUrl.searchParams.get("page_size"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

      const filtered = articles.filter((article) => {
        const sameCategory = !category || category.id === categoryKey(article.category);
        if (!sameCategory) return false;
        if (!queryTokens.length) return true;
        const searchable = normalizeSearch(`${article.title} ${article.text} ${article.category}`);
        return queryTokens.every((token) => searchable.includes(token));
      });

      const sorted = filtered.sort((a, b) => sort === "oldest"
        ? dateValue(a.publishedAt) - dateValue(b.publishedAt)
        : dateValue(b.publishedAt) - dateValue(a.publishedAt));
      const limited = sorted.slice(0, MAX_TOTAL);
      const total = limited.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const pageItems = limited.slice((page - 1) * pageSize, page * pageSize);

      const payload = {
        success: true,
        fetchedAt: new Date().toISOString(),
        category: category ? category.name : null,
        categoryName: category ? category.name : "كل الأخبار",
        country: "EG",
        countryName: "مصر",
        query: query || null,
        sort,
        count: pageItems.length,
        page,
        page_size: pageItems.length,
        total,
        total_pages: totalPages,
        has_more: page < totalPages,
        requestedPerSource: pageSize,
        categories,
        errors: [],
        articles: pageItems,
      };

      const response = json(payload, 200, headers);
      response.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`);
      response.headers.set("X-Worker-Cache", forceRefresh ? "REFRESH" : "MISS");
      response.headers.set("X-News-Fetched-At", payload.fetchedAt);
      ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      console.error("news_internal_error", error instanceof Error ? error.message : String(error));
      return json({ error: "Internal error" }, 500, headers);
    }
  },

  async scheduled(event, env, ctx) {
    // تحديث الكاش دوريًا من نفس الجدول، بدون أي مصدر أخبار آخر.
    if (!env.WORKER_URL) return;
    const headers = env.API_KEY ? { "X-API-Key": env.API_KEY } : undefined;
    ctx.waitUntil(fetch(`${env.WORKER_URL.replace(/\/$/, "")}/api/news?refresh=1`, { headers }).catch(() => undefined));
  },
};

async function getSheetArticles(env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(SHEET_CSV_URL, {
      signal: controller.signal,
      headers: { Accept: "text/csv,text/plain;q=0.9,*/*;q=0.8", "User-Agent": "ArabicNewsWorker/Sheet/1.0" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`Google Sheets returned HTTP ${response.status}`);
    const csv = await response.text();
    return parseSheetCsv(csv);
  } finally {
    clearTimeout(timer);
  }
}

function parseSheetCsv(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) return [];

  // الأعمدة المطلوبة ثابتة حسب الجدول: B, C, E, F, H.
  return rows.slice(1).map((row) => ({
    id: stableId(`${row[1] || ""}:${row[2] || ""}`),
    category: cleanText(row[7]),
    country: "EG",
    title: cleanText(row[2]),
    url: null,
    guid: null,
    publishedAt: cleanText(row[1]),
    summary: shortSummary(cleanText(row[5])),
    text: cleanText(row[5]),
    image: cleanUrl(row[4]),
  })).filter((article) => article.title);
}

function parseCsv(input) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];
    if (char === '"') {
      if (quoted && next === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell); cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function getCategories(articles) {
  const map = new Map();
  for (const article of articles) {
    if (!article.category) continue;
    const id = categoryKey(article.category);
    if (!map.has(id)) map.set(id, { id, name: article.category });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ar"));
}

function findCategory(articles, value) {
  const needle = categoryKey(value);
  const article = articles.find((item) => categoryKey(item.category) === needle);
  return article ? { id: needle, name: article.category } : null;
}

function getRouteCategory(pathname) {
  const path = pathname.toLowerCase();
  const match = path.match(/^\/(?:news|category|categories)\/([^/]+)$/);
  const decode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };
  if (match) return decode(match[1]);
  if (!path.startsWith("/api/") && path !== "/") return decode(path.slice(1));
  return null;
}

function categoryKey(value) {
  return String(value || "").trim().toLocaleLowerCase("ar")
    .normalize("NFKC").replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[ـ\s_-]+/g, "-");
}

// Search normalization: hamza/alef forms, ya/alef-maqsura, ta-marbuta, tashkeel, punctuation.
function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ar")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortSummary(value) {
  const text = String(value || "");
  if (text.length <= SUMMARY_CHARS) return text;
  const cut = text.slice(0, SUMMARY_CHARS);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), SUMMARY_CHARS - 40)).trim() + "…";
}

function cleanText(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function cleanUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

function dateValue(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function stableId(value) {
  let hash = 0;
  for (const char of String(value)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: new Headers(headers) });
}

// ================================================================
// المصادر القديمة محفوظة أسفل الملف ومُعطّلة بالكامل.
// لإرجاعها لاحقًا: احذف // من بداية أسطر النسخة القديمة، ثم أعد
// استخدام fetchFeed/parser وأعد اختيار DEFAULT_FEEDS بدل getSheetArticles.
// ================================================================

// ----- BEGIN LEGACY RSS SOURCES (DISABLED) -----
// const CATEGORY_META = {
//   politics: { name: "سياسة", aliases: ["politics", "political", "سياسة", "سياسي"] },
//   economy: { name: "اقتصاد", aliases: ["economy", "business", "finance", "اقتصاد", "مال", "أعمال"] },
//   technology: { name: "تكنولوجيا", aliases: ["technology", "tech", "تكنولوجيا", "تقنية"] },
//   entertainment: { name: "ترفيه", aliases: ["entertainment", "art", "فن", "ترفيه"] },
//   sports: { name: "رياضة", aliases: ["sports", "sport", "football", "soccer", "kora", "كرة", "كورة", "كرة القدم", "رياضة"] },
//   health: { name: "صحة", aliases: ["health", "صحة", "طب"] },
//   science: { name: "علوم", aliases: ["science", "علوم"] },
//   local: { name: "محلي", aliases: ["local", "egypt", "مصر", "محلي"] },
//   international: { name: "دولي", aliases: ["international", "world", "دولي", "عالمي"] },
//   culture: { name: "ثقافة", aliases: ["culture", "ثقافة"] },
//   lifestyle: { name: "منوعات", aliases: ["lifestyle", "misc", "منوعات"] },
// };
// 
// const BING = (term) => {
//   const egyptTerm = /مصر|المصري|مصرية|القاهرة|الأهلي|الزمالك/i.test(term) ? term : `${term} مصر`;
//   return `https://www.bing.com/news/search?q=${encodeURIComponent(egyptTerm)}&format=rss&count=30&setlang=ar`;
// };
// const FEED = (id, name, category, urls, extra = {}) => ({ id, name, category, country: "EG", kind: "rss", urls, ...extra });
// 
// // يوجد ٣ مصادر مستقلة على الأقل في كل فئة رئيسية، مع مصدر Bing احتياطي.
// const DEFAULT_FEEDS = [
//   // سياسة مصرية
//   FEED("masrawy-politics", "مصراوي - سياسة", "politics", ["https://www.masrawy.com/rss/feed/25/أخبار", BING("سياسة مصر")]),
//   FEED("youm7-politics", "اليوم السابع - سياسة", "politics", ["https://www.youm7.com/rss/SectionRss?SectionID=65", BING("الحكومة والبرلمان مصر")]),
//   FEED("almasryalyoum-politics", "المصري اليوم - سياسة", "politics", ["https://www.almasryalyoum.com/rss/rssfeed", BING("المصري اليوم سياسة مصر")]),
// 
//   // اقتصاد مصري
//   FEED("masrawy-economy", "مصراوي - اقتصاد", "economy", ["https://www.masrawy.com/rss/feed/49/اقتصاد", BING("اقتصاد مصر")]),
//   FEED("youm7-economy", "اليوم السابع - اقتصاد", "economy", ["https://www.youm7.com/rss/SectionRss?SectionID=65", BING("دولار ذهب بورصة مصر")]),
//   FEED("enterprise-egypt", "Enterprise - اقتصاد مصر", "economy", ["https://enterprise.news/feed/", BING("اقتصاد وأعمال مصر")]),
// 
//   // تكنولوجيا مصرية
//   FEED("youm7-tech", "اليوم السابع - تكنولوجيا", "technology", ["https://www.youm7.com/rss/SectionRss?SectionID=328", BING("تكنولوجيا مصر شركات ناشئة")]),
//   FEED("masrawy-tech", "مصراوي - تكنولوجيا", "technology", ["https://www.masrawy.com/rss/feed/33/تكنولوجيا", BING("تكنولوجيا مصر ذكاء اصطناعي")]),
//   FEED("techreview-eg", "TechReview Egypt", "technology", ["https://techrevieweg.com/feed/", BING("تقنية مصرية")]),
// 
//   // ترفيه وفن مصري
//   FEED("filfan", "في الفن", "entertainment", ["https://www.filfan.com/feed", BING("فن مصري")]),
//   FEED("youm7-art", "اليوم السابع - فن", "entertainment", ["https://www.youm7.com/rss/SectionRss?SectionID=48", BING("سينما ومسلسلات مصرية")]),
//   FEED("masrawy-art", "مصراوي - فن", "entertainment", ["https://www.masrawy.com/rss/feed/31/فن", BING("نجوم وفن مصر")]),
// 
//   // كرة القدم والرياضة المصرية داخل فئة الرياضة
//   FEED("filgoal", "في الجول", "sports", ["https://www.filgoal.com/rss", BING("كرة القدم المصرية")]),
//   FEED("youm7-sports", "اليوم السابع - رياضة", "sports", ["https://www.youm7.com/rss/SectionRss?SectionID=298", BING("رياضة مصر")]),
//   FEED("masrawy-sports", "مصراوي - رياضة", "sports", ["https://www.masrawy.com/rss/feed/24/رياضة", BING("الدوري المصري الأهلي الزمالك")]),
// 
//   // صحة مصرية
//   FEED("youm7-health", "اليوم السابع - صحة", "health", ["https://www.youm7.com/rss/SectionRss?SectionID=247", BING("الصحة في مصر")]),
//   FEED("masrawy-health", "مصراوي - صحة", "health", ["https://www.masrawy.com/rss/feed/27/صحة", BING("طب وعلاج مصر")]),
//   FEED("almasryalyoum-health", "المصري اليوم - صحة", "health", ["https://www.almasryalyoum.com/rss/rssfeed", BING("أخبار صحية مصرية")]),
// 
//   // علوم مصرية
//   FEED("youm7-science", "اليوم السابع - علوم", "science", ["https://www.youm7.com/rss/SectionRss?SectionID=295", BING("علوم وأبحاث مصر")]),
//   FEED("egypt-independent-science", "Egypt Independent - Science", "science", ["https://www.egyptindependent.com/feed/", BING("علوم وابتكار مصر")]),
//   FEED("dailynewsegypt-science", "Daily News Egypt - Science", "science", ["https://www.dailynewsegypt.com/feed/", BING("جامعات وأبحاث مصر")]),
// 
//   // أخبار محلية مصرية
//   FEED("masrawy-local", "مصراوي - أخبار مصر", "local", ["https://www.masrawy.com/rss/feed/25/أخبار", BING("أخبار مصر")]),
//   FEED("youm7-local", "اليوم السابع - أخبار مصر", "local", ["https://www.youm7.com/rss/SectionRss?SectionID=65", BING("أخبار المحافظات مصر")]),
//   FEED("egyptian-streets", "Egyptian Streets", "local", ["https://egyptianstreets.com/feed/", "https://egyptianstreets.com/wp-json/wp/v2/posts", BING("Egypt local news")], { kind: "mixed" }),
// 
//   // أخبار العالم من صحف مصرية
//   FEED("ahram-world", "الأهرام - العالم", "international", ["https://english.ahram.org.eg/rss/", BING("العالم من مصر")]),
//   FEED("egypt-independent-world", "Egypt Independent - World", "international", ["https://www.egyptindependent.com/feed/", BING("أخبار العالم من مصر")]),
//   FEED("dailynewsegypt-world", "Daily News Egypt - World", "international", ["https://www.dailynewsegypt.com/feed/", BING("دولي من مصر")]),
// 
//   // ثقافة مصرية
//   FEED("youm7-culture", "اليوم السابع - ثقافة", "culture", ["https://www.youm7.com/rss/SectionRss?SectionID=248", BING("ثقافة مصرية")]),
//   FEED("masrawy-culture", "مصراوي - ثقافة", "culture", ["https://www.masrawy.com/rss/feed/32/ثقافة", BING("أدب وثقافة مصر")]),
//   FEED("egypt-independent-culture", "Egypt Independent - Culture", "culture", ["https://www.egyptindependent.com/feed/", BING("فن وثقافة مصر")]),
// 
//   // منوعات مصرية
//   FEED("youm7-misc", "اليوم السابع - منوعات", "lifestyle", ["https://www.youm7.com/rss/SectionRss?SectionID=89", BING("منوعات مصرية")]),
//   FEED("masrawy-misc", "مصراوي - منوعات", "lifestyle", ["https://www.masrawy.com/rss/feed/26/منوعات", BING("لايف ستايل مصر")]),
//   FEED("egypt-independent-misc", "Egypt Independent - Life", "lifestyle", ["https://www.egyptindependent.com/feed/", BING("منوعات من مصر")]),
// ];
// 
// const ROUTE_ALIASES = {
//   "/politics": "politics", "/political": "politics", "/siasa": "politics",
//   "/economy": "economy", "/business": "economy", "/eqtesad": "economy",
//   "/technology": "technology", "/tech": "technology", "/tكنولوجيا": "technology",
//   "/entertainment": "entertainment", "/art": "entertainment", "/fan": "entertainment",
//   "/sport": "sports", "/sports": "sports", "/kora": "sports", "/football": "sports", "/soccer": "sports",
//   "/science": "science",
//   "/local": "local", "/egypt": "local", "/international": "international",
//   "/world": "international", "/culture": "culture", "/lifestyle": "lifestyle",
// };
// 
// const MAX_PER_SOURCE = 20;
// const MAX_TOTAL = 500;
// const DEFAULT_PAGE_SIZE = 20;
// const FETCH_TIMEOUT_MS = 15000;
// const CACHE_SECONDS = 300;
// 
// export default {
//   async fetch(request, env, ctx) {
//     const requestUrl = new URL(request.url);
//     const headers = corsHeaders(env);
// 
//     if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
//     if (env.API_KEY && request.headers.get("X-API-Key") !== env.API_KEY) {
//       return json({ error: "Unauthorized" }, 401, headers);
//     }
// 
//     try {
//       const routeMatch = requestUrl.pathname.toLowerCase().match(/^\/(?:news|category|categories)\/([^/]+)$/);
//       const routeCategory = normalizeCategory(routeMatch?.[1]) || ROUTE_ALIASES[requestUrl.pathname.toLowerCase()] || null;
// 
//       if (requestUrl.pathname === "/" || requestUrl.pathname === "/health" || requestUrl.pathname === "/status") {
//         return json({
//           ok: true,
//           service: "arabic-news-worker",
//           sources: DEFAULT_FEEDS.length,
//           categories: Object.keys(CATEGORY_META).length,
//           cache_seconds: CACHE_SECONDS,
//           cache: { ttl_seconds: CACHE_SECONDS, stale_while_revalidate_seconds: 60, refresh: "?refresh=1" },
//           endpoints: { list: "/api/categories", sources: "/api/sources", all_news: "/api/news", category: "/api/news?category=<id>", aliases: ["/<id>", "/news/<id>", "/category/<id>"] },
//           examples: ["/sport", "/politics", "/economy", "/technology", "/entertainment"],
//         }, 200, headers);
//       }
// 
//       const feeds = await getFeeds(env);
//       if (requestUrl.pathname === "/api/categories") {
//         return json(Object.entries(CATEGORY_META).map(([id, value]) => ({
//           id, name: value.name, aliases: value.aliases,
//           sourceCount: feeds.filter((feed) => feed.category === id).length,
//           endpoint: `/${id}`,
//         })), 200, headers);
//       }
// 
//       if (requestUrl.pathname === "/api/sources") {
//         return json(feeds.map(({ urls, url, kind, ...feed }) => ({
//           ...feed,
//           kind,
//           feedCount: (urls || (url ? [url] : [])).length,
//         })), 200, headers);
//       }
// 
//       if (requestUrl.pathname !== "/api/news" && !routeCategory) {
//         return json({ error: "Not found", available: ["/api/news", "/api/categories", "/api/sources", ...Object.keys(ROUTE_ALIASES)] }, 404, headers);
//       }
// 
//       const category = normalizeCategory(requestUrl.searchParams.get("category") || routeCategory);
//       if (requestUrl.searchParams.has("category") && !category) {
//         return json({ error: "Unknown category", available: Object.keys(CATEGORY_META) }, 400, headers);
//       }
// 
//       const sourceId = requestUrl.searchParams.get("source");
//       const query = (requestUrl.searchParams.get("q") || requestUrl.searchParams.get("search") || "").trim();
//       const limit = clampInt(requestUrl.searchParams.get("limit"), MAX_PER_SOURCE, 1, MAX_PER_SOURCE);
//       const page = clampInt(requestUrl.searchParams.get("page"), 1, 1, 1000);
//       const pageSize = clampInt(requestUrl.searchParams.get("page_size"), DEFAULT_PAGE_SIZE, 1, 50);
//       const sort = (requestUrl.searchParams.get("sort") || "newest").toLowerCase();
// 
//       const selectedFeeds = feeds.filter((feed) =>
//         (!sourceId || feed.id === sourceId) && (!category || feed.category === category)
//       );
//       if (!selectedFeeds.length) return json({ error: "No matching source or category" }, 404, headers);
// 
//       const forceRefresh = requestUrl.searchParams.get("refresh") === "1" || /no-cache/i.test(request.headers.get("Cache-Control") || "");
//       const cacheUrl = new URL(request.url);
//       cacheUrl.searchParams.set("cache_v", "news-v13");
//       cacheUrl.searchParams.delete("refresh");
//       const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
//       const edgeCache = caches.default;
//       if (!forceRefresh) {
//         const cached = await edgeCache.match(cacheKey);
//         if (cached) {
//           const cachedHeaders = new Headers(cached.headers);
//           cachedHeaders.set("X-Worker-Cache", "HIT");
//           cachedHeaders.set("X-News-Cache-TTL", String(CACHE_SECONDS));
//           return new Response(cached.body, { status: cached.status, headers: cachedHeaders });
//         }
//       }
// 
//       const results = await Promise.allSettled(selectedFeeds.map((feed) => fetchFeed(feed, limit)));
//       const articles = [];
//       const errors = [];
//       results.forEach((result, index) => {
//         const feed = selectedFeeds[index];
//         if (result.status === "fulfilled") articles.push(...result.value);
//         else errors.push({ source: feed.id, sourceName: feed.name, message: result.reason?.message || String(result.reason) });
//       });
// 
//       const normalizedQuery = query.toLocaleLowerCase("ar");
//       const filtered = articles.filter((article) => {
//         const text = `${article.title} ${article.summary || ""}`.toLocaleLowerCase("ar");
//         return (!category || article.category === category) && (!normalizedQuery || text.includes(normalizedQuery));
//       });
// 
//       const uniqueArticles = deduplicate(filtered)
//         .sort((a, b) => sort === "oldest" ? dateValue(a.publishedAt) - dateValue(b.publishedAt) : dateValue(b.publishedAt) - dateValue(a.publishedAt))
//         .slice(0, MAX_TOTAL);
//       const total = uniqueArticles.length;
//       const totalPages = Math.max(1, Math.ceil(total / pageSize));
//       const pageItems = uniqueArticles.slice((page - 1) * pageSize, page * pageSize);
// 
//       // إثراء الصور للنتيجة الحالية فقط لتقليل زمن الاستجابة.
//       await enrichArticleImages(pageItems);
// 
//       const sourceSummary = selectedFeeds.map((feed) => ({
//         source: feed.id,
//         sourceName: feed.name,
//         category: feed.category,
//         count: uniqueArticles.filter((article) => article.source === feed.id).length,
//       }));
// 
//       const payload = {
//         success: true,
//         fetchedAt: new Date().toISOString(),
//         category: category || null,
//         categoryName: category ? CATEGORY_META[category].name : "كل الأخبار المصرية",
//         country: "EG",
//         countryName: "مصر",
//         query: query || null,
//         sort: sort === "oldest" ? "oldest" : "newest",
//         count: pageItems.length,
//         page,
//         page_size: pageItems.length,
//         total,
//         total_pages: totalPages,
//         has_more: page < totalPages,
//         requestedPerSource: limit,
//         categories: Object.entries(CATEGORY_META).map(([id, value]) => ({ id, name: value.name })),
//         sourcesRequested: selectedFeeds.map((feed) => feed.id),
//         sourceSummary,
//         articles: pageItems,
//         errors,
//       };
// 
//       const fresh = json(payload, 200, headers);
//       fresh.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`);
//       fresh.headers.set("X-Worker-Cache", forceRefresh ? "REFRESH" : "MISS");
//       fresh.headers.set("X-News-Cache-TTL", String(CACHE_SECONDS));
//       fresh.headers.set("X-News-Fetched-At", payload.fetchedAt);
//       ctx.waitUntil(edgeCache.put(cacheKey, fresh.clone()));
//       return fresh;
//     } catch (error) {
//       return json({ error: "Internal error", message: error?.message || String(error) }, 500, headers);
//     }
//   },
// 
//   async scheduled(event, env, ctx) {
//     ctx.waitUntil((async () => {
//       const origin = "https://news.neuon.workers.dev";
//       const headers = env.API_KEY ? { "X-API-Key": env.API_KEY } : undefined;
//       const categories = Object.keys(CATEGORY_META);
//       const results = await Promise.allSettled(categories.map((category) =>
//         fetch(`${origin}/api/news?category=${encodeURIComponent(category)}&page_size=${DEFAULT_PAGE_SIZE}&refresh=1`, { headers })
//       ));
//       const failed = results.filter((result) => result.status === "rejected").length;
//       if (env.NEWS_KV) await env.NEWS_KV.put("last_run", JSON.stringify({ at: new Date().toISOString(), categories: categories.length, failed }));
//     })());
//   },
// };
// 
// async function getFeeds(env) {
//   if (!env.FEEDS_JSON) return DEFAULT_FEEDS;
//   try {
//     const raw = JSON.parse(env.FEEDS_JSON);
//     if (!Array.isArray(raw)) throw new Error("FEEDS_JSON must be an array");
//     return raw.map((feed) => ({ ...feed, urls: feed.urls || (feed.url ? [feed.url] : []) }))
//       .filter((feed) => feed.id && feed.name && feed.category && feed.urls.length);
//   } catch (error) {
//     throw new Error(`Invalid FEEDS_JSON: ${error.message}`);
//   }
// }
// 
// async function fetchFeed(feed, limit) {
//   const urls = feed.urls || [feed.url];
//   const errors = [];
//   for (const url of urls) {
//     try {
//       const controller = new AbortController();
//       const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
//       const res = await fetch(url, {
//         signal: controller.signal,
//         redirect: "follow",
//         headers: { Accept: "application/rss+xml, application/atom+xml, application/json, text/html;q=0.9, */*;q=0.8", "User-Agent": "ArabicNewsWorker/3.0" },
//       });
//       clearTimeout(timer);
//       if (!res.ok) throw new Error(`HTTP ${res.status}`);
//       const text = await res.text();
//       let out = [];
//       if ((feed.kind === "wp" || feed.kind === "mixed") && /application\/json|^\s*\[/.test(res.headers.get("content-type") || "")) {
//         out = parseWordPress(JSON.parse(text), feed);
//       } else if (/<(?:rss|feed|rdf:RDF)\b/i.test(text) || /<(?:item|entry)\b/i.test(text)) {
//         out = parseFeed(text).map((item) => ({ ...item, source: feed.id, sourceName: feed.name, category: feed.category, country: feed.country }));
//       } else if (feed.kind === "html") {
//         out = parseHtmlNews(text, url).map((item) => ({ ...item, source: feed.id, sourceName: feed.name, category: feed.category, country: feed.country }));
//       } else {
//         throw new Error("Unsupported response (not RSS/Atom/JSON)");
//       }
//       if (out.length) return out.slice(0, limit);
//       throw new Error("no articles");
//     } catch (error) {
//       errors.push(`${url}: ${error.message}`);
//     }
//   }
//   throw new Error(errors.join(" | "));
// }
// 
// function parseWordPress(items, feed) {
//   return items.map((item) => ({
//     id: `${feed.id}:${item.id || stableId(item.link || item.date)}`,
//     source: feed.id,
//     sourceName: feed.name,
//     category: feed.category,
//     country: feed.country,
//     title: cleanText(item.title?.rendered || item.title),
//     url: item.link,
//     publishedAt: item.date || item.date_gmt || item.modified || null,
//     summary: cleanText(item.excerpt?.rendered || item.content?.rendered || item.excerpt),
//     image: item._embedded?.["wp:featuredmedia"]?.[0]?.source_url || item.yoast_head_json?.og_image?.[0]?.url || null,
//   })).filter((item) => item.title && item.url);
// }
// 
// function parseHtmlNews(html, base) {
//   const out = [], seen = new Set();
//   for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{8,300}?)<\/a>/gi)) {
//     const title = cleanText(match[2]);
//     if (!title || seen.has(title) || /^(home|الرئيسية|المزيد|اقرأ|التفاصيل)$/i.test(title)) continue;
//     let url = match[1];
//     try { url = new URL(url, base).href; } catch {}
//     seen.add(title);
//     out.push({ id: stableId(url + title), title, url, publishedAt: null, summary: null, image: null });
//   }
//   return out;
// }
// 
// function parseFeed(xml) {
//   const entries = [
//     ...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1\s*>/gi),
//     ...xml.matchAll(/<rdf:Description\b[\s\S]*?<\/rdf:Description\s*>/gi),
//   ].map((match) => match[0]);
//   return entries.map((entry) => ({
//     id: stableId(extractLink(entry) || firstTag(entry, "guid") || firstTag(entry, "id")),
//     title: cleanText(firstTag(entry, "title")),
//     url: extractLink(entry),
//     guid: cleanText(firstTag(entry, "guid") || firstTag(entry, "id")),
//     publishedAt: cleanText(firstTag(entry, "pubDate") || firstTag(entry, "published") || firstTag(entry, "updated")),
//     summary: cleanText(firstTag(entry, "description") || firstTag(entry, "summary") || firstTag(entry, "content")),
//     image: extractImage(entry) || extractImage(firstTag(entry, "description") || firstTag(entry, "summary") || firstTag(entry, "content")),
//   })).filter((item) => item.title && item.url);
// }
// 
// function firstTag(xml, tag) {
//   return xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "";
// }
// function extractLink(xml) {
//   const atom = xml.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i);
//   return atom?.[1] ? decodeEntities(atom[1].trim()) : cleanText(firstTag(xml, "link") || firstTag(xml, "origLink"));
// }
// function extractImage(xml) {
//   const bingImage = xml.match(/<(?:News:Image|news:image|News:ImageLink|news:imagelink)\b[^>]*>([\s\S]*?)<\/(?:News:Image|news:image|News:ImageLink|news:imagelink)>/i);
//   const match = xml.match(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*url=["']([^"']+)["']/i)
//     || xml.match(/<img\b[^>]*src=["']([^"']+)["']/i)
//     || xml.match(/<image\b[\s\S]*?<url>([\s\S]*?)<\/url>/i);
//   const value = bingImage?.[1] || match?.[1];
//   return value ? decodeEntities(value.replace(/<!\[CDATA\[|\]\]>/g, "").trim()) : null;
// }
// function cleanText(value) {
//   if (!value) return "";
//   return decodeEntities(String(value).replace(/^\s*<!\[CDATA\[/i, "").replace(/\]\]>\s*$/i, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
// }
// function decodeEntities(value) {
//   return String(value).replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
//     const number = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10);
//     return Number.isFinite(number) ? String.fromCodePoint(number) : _;
//   }).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
// }
// 
// function normalizeCategory(value) {
//   if (!value) return null;
//   const needle = value.trim().toLocaleLowerCase("ar");
//   return Object.entries(CATEGORY_META).find(([id, meta]) => id === needle || meta.aliases.some((alias) => alias.toLocaleLowerCase("ar") === needle))?.[0] || null;
// }
// function deduplicate(articles) {
//   const seen = new Set();
//   return articles.filter((article) => {
//     const key = article.url || `${article.source}:${article.title}`;
//     if (seen.has(key)) return false;
//     seen.add(key);
//     return true;
//   });
// }
// function stableId(value) {
//   let hash = 0;
//   for (const char of String(value)) { hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0; }
//   return Math.abs(hash).toString(36);
// }
// function dateValue(value) {
//   const time = Date.parse(value || "");
//   return Number.isFinite(time) ? time : 0;
// }
// function clampInt(value, fallback, min, max) {
//   const number = Number.parseInt(value, 10);
//   return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
// }
// async function enrichArticleImages(articles) {
//   const pending = articles.filter((article) => !article.image && article.url).slice(0, 30);
//   let cursor = 0;
//   const workers = Array.from({ length: Math.min(6, pending.length) }, async () => {
//     while (cursor < pending.length) {
//       const article = pending[cursor++];
//       try {
//         const controller = new AbortController();
//         const timer = setTimeout(() => controller.abort(), 5000);
//         const response = await fetch(article.url, { signal: controller.signal, redirect: "follow", headers: { Accept: "text/html", "User-Agent": "ArabicNewsWorker/3.0" } });
//         const html = (await response.text()).slice(0, 250000);
//         clearTimeout(timer);
//         const match = html.match(/<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)/i)
//           || html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
//         if (match?.[1]) article.image = decodeEntities(match[1].trim());
//       } catch {}
//     }
//   });
//   await Promise.all(workers);
// }
// function corsHeaders(env) {
//   return {
//     "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
//     "Access-Control-Allow-Methods": "GET, OPTIONS",
//     "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
//     "Content-Type": "application/json; charset=utf-8",
//   };
// }
// function json(data, status, headers) {
//   return new Response(JSON.stringify(data, null, 2), { status, headers: new Headers(headers) });
// }
// ----- END LEGACY RSS SOURCES (DISABLED) -----
