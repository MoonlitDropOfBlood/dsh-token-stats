/**
 * Does the MiMo dashboard maintain its session server-side?
 *
 * 1. Does any response (incl. the 401) carry Set-Cookie / refresh hints?
 * 2. What does the official web app actually call? — download the SPA bundle
 *    from platform.xiaomimimo.com and grep it for the account API surface
 *    (serviceToken handling, refresh/rotate calls, /api/v1 paths).
 */
const HOST = "https://platform.xiaomimimo.com";

// ---- 1. headers on the 401 (no credentials needed) ----
{
  const res = await fetch(`${HOST}/api/v1/user/usage`, {
    method: "GET",
    headers: { accept: "application/json", "accept-language": "en" },
  });
  console.log(`[401 probe] status=${res.status}`);
  for (const [k, v] of res.headers) {
    if (/set-cookie|www-authenticate|location|sts|refresh/i.test(k)) {
      console.log(`  header ${k}: ${String(v).slice(0, 200)}`);
    }
  }
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  console.log(`  set-cookie count = ${sc.length}`);
}

// ---- 2. mine the SPA bundle for the real account API surface ----
{
  const page = await (await fetch(`${HOST}/`, { headers: { "user-agent": "Mozilla/5.0" } })).text();
  const srcs = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  console.log(`\n[SPA] ${srcs.length} script tag(s)`);
  let best = null;
  for (const s of srcs) {
    const url = s.startsWith("http") ? s : HOST + s;
    try {
      const body = await (await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } })).text();
      if (!best || body.length > best.size) best = { url, body, size: body.length };
    } catch (e) { /* skip */ }
  }
  if (!best) { console.log("[SPA] no bundle fetched"); process.exit(0); }
  console.log(`[SPA] largest bundle ${best.url.replace(HOST, "")} (${(best.size / 1024).toFixed(0)} KB)`);

  const hits = new Map();
  for (const re of [
    /\/api\/v1\/[A-Za-z0-9_\-/{}]*/g,
    /api-platform_[A-Za-z_]+/g,
    /(?:refresh|rotate|renew)["'`]?\s*[:(]/gi,
  ]) {
    for (const m of best.body.matchAll(re)) hits.set(m[0], (hits.get(m[0]) || 0) + 1);
  }
  const paths = [...hits.keys()].filter((k) => k.startsWith("/api/")).sort();
  console.log(`[SPA] /api/* paths (${paths.length}):`);
  for (const p of paths) console.log(`  ${p}`);
  const cookies = [...hits.keys()].filter((k) => k.startsWith("api-platform_"));
  console.log(`[SPA] cookie names: ${cookies.join(", ")}`);
  const refresh = [...hits.keys()].filter((k) => /refresh|rotate|renew/i.test(k));
  console.log(`[SPA] refresh-ish hits (${refresh.length}): ${refresh.slice(0, 20).join(" | ")}`);
  // where is serviceToken used?
  for (const m of best.body.matchAll(/.{90}api-platform_serviceToken.{90}/g)) {
    console.log(`[SPA] ctx: …${m[0]}…`);
    break;
  }
}
