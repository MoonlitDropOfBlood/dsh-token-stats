/**
 * Can a MiMo API key (tp-...) read the dashboard quota API without a browser
 * cookie? Tests the plausible no-cookie shapes:
 *   - `api-platform_serviceToken` cookie slot (quoted / unquoted)
 *   - service-token style headers
 *   - alternate api hosts
 * Prints status + body snippet only; the key is never printed.
 *
 *   node scripts/probe-mimo-nocookie.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const yaml = readFileSync(join(DSH_HOME, ".credentials.yaml"), "utf8");
const pick = (ref) => {
  const m = yaml.match(new RegExp("^\\s*" + ref + "\\s*:\\s*(.+)$", "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
};
const key = pick(process.argv[2] || "XIAOMI_TOKEN_PLAN_CN_API_KEY");
if (!key) {
  console.log("no key");
  process.exit(1);
}
console.log(`key head=${key.slice(0, 4)}… len=${key.length}\n`);

const USAGE = "/api/v1/tokenPlan/usage";

/** [label, host, headers builder] */
const TRIALS = [
  ["platform + serviceToken cookie (quoted)", "https://platform.xiaomimimo.com", () => ({ cookie: `api-platform_serviceToken="${key}"`, accept: "application/json", "accept-language": "en" })],
  ["platform + serviceToken cookie (raw)", "https://platform.xiaomimimo.com", () => ({ cookie: `api-platform_serviceToken=${key}`, accept: "application/json", "accept-language": "en" })],
  ["platform + X-Service-Token", "https://platform.xiaomimimo.com", () => ({ "x-service-token": key, accept: "application/json" })],
  ["platform + Authorization tp (no Bearer)", "https://platform.xiaomimimo.com", () => ({ authorization: key, accept: "application/json" })],
  ["platform + ?apiKey= query", "https://platform.xiaomimimo.com", () => ({ accept: "application/json" })],
  ["api-platform host + Bearer", "https://api-platform.xiaomimimo.com", () => ({ authorization: `Bearer ${key}`, accept: "application/json" })],
  ["account host + Bearer", "https://account.xiaomimimo.com", () => ({ authorization: `Bearer ${key}`, accept: "application/json" })],
  ["open host + Bearer", "https://open.xiaomimimo.com", () => ({ authorization: `Bearer ${key}`, accept: "application/json" })],
  ["token-plan-cn + Bearer usage", "https://token-plan-cn.xiaomimimo.com", () => ({ authorization: `Bearer ${key}`, accept: "application/json" })],
];

async function get(url, headers) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: ac.signal });
    const body = await res.text();
    return { status: res.status, snippet: (body.startsWith("<") ? "(html)" : body).slice(0, 220).replace(/\s+/g, " ") };
  } catch (e) {
    return { status: "ERR", snippet: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

for (const [label, host, headers] of TRIALS) {
  const url = label.includes("?apiKey") ? `${host}${USAGE}?apiKey=${encodeURIComponent(key)}` : host + USAGE;
  const r = await get(url, headers());
  console.log(`${String(r.status).padEnd(4)} ${label.padEnd(42)} ${r.snippet}`);
}

// POST probes: does a key→token exchange exist?
for (const [label, url] of [
  ["POST platform /api/v1/sts", "https://platform.xiaomimimo.com/api/v1/sts"],
  ["POST platform /api/v1/auth/sts", "https://platform.xiaomimimo.com/api/v1/auth/sts"],
  ["POST platform /api/v1/user/login", "https://platform.xiaomimimo.com/api/v1/user/login"],
]) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ apiKey: key }),
      signal: ac.signal,
    });
    const body = await res.text();
    console.log(`${String(res.status).padEnd(4)} ${label.padEnd(42)} ${(body.startsWith("<") ? "(html)" : body).slice(0, 200).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`ERR  ${label.padEnd(42)} ${String((e && e.message) || e)}`);
  } finally {
    clearTimeout(timer);
  }
}
