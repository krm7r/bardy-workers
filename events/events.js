const G_MONTHS = {
  "يناير": 1, "فبراير": 2, "مارس": 3, "أبريل": 4, "مايو": 5, "يونيو": 6,
  "يوليو": 7, "أغسطس": 8, "سبتمبر": 9, "أكتوبر": 10, "نوفمبر": 11, "ديسمبر": 12,
};
const H_MONTHS = {
  "محرم": 1, "صفر": 2, "ربيع الأول": 3, "ربيع الآخر": 4, "جمادى الأولى": 5, "جمادى الآخرة": 6,
  "رجب": 7, "شعبان": 8, "رمضان": 9, "شوال": 10, "ذو القعدة": 11, "ذو الحجة": 12,
};
const ALLOWED_CALENDARS = new Set(["ميلادية", "هجرية", "قبطية"]);
const CACHE_SECONDS = 300;

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

function partsDate(timeZone, calendar) {
  const locale = calendar === "هجرية" ? "en-US-u-ca-islamic-umalqura" : "en-CA";
  const parts = new Intl.DateTimeFormat(locale, { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
  const out = {};
  for (const part of parts) if (["year", "month", "day"].includes(part.type)) out[part.type] = Number(part.value);
  return out;
}

function cleanText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function rankFor(row) {
  const text = cleanText(row.date_text);
  const match = text.match(/^(\d{1,2})\s+(.+)$/);
  if (!match) return null;
  const months = row.calendar === "ميلادية" ? G_MONTHS : row.calendar === "هجرية" ? H_MONTHS : null;
  if (!months || !months[match[2]]) return null;
  return months[match[2]] * 31 + Number(match[1]);
}

function currentRank(calendar) {
  const date = partsDate("Africa/Cairo", calendar);
  return date.month * 31 + date.day;
}

function outputRow(row) {
  return {
    التاريخ: cleanText(row.date_text),
    العنوان: cleanText(row.title),
    الوصف: cleanText(row.description),
    النوع: cleanText(row.type),
    التقويم: cleanText(row.calendar),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "GET") return json({ error: "GET فقط" }, 405, headers);
    if (env.API_KEY && request.headers.get("X-API-Key") !== env.API_KEY) return json({ error: "Unauthorized" }, 401, headers);

    if (["/", "/health", "/status", "/events"].includes(url.pathname.toLowerCase())) {
      if (url.pathname.toLowerCase() !== "/health" && url.pathname.toLowerCase() !== "/status" && url.pathname.toLowerCase() !== "/" && url.pathname.toLowerCase() !== "/events") {
        return json({ error: "المسار غير موجود" }, 404, headers);
      }
      try {
        const requested = url.searchParams.get("calendar");
        if (requested && !ALLOWED_CALENDARS.has(requested)) {
          return json({ error: "قيمة calendar يجب أن تكون ميلادية أو هجرية أو قبطية" }, 400, headers);
        }
        const where = requested ? " WHERE calendar = ?" : "";
        const statement = requested
          ? env.DB.prepare(`SELECT date_text,title,description,type,calendar FROM occasions${where}`).bind(requested)
          : env.DB.prepare("SELECT date_text,title,description,type,calendar FROM occasions");
        const result = await statement.all();
        const rows = result.results || [];
        const past = [];
        const upcoming = [];
        for (const row of rows) {
          const rank = rankFor(row);
          const now = row.calendar === "ميلادية" || row.calendar === "هجرية" ? currentRank(row.calendar) : null;
          if (rank !== null && now !== null && rank < now) past.push(row);
          else upcoming.push(row);
        }
        const sortUpcoming = (a, b) => (rankFor(a) ?? 9999) - (rankFor(b) ?? 9999) || cleanText(a.title).localeCompare(cleanText(b.title), "ar");
        upcoming.sort(sortUpcoming);
        past.sort((a, b) => (rankFor(b) ?? -1) - (rankFor(a) ?? -1) || cleanText(a.title).localeCompare(cleanText(b.title), "ar"));
        const pastLimit = clamp(url.searchParams.get("past_limit"), 2, 0, 20);
        const upcomingLimit = clamp(url.searchParams.get("upcoming_limit"), upcoming.length, 0, 500);
        const payload = {
          success: true,
          now: new Date().toISOString(),
          time_zone: "Africa/Cairo",
          calendar: requested || "الكل",
          past: past.slice(0, pastLimit).map(outputRow),
          upcoming: upcoming.slice(0, upcomingLimit).map(outputRow),
          counts: { past: past.length, upcoming: upcoming.length, total: rows.length },
        };
        const response = json(payload, 200, headers);
        response.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`);
        return response;
      } catch (error) {
        console.error("events_internal_error", error instanceof Error ? error.message : String(error));
        return json({ error: "تعذر تحميل المناسبات" }, 500, headers);
      }
    }
    return json({ error: "المسار غير موجود", available: ["/", "/events", "/health"] }, 404, headers);
  },
};

function clamp(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}
