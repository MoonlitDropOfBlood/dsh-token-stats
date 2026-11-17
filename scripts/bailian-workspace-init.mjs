/**
 * bailian-workspace-init.mjs — 修复 RAM 子账号 BailianGateway.Team.NotAuthorised。
 *
 * 官方 `bl workspace init`（modelstudioai/cli packages/commands/src/commands/workspace/init.ts）
 * 的**授权子集**：只跑步 0-5（换 token → loginInfo → [initSpace] → CreateUser →
 * ListWorkspaces → ChangeUserPermissions/ResetPolicies4Agent），
 * **刻意跳过步 6-8 的后付费服务开通（buyPostpaidCommodity 等计费副作用）**。
 *
 * 作用：把当前 AK/SK 对应的 RAM 用户登记为百炼控制台用户并授予默认业务空间
 * 成员策略（policyIndexList=[1]），使 /cli/api.json 的个人版配额 RPC 不再
 * 返回 BailianGateway.Team.NotAuthorised。CreateUser 幂等（already exists 忽略）。
 *
 * 凭据：~/.dsh/.credentials.yaml refs 或 env 的
 * ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET（+可选 STS）。
 * 只读探针风格：绝不打印 AK/SK/token 明文。
 *
 * 契约来源：packages/core/src/client/bailian-control.ts（BailianControl ROA，
 * host bailiancontrol.<region>.aliyuncs.com，version 2024-08-16）+ client/acs.ts。
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  acs3SignedHeaders,
  buildTokenRequest,
  parseTokenResponse,
  buildGatewayRequest,
  parseGatewayResponse,
  BAILIAN_USAGE_API,
  BAILIAN_LOGIN_INFO_API,
} from "../bailian-quota.js";

const REGION = process.argv.includes("--region") ? process.argv[process.argv.indexOf("--region") + 1] : "cn-beijing";
const CONTROL_HOST = `bailiancontrol.${REGION}.aliyuncs.com`;
const CONTROL_VERSION = "2024-08-16";
const TIMEOUT = 15000;

function readCred() {
  const out = { ak: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || null, sk: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || null, sts: process.env.ALIBABA_CLOUD_SECURITY_TOKEN || null };
  const f = join(homedir(), ".dsh", ".credentials.yaml");
  if (existsSync(f)) {
    const s = readFileSync(f, "utf8");
    const grab = (ref) => {
      const m = s.match(new RegExp("^\\s+" + ref + ":\\s*(.+)$", "m"));
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
    };
    out.ak = out.ak || grab("ALIBABA_CLOUD_ACCESS_KEY_ID");
    out.sk = out.sk || grab("ALIBABA_CLOUD_ACCESS_KEY_SECRET");
    out.sts = out.sts || grab("ALIBABA_CLOUD_SECURITY_TOKEN");
  }
  return out;
}

const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
function canonicalQuery(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(String(v))}`)
    .join("&");
}

async function controlCall(cred, { method, path, action, bodyObj, queryParams }) {
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const query = queryParams ? canonicalQuery(queryParams) : "";
  const headers = acs3SignedHeaders({
    accessKeyId: cred.ak,
    accessKeySecret: cred.sk,
    securityToken: cred.sts || undefined,
    host: CONTROL_HOST,
    path,
    action,
    version: CONTROL_VERSION,
    method,
    query,
    body,
  });
  const url = `https://${CONTROL_HOST}${path}${query ? "?" + query : ""}`;
  const res = await fetch(url, { method, headers, body: body || undefined, signal: AbortSignal.timeout(TIMEOUT) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* XML 错误体 */ }
  return { status: res.status, json, text };
}

function controlError(r) {
  const code = r.json?.Code || r.json?.code || "";
  const msg = r.json?.Message || r.json?.message || r.text.slice(0, 200);
  const authAction = r.json?.AccessDeniedDetail?.AuthAction || "";
  return { code, msg, authAction };
}

const mask = (s) => (typeof s === "string" && s.length > 8 ? s.slice(0, 4) + "…" + s.slice(-4) + `(len=${s.length})` : "****");

