// The Grey Swan Engine: a small Cloudflare Worker that sits between thegreyswan.in and OpenAlex.
//
// What it does
//   - Adds The Grey Swan's own OpenAlex API key, so visitors don't need one (the key is stored as a Cloudflare secret,
//     never in the website's code).
//   - Remembers answers for a day (Cloudflare's cache), so repeated searches are fast and use fewer requests.
//   - Only answers the website itself (by origin), only GET requests, and only for api.openalex.org.
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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/health") return json({ ok: true, key: Boolean(env.OPENALEX_KEY) }, 200, cors);
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

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
