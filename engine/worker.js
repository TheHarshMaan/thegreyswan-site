// The Grey Swan Engine: a small Cloudflare Worker that sits between thegreyswan.in and OpenAlex.
//
// What it does
//   - Adds The Grey Swan's own OpenAlex API key, so visitors don't need one (the key is stored as a Cloudflare secret,
//     never in the website's code).
//   - Remembers answers for a day (Cloudflare's cache), so repeated searches are fast and use fewer requests.
//   - Only answers the website itself (by origin), only GET requests, and only for api.openalex.org.
//
// "Leave a mark" (the night sky on the homepage): visitors place a star. The engine keeps the stars (a position and
// a date), a count per day and per country, in Cloudflare KV. It keeps no IP addresses: a short, salted fingerprint of
// the address is held for ten minutes only, so one person can't fill the sky.
//
// What it never sees: manuscripts. The website reads manuscripts in the visitor's browser; only the same search
// terms that would otherwise go straight to OpenAlex pass through here. Nothing is stored apart from the cached
// OpenAlex answers, which are public data.
//
// Set-up: see README.md in this folder.

const UPSTREAM = "https://api.openalex.org";
const CACHE_SECONDS = 86400;           // one day

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "https://thegreyswan.in,https://www.thegreyswan.in")
      .split(",").map((o) => o.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/health") return json({ ok: true, key: Boolean(env.OPENALEX_KEY), marks: Boolean(env.MARKS) }, 200, cors);
    if (url.pathname === "/marks") return marks(request, env, ctx, cors, origin, allowed);
    if (request.method !== "GET") return json({ error: "Only GET requests are answered." }, 405, cors);
    if (origin && !allowed.includes(origin)) return json({ error: "This engine only answers The Grey Swan's website." }, 403, cors);
    if (!url.pathname.startsWith("/openalex/")) return json({ error: "Not found." }, 404, cors);

    // The OpenAlex request: same path and parameters, with our key and contact address instead of any sent along
    const target = new URL(UPSTREAM + url.pathname.slice("/openalex".length));
    for (const [k, v] of url.searchParams) if (k !== "api_key" && k !== "mailto") target.searchParams.append(k, v);
    if (env.CONTACT_EMAIL) target.searchParams.set("mailto", env.CONTACT_EMAIL);
    const cacheKey = new Request(target.toString(), { method: "GET" });      // without the key
    if (env.OPENALEX_KEY) target.searchParams.set("api_key", env.OPENALEX_KEY);

    const cache = caches.default;
    let res = await cache.match(cacheKey);
    let hit = true;
    if (!res) {
      hit = false;
      const upstream = await fetch(target.toString(), { headers: { "Accept": "application/json" } });
      res = new Response(upstream.body, upstream);
      if (upstream.status === 200) {
        res.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
      }
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    out.headers.set("X-Grey-Swan-Cache", hit ? "hit" : "miss");
    return out;
  },
};

// ---------------------------------------------------------------------------
// Leave a mark
// ---------------------------------------------------------------------------
const SKY = "sky";                 // the one KV record
const KEEP_MARKS = 600;            // stars kept for drawing (the count goes on beyond this)
const AGAIN_AFTER = 10 * 60 * 1000;

async function marks(request, env, ctx, cors, origin, allowed) {
  if (!env.MARKS) return json({ error: "The sky isn't set up yet." }, 503, cors);
  const cache = caches.default;
  const cacheKey = new Request(new URL("/marks", request.url).toString(), { method: "GET" });

  if (request.method === "GET") {
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(hit, cors);
    const sky = await load(env);
    const res = json(publicView(sky), 200, { ...cors, "Cache-Control": "public, max-age=30" });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }
  if (request.method !== "POST") return json({ error: "Only GET and POST." }, 405, cors);
  if (!allowed.includes(origin)) return json({ error: "Marks can only be left from The Grey Swan's website." }, 403, cors);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Send x and y." }, 400, cors); }
  const x = Number(body && body.x), y = Number(body && body.y);
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return json({ error: "x and y must be between 0 and 1." }, 400, cors);

  const now = Date.now();
  const who = await fingerprint(request.headers.get("CF-Connecting-IP") || "", env);
  const sky = await load(env);
  sky.recent = (sky.recent || []).filter((r) => now - r.t < AGAIN_AFTER);
  if (sky.recent.some((r) => r.h === who)) return json({ error: "You've just left a mark. Come back later for another." }, 429, cors);

  const day = new Date(now).toISOString().slice(0, 10);
  const country = (request.cf && request.cf.country) || "";
  sky.total = (sky.total || 0) + 1;
  sky.marks = [...(sky.marks || []), { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, d: day }].slice(-KEEP_MARKS);
  sky.days = { ...(sky.days || {}), [day]: ((sky.days || {})[day] || 0) + 1 };
  if (country) sky.countries = { ...(sky.countries || {}), [country]: ((sky.countries || {})[country] || 0) + 1 };
  sky.recent.push({ h: who, t: now });
  await env.MARKS.put(SKY, JSON.stringify(sky));
  ctx.waitUntil(cache.delete(cacheKey));
  return json({ ok: true, number: sky.total, ...publicView(sky) }, 200, cors);
}

async function load(env) {
  try { return JSON.parse((await env.MARKS.get(SKY)) || "{}"); } catch (e) { return {}; }
}

function publicView(sky) {
  const today = new Date().toISOString().slice(0, 10);
  return { total: sky.total || 0, today: (sky.days || {})[today] || 0, marks: sky.marks || [],
           days: sky.days || {}, countries: sky.countries || {} };
}

async function fingerprint(ip, env) {
  const data = new TextEncoder().encode(`${env.MARK_SALT || "grey-swan"}:${ip}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function withCors(res, cors) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
