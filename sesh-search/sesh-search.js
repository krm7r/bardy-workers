// Cloudflare Worker — Bardy Web Search API
// Required bindings: DB, WEB_DB
// Supported secrets: FIRECRAWL_API_KEY_1 ... FIRECRAWL_API_KEY_5
// Legacy aliases also supported: FIRECRAWL_KEY_1 ... FIRECRAWL_KEY_5 and FIRECRAWL_API_KEY

// Content filter. Terms are stored as one-way hashes of normalized WHOLE words / short phrases,
// so no listed term appears in this source and innocent words that merely contain a
// listed string (city names, "nationality", "Essex", ...) are no longer blocked.
const BLOCKED_HASHES = new Set([
  5912217812722458,
    6927323646146917,
    7627963825474724,
    4232131832333282,
    798722756869965,
    6682571654302442,
    6176381438557104,
    919852066747451,
    4120570015926373,
    1397377425412071,
    8700310220468196,
    3938996052474350,
    1663239089952460,
    2876236078311564,
    5171047038256182,
    2965822230808063,
    1707992303352495,
    1802994843469075,
    7207919243553637,
    3472689217863387,
    267720216447588,
    2342391921444938,
    2881265600411458,
    7078049096534855,
    5414484210100348,
    2498029919195654,
    8759549754819262,
    790150659295255,
    5274767727896747,
    985149921145378,
    3652391193513843,
    12565140382933,
    1893436474764874,
    2134449448734661,
    3216010151548641,
    1587363916334973,
    8471347545481488,
    174090120632721,
    7196604920509346,
    4344179433209843,
    5249934388184234,
    652531925787678,
    8681728570687937,
    4479988630071208,
    3301847374985081,
    7150300085865377,
    3583076378290377,
    5729062255510931,
    6631306892554195,
    7096561654093171,
    8271086081066080,
    791953761371194,
    4096723602352636,
    658378780749801,
    8032157924898010,
    3844558296873950,
    1063016826823786,
    3259333095990210,
    2532284088066406,
    1675770691794397,
    8620720931496316,
    6594626047048154,
    3882584650007459,
    1586397071227572,
    6844234915737768,
    1460355627650978,
    1923143487551965,
    8181682643635744,
    4023340197378675,
    7398679472604553,
    5756981181506617,
    2165012370669036,
    820538155841969,
    1385617495512567,
    7746573850376167,
    3028998813773587,
]);
const ARABIC_PREFIXES_LONG = ['وال', 'بال', 'كال', 'فال', 'لل', 'ال'];
const ARABIC_PREFIXES_SHORT = ['و', 'ب', 'ل', 'ف', 'ك'];

const WINDOW_SECONDS = 60;
const MAX_QUERY_LENGTH = 350; // up to 350 chars are accepted (was a hard 200 that surfaced as a misleading "blocked_query")
const MAX_PAGE = 5; // deeper pages cost proportionally more Firecrawl credits

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

async function hashIp(ip, env) {
  const data = new TextEncoder().encode(String(env.IP_SALT || 'bardy') + ':' + ip);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('ar')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// cyrb53: small, fast 53-bit string hash.
function hashWord(word) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < word.length; i++) {
    const ch = word.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function wordForms(word) {
  const forms = [word];
  for (const p of ARABIC_PREFIXES_LONG) if (word.startsWith(p) && word.length - p.length >= 2) forms.push(word.slice(p.length));
  for (const p of ARABIC_PREFIXES_SHORT) if (word.startsWith(p) && word.length - p.length >= 4) forms.push(word.slice(p.length));
  if (/^[a-z]{5,}s$/.test(word)) forms.push(word.slice(0, -1));
  return forms;
}

function isBlocked(value) {
  const words = normalize(value).replace(/ة/g, 'ه').split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const forms = wordForms(words[i]);
    if (forms.some(form => BLOCKED_HASHES.has(hashWord(form)))) return true;
    if (i + 1 < words.length) {
      const next = wordForms(words[i + 1]);
      for (const a of forms) for (const b of next) if (BLOCKED_HASHES.has(hashWord(a + ' ' + b))) return true;
    }
  }
  return false;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...headers,
    },
  });
}

async function rateLimit(env, request) {
  const now = Math.floor(Date.now() / 1000);
  const ip = await hashIp(request.headers.get('CF-Connecting-IP') || 'unknown', env);
  const results = await env.WEB_DB.batch([
    env.WEB_DB.prepare('DELETE FROM request_log WHERE created_at<?').bind(now - WINDOW_SECONDS),
    env.WEB_DB.prepare('SELECT count(*) c FROM request_log WHERE ip_hash=? AND created_at>=?').bind(ip, now - WINDOW_SECONDS),
    env.WEB_DB.prepare('INSERT INTO request_log VALUES(?,?,?)').bind(ip, now, now),
  ]);
  return Number(results[1].results[0].c) < 30;
}

