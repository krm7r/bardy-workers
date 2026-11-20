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

const CACHE_SECONDS = 300;
const DAY = 86400000;
const ALLOWED_CALENDARS = new Set(["ميلادية", "هجرية", "قبطية"]);
// مناسبة تُعتبر «فائتة» لو مرّت خلال آخر 30 يومًا، وبعدها تظهر كمناسبة قادمة في السنة التالية.
const RECENT_PAST_DAYS = 30;

const norm = (v) => String(v ?? "").replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ").trim();
const mapOf = (list) => Object.fromEntries(Object.entries(list).map(([k, v]) => [norm(k), v]));
const G_MONTHS = mapOf({ يناير: 1, فبراير: 2, مارس: 3, أبريل: 4, ابريل: 4, مايو: 5, يونيو: 6, يوليو: 7, أغسطس: 8, اغسطس: 8, سبتمبر: 9, أكتوبر: 10, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12 });
const H_MONTHS = mapOf({ محرم: 1, صفر: 2, "ربيع الأول": 3, "ربيع الآخر": 4, "ربيع الثاني": 4, "جمادى الأولى": 5, "جمادى الآخرة": 6, "جمادى الثانية": 6, رجب: 7, شعبان: 8, رمضان: 9, شوال: 10, "ذو القعدة": 11, "ذو الحجة": 12 });
const C_MONTHS = mapOf({ توت: 1, بابه: 2, هاتور: 3, كيهك: 4, طوبه: 5, أمشير: 6, امشير: 6, برمهات: 7, برمودة: 8, بشنس: 9, بؤونة: 10, بئونة: 10, بونه: 10, أبيب: 11, ابيب: 11, مسرى: 12, النسيء: 13, نسيء: 13 });
const MONTHS = { "ميلادية": G_MONTHS, "هجرية": H_MONTHS, "قبطية": C_MONTHS };
const YEAR_LEN = { "ميلادية": 365, "هجرية": 354, "قبطية": 365 };
const INTL_CAL = { "هجرية": "en-US-u-ca-islamic-umalqura", "قبطية": "en-US-u-ca-coptic" };

function corsHeaders() {
  // لا CORS: العامل يُستدعى من الخادم فقط.
  return { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: new Headers(headers) });
}

function cleanText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function latinDigits(v) {
  return String(v).replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
}

// تاريخ اليوم بتوقيت القاهرة (ميلادي) كرقم UTC منتصف الليل
function cairoToday() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
  const o = {};
  for (const x of p) if (["year", "month", "day"].includes(x.type)) o[x.type] = Number(x.value);
  return { ...o, base: Date.UTC(o.year, o.month - 1, o.day) };
}

// خريطة «شهر-يوم» ← عدد الأيام من اليوم، للتقويم الهجري/القبطي (تُحسب مرة واحدة يوميًا لكل نسخة من العامل)
const offsetCache = new Map();
function offsetMap(calendar, base) {
  const key = calendar + base;
  if (offsetCache.has(key)) return offsetCache.get(key);
  if (offsetCache.size > 6) offsetCache.clear();
  const fmt = new Intl.DateTimeFormat(INTL_CAL[calendar], { timeZone: "UTC", month: "numeric", day: "numeric" });
  const map = new Map();
  for (let off = 0; off <= YEAR_LEN[calendar] + 1; off++) {
    const k = fmt.format(new Date(base + off * DAY + 12 * 3600000)).replace(/\s/g, "").replace("/", "-");
    if (!map.has(k)) map.set(k, off);
  }
  offsetCache.set(key, map);
  return map;
}

