/**
 * Live path discovery for the MiMo quota endpoints.
 *
 * Scans candidate quota paths on the Token Plan hosts (cn / sgp / ams) and the
 * PAYG host with the credential DSH already has, reporting status codes only.
 * The key itself is never printed.
 *
 *   node scripts/probe-mimo.mjs [refName]
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

const REF = process.argv[2] || "XIAOMI_TOKEN_PLAN_CN_API_KEY";
const key = pick(REF);
if (!key) {
  console.log(`ref ${REF} not found in .credentials.yaml`);
  process.exit(1);
}
console.log(`using ref ${REF} (len=${key.length}, head=${key.slice(0, 4)}…)\n`);

const HOSTS = [
  "https://token-plan-cn.xiaomimimo.com",
  "https://token-plan-sgp.xiaomimimo.com",
  "https://token-plan-ams.xiaomimimo.com",
  "https://api.xiaomimimo.com",
  "https://platform.xiaomimimo.com",
].filter((h) => !process.argv[3] || h.includes(process.argv[3]));
const PATHS = (
  process.argv[4]
    ? process.argv[4].split(",")
    : [
        "/v1/models", // liveness/auth probe only — never a quota source
        "/v1/tokenPlan/usage", // quotas crate TOKEN_PLAN_SGP_USAGE shape
        "/v1/tokenPlan/detail",
        "/v1/user/balance",
        "/v1/user/info",
        "/v1/me",
        "/v1/usage",
        "/v1/quota",
        "/v1/balance",
        "/v1/plan/usage",
        "/v1/subscription",
        "/v1/token-plan/usage",
        "/api/v1/tokenPlan/usage", // platform dashboard shape
        "/api/v1/user/balance",
      ]
);

async function hit(url, style) {
  const headers = { accept: "application/json", "user-agent": "dsh-token-stats-probe/1" };
  headers.authorization = style === "raw" ? key : "Bearer " + key;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: ac.signal });
    const body = await res.text();
    return { status: res.status, snippet: body.slice(0, 260).replace(/\s+/g, " ") };
  } catch (e) {
    return { status: "ERR", snippet: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

for (const host of HOSTS) {
  console.log("== " + host.replace("https://", ""));
  for (const p of PATHS) {
    const r = await hit(host + p, "bearer");
    const quotaPath = p !== "/v1/models";
    const flag = r.status === 200 && quotaPath ? "  <<< QUOTA OK" : r.status === 401 || r.status === 403 ? "  (auth)" : "";
    const snippet = r.snippet.startsWith("<") ? "(html)" : r.snippet.slice(0, 200);
    console.log(`  ${String(r.status).padEnd(4)} ${p.padEnd(30)} ${snippet}${flag}`);
  }
  console.log("");
}