async function databaseSearch(env, query, page) {
  const normalizedQuery = normalize(query);
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  const offset = (page - 1) * 3;
  // Short queries keep the exact-phrase behaviour. Long ones (4+ words) can never match as one phrase,
  // so they use the first 5 words with AND semantics.
  const useWords = tokens.length > 3;
  const words = tokens.slice(0, 5);
  const ftsQuery = useWords ? words.map(w => '"' + w.replaceAll('"', '""') + '"').join(' ') : '"' + normalizedQuery.replaceAll('"', '""') + '"';
  const likeTerms = useWords ? words : [normalizedQuery];

  const local = await env.DB.prepare(
    'SELECT p.url,p.title,p.description FROM search_index_fts f JOIN search_index i ON i.rowid=f.rowid JOIN pages p ON p.url=i.url WHERE search_index_fts MATCH ? LIMIT 3 OFFSET ' + offset,
  ).bind(ftsQuery).all();
  const where = likeTerms.map(() => '(title LIKE ? OR description LIKE ?)').join(' AND ');
  const web = await env.WEB_DB.prepare(
    'SELECT url,title,description FROM web_results WHERE ' + where + ' ORDER BY last_seen DESC LIMIT 3 OFFSET ' + offset,
  ).bind(...likeTerms.flatMap(term => ['%' + term + '%', '%' + term + '%'])).all();

  return [...(local.results || []), ...(web.results || [])]
    .filter(item => item.url && !isBlocked(`${item.title} ${item.description} ${item.url}`))
    .filter((item, index, all) => all.findIndex(other => other.url === item.url) === index)
    .slice(0, 3);
}

function firecrawlKeys(env) {
  const indexed = Array.from({ length: 5 }, (_, index) => [
    env[`FIRECRAWL_API_KEY_${index + 1}`],
    env[`FIRECRAWL_KEY_${index + 1}`],
  ]).flat();
  return [...new Set([
    ...indexed,
    env.FIRECRAWL_API_KEY,
    env.FIRECRAWL_KEY,
  ].map(value => String(value || '').trim()).filter(Boolean))];
}

async function firecrawlSearch(query, env, page) {
  const keys = firecrawlKeys(env);
  const requested = Math.min(page * 5, 100);
  let lastSuccessful = [];
  const deadline = Date.now() + Number(env.FIRECRAWL_BUDGET_MS || 14000);

  for (const key of keys) {
    const remaining = deadline - Date.now();
    if (remaining < 2500) break; // not enough time left for another attempt
    try {
      const response = await fetch('https://api.firecrawl.dev/v2/search', {
        signal: AbortSignal.timeout(Math.min(9000, remaining)),
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + key,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ query, limit: requested }),
      });
      if (!response.ok) continue;

      const payload = await response.json();
      const raw = payload.data?.web || payload.web || [];
      const results = raw
        .filter(item => item.url && !isBlocked(`${item.title} ${item.description} ${item.url}`))
        .map(item => ({
          url: item.url,
          title: item.title || '',
          description: (item.description || '').slice(0, 500),
        }));
      lastSuccessful = results;
      if (results.length) return results.slice((page - 1) * 5, page * 5);
    } catch {
      // Try the next key without exposing provider errors to the API response.
    }
  }
  return lastSuccessful.slice((page - 1) * 5, page * 5);
}

async function saveResults(env, query, results) {
  const now = Math.floor(Date.now() / 1000);
  const normalizedQuery = normalize(query);
  const statements = results.map(item => env.WEB_DB.prepare(
    'INSERT INTO web_results(url,title,description,query_norm,source,first_seen,last_seen) VALUES(?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET title=excluded.title,description=excluded.description,query_norm=CASE WHEN instr("|"||web_results.query_norm||"|","|"||excluded.query_norm||"|")=0 THEN web_results.query_norm||" | "||excluded.query_norm ELSE web_results.query_norm END,last_seen=excluded.last_seen',
  ).bind(item.url, item.title, item.description, normalizedQuery, 'firecrawl', now, now));
  if (statements.length) await env.WEB_DB.batch(statements);
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const query = url.searchParams.get('q')?.trim();
      const page = Math.max(1, Math.min(MAX_PAGE, parseInt(url.searchParams.get('page') || '1', 10) || 1));

      if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
      if (request.method !== 'GET' || url.pathname !== '/search') return json({ error: 'not_found' }, 404);
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
      if (!query) return json({ error: 'missing_query' }, 400);
      if (query.length > MAX_QUERY_LENGTH) return json({ error: 'query_too_long', code: 'query_too_long', max_length: MAX_QUERY_LENGTH }, 400);
      if (isBlocked(query)) return json({ error: 'blocked_query' }, 400);

      const cacheKey = new Request(url.origin + '/search?q=' + encodeURIComponent(query) + '&page=' + page);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;

      if (!await rateLimit(env, request)) {
        return json({ error: 'rate_limited' }, 429, { 'retry-after': String(WINDOW_SECONDS) });
      }

      const firecrawl = await firecrawlSearch(query, env, page);
      const database = await databaseSearch(env, query, page);
      const results = [...firecrawl, ...database]
        .filter((item, index, all) => all.findIndex(other => other.url === item.url) === index)
        .slice(0, 8);

      if (firecrawl.length) ctx.waitUntil(saveResults(env, query, firecrawl));

      // Response shape intentionally unchanged.
      const response = json({
        query,
        page,
        page_size: 8,
        has_next: firecrawl.length >= 5 || database.length >= 3,
        source: firecrawl.length ? (database.length ? 'mixed' : 'firecrawl') : 'database',
        results,
      }, 200, { 'cache-control': 'public, max-age=3600, s-maxage=3600' });

      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      console.error('search_unavailable', error instanceof Error ? error.message : String(error));
      return json({ error: 'search_unavailable' }, 503);
    }
  },
};