// يرجع { day, month } من النص مثل «15 مايو» أو «٢٧ رمضان»، أو null لو الموعد متغير/غير مفهوم
function parseDate(row) {
  const text = norm(latinDigits(cleanText(row.date_text)));
  const m = text.match(/^(\d{1,2})\s+(.+)$/);
  const months = MONTHS[row.calendar];
  if (!m || !months || !months[m[2]]) return null;
  return { day: Number(m[1]), month: months[m[2]] };
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// يحسب days_until (0 = اليوم) و days_since وتاريخ التكرار القادم/السابق (ميلادي)
function timing(row, today) {
  const d = parseDate(row);
  if (!d) return null;
  if (row.calendar === "ميلادية") {
    const at = (y) => { const t = Date.UTC(y, d.month - 1, d.day); return new Date(t).getUTCMonth() === d.month - 1 ? t : null; };
    let next = null, prev = null;
    for (const y of [today.year - 1, today.year, today.year + 1, today.year + 2]) {
      const t = at(y); if (t === null) continue;
      if (t >= today.base && next === null) next = t;
      if (t < today.base) prev = t;
    }
    if (next === null) return null;
    return { days_until: Math.round((next - today.base) / DAY), days_since: prev === null ? null : Math.round((today.base - prev) / DAY), next_date: iso(next), approx: false };
  }
  const off = offsetMap(row.calendar, today.base).get(`${d.month}-${d.day}`);
  if (off === undefined) return null;
  const since = YEAR_LEN[row.calendar] - off;
  return { days_until: off, days_since: since, next_date: iso(today.base + off * DAY), approx: row.calendar === "هجرية" };
}

function outputRow(row, t) {
  return {
    التاريخ: cleanText(row.date_text),
    العنوان: cleanText(row.title),
    الوصف: cleanText(row.description),
    النوع: cleanText(row.type),
    التقويم: cleanText(row.calendar),
    days_until: t ? t.days_until : null,
    days_since: t ? t.days_since : null,
    next_date: t ? t.next_date : null,
    approx: t ? t.approx : false,
  };
}

function clamp(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}

export default {
  async fetch(request, env) {
    if (!isAuthorized(request, env)) return notFound();
    const url = new URL(request.url);
    const headers = corsHeaders();
    if (request.method !== "GET") return json({ error: "GET فقط" }, 405, headers);
    const path = url.pathname.toLowerCase();
    if (!["/", "/health", "/status", "/events"].includes(path)) return json({ error: "المسار غير موجود" }, 404, headers);
    try {
      const requested = url.searchParams.get("calendar");
      if (requested && !ALLOWED_CALENDARS.has(requested)) return json({ error: "قيمة calendar يجب أن تكون ميلادية أو هجرية أو قبطية" }, 400, headers);
      const statement = requested
        ? env.DB.prepare("SELECT date_text,title,description,type,calendar FROM occasions WHERE calendar = ?").bind(requested)
        : env.DB.prepare("SELECT date_text,title,description,type,calendar FROM occasions");
      const rows = (await statement.all()).results || [];
      const today = cairoToday();
      const past = [], upcoming = [];
      for (const row of rows) {
        let t = null;
        try { t = timing(row, today); } catch { t = null; }
        const item = { row, t };
        if (t && t.days_since !== null && t.days_since >= 1 && t.days_since <= RECENT_PAST_DAYS && t.days_until > t.days_since) past.push(item);
        else upcoming.push(item);
      }
      const byTitle = (a, b) => cleanText(a.row.title).localeCompare(cleanText(b.row.title), "ar");
      upcoming.sort((a, b) => (a.t ? a.t.days_until : 99999) - (b.t ? b.t.days_until : 99999) || byTitle(a, b));
      past.sort((a, b) => a.t.days_since - b.t.days_since || byTitle(a, b));
      const pastLimit = clamp(url.searchParams.get("past_limit"), 8, 0, 30);
      const upcomingLimit = clamp(url.searchParams.get("upcoming_limit"), upcoming.length, 0, 500);
      const payload = {
        success: true,
        now: new Date().toISOString(),
        today: iso(today.base),
        time_zone: "Africa/Cairo",
        calendar: requested || "الكل",
        past: past.slice(0, pastLimit).map((x) => outputRow(x.row, x.t)),
        upcoming: upcoming.slice(0, upcomingLimit).map((x) => outputRow(x.row, x.t)),
        counts: { past: past.length, upcoming: upcoming.length, total: rows.length },
      };
      const response = json(payload, 200, headers);
      response.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`);
      return response;
    } catch (error) {
      console.error("events_internal_error", error instanceof Error ? error.message : String(error));
      return json({ error: "تعذر تحميل المناسبات" }, 500, headers);
    }
  },
};