(async () => {
  const cred = readCred();
  if (!cred.ak || !cred.sk) {
    console.log("缺少 ALIBABA_CLOUD_ACCESS_KEY_ID / SECRET（凭据库或 env）。先在设置页「百炼 Token Plan 凭据」卡片保存。");
    process.exit(0);
  }
  console.log(`== 百炼业务空间授权（官方 workspace init 步 0-5，跳过计费开通）  region=${REGION}`);
  console.log(`   AK=${mask(cred.ak)}`);

  // 步 0：换 cliAccessToken
  const treq = buildTokenRequest({ accessKeyId: cred.ak, accessKeySecret: cred.sk, securityToken: cred.sts || undefined, region: REGION });
  const tres = await fetch(treq.url, { method: "POST", headers: treq.headers, body: treq.body, signal: AbortSignal.timeout(TIMEOUT) });
  const tparsed = parseTokenResponse(tres.status, await tres.text());
  if (!tparsed.ok) {
    console.log("❌ 步0 换 token 失败:", tparsed.message);
    process.exit(1);
  }
  const token = tparsed.token;
  console.log(`✅ 步0 cliAccessToken（${mask(token)}）`);

  // 步 1：loginInfo → uid / spaceInited
  const gcall = async (api, data = {}) => {
    const req = buildGatewayRequest({ region: REGION, site: "domestic", api, data, token });
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT) });
    return parseGatewayResponse(res.status, await res.text());
  };
  const login = await gcall(BAILIAN_LOGIN_INFO_API);
  if (!login.ok) {
    console.log("❌ 步1 loginInfo 失败:", login.message);
    process.exit(1);
  }
  const loginData = login.payload?.data ?? login.payload;
  const uid = loginData?.aliyun?.uid;
  const spaceInited = loginData?.spaceInited === true;
  console.log(`✅ 步1 loginInfo: uid=${uid} subAccount=${loginData?.aliyun?.subAccount} spaceInited=${spaceInited}`);
  if (!uid) {
    console.log("❌ loginInfo 未给 aliyun.uid，无法继续");
    process.exit(1);
  }

  // 步 2：空间未初始化才 initSpace（无计费副作用）
  if (!spaceInited) {
    const init = await gcall("zeldaEasy.bailian-dash-workspace.space.initSpace");
    console.log(init.ok ? "✅ 步2 initSpace 完成" : "❌ 步2 initSpace 失败: " + init.message);
    if (!init.ok) process.exit(1);
  } else {
    console.log("✅ 步2 空间已初始化，跳过 initSpace");
  }

  // 步 3：CreateUser（幂等）
  const create = await controlCall(cred, {
    method: "POST",
    path: "/bailianControl/User/createUser",
    action: "CreateUser",
    bodyObj: { data: JSON.stringify({ reqDTO: { outerKey: uid, nickName: uid, userName: uid } }) },
  });
  if (create.status >= 200 && create.status < 300 && create.json?.Success !== false) {
    console.log("✅ 步3 CreateUser 完成");
  } else {
    const e = controlError(create);
    if (/already exists/i.test(e.msg) || /already exists/i.test(create.text)) {
      console.log("✅ 步3 控制台用户已存在，继续");
    } else {
      console.log(`❌ 步3 CreateUser 失败: HTTP ${create.status} ${e.code} ${e.msg}`);
      if (e.authAction) console.log(`   → RAM 策略需补充 Action: ${e.authAction}`);
      process.exit(1);
    }
  }

  // 步 4：ListWorkspaces → agentId（默认空间 tenantId）
  const list = await controlCall(cred, {
    method: "GET",
    path: "/bailianControl/workspaces",
    action: "ListWorkspaces",
    queryParams: { data: JSON.stringify({ reqDTO: {}, cornerstoneParam: {} }) },
  });
  if (!(list.status >= 200 && list.status < 300) || list.json?.Success === false) {
    const e = controlError(list);
    console.log(`❌ 步4 ListWorkspaces 失败: HTTP ${list.status} ${e.code} ${e.msg}`);
    if (e.authAction) console.log(`   → RAM 策略需补充 Action: ${e.authAction}`);
    process.exit(1);
  }
  const workspaces = list.json?.data?.data;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    console.log("❌ 步4 ListWorkspaces 返回空:", JSON.stringify(list.json).slice(0, 300));
    process.exit(1);
  }
  const chosen = workspaces.find((w) => w?.defaultAgent === true) ?? workspaces[0];
  const agentId = typeof chosen?.tenantId === "string" ? Number(chosen.tenantId) : chosen?.tenantId;
  console.log(`✅ 步4 默认业务空间 agentId=${agentId}（共 ${workspaces.length} 个空间）`);
  if (!Number.isFinite(agentId)) {
    console.log("❌ 无法解析 tenantId");
    process.exit(1);
  }

  // 步 5：ChangeUserPermissions（ResetPolicies4Agent，policyIndexList=[1]）
  const reset = await controlCall(cred, {
    method: "POST",
    path: "/bailianControl/serviserAuthorityPolicy/resetPolicies4Agent",
    action: "ChangeUserPermissions",
    bodyObj: { data: JSON.stringify({ cornerstoneParam: {}, outerKey: uid, policyIndexList: [1], agentId }) },
  });
  if (!(reset.status >= 200 && reset.status < 300) || reset.json?.Success === false) {
    const e = controlError(reset);
    console.log(`❌ 步5 ChangeUserPermissions 失败: HTTP ${reset.status} ${e.code} ${e.msg}`);
    if (e.authAction) console.log(`   → RAM 策略需补充 Action: ${e.authAction}`);
    process.exit(1);
  }
  console.log("✅ 步5 业务空间成员策略已授予（policyIndexList=[1]）");
  console.log("ℹ️  已跳过官方 init 的步 6-8（后付费服务开通，计费副作用）——Token Plan 用户不需要。");

  // 复测：个人版 usage 应不再 NotAuthorised
  const usage = await gcall(BAILIAN_USAGE_API);
  if (usage.ok) {
    console.log("✅ 复测 usage 成功！payload:");
    console.log(JSON.stringify(usage.payload, null, 2).slice(0, 1500));
  } else {
    console.log("⚠️ 复测 usage 仍失败:", usage.message);
    console.log("   （策略生效可能有分钟级延迟；稍后重跑 npm run probe:bailian）");
  }
})().catch((e) => {
  console.log("❌ 异常:", String((e && e.message) || e));
  process.exit(1);
});