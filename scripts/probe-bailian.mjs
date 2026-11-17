/**
 * 阿里云百炼 Token Plan（个人版）配额只读探针。
 *
 * 验证「AK/SK → cliAccessToken → 控制台网关 → 个人版用量」整条链路：
 *   步1  ACS3-HMAC-SHA256 签名调 GenerateCLIAccessToken 换 cliAccessToken
 *   步2  用 cliAccessToken 调 loginInfo 校验 token 有效性
 *   步3  调三个 RPC 拉个人版用量 / 订阅 / 加购摘要
 *
 * 只读：不写任何文件、不改凭据、不安装依赖。
 * 绝对不打印任何密钥/token 明文——AK 只掩码为前 4 后 4，token 只报长度。
 *
 *   node scripts/probe-bailian.mjs [--region cn-beijing|ap-southeast-1]
 *                                  [--site domestic|international]
 *
 * 没有 AK/SK 时打印配置指引并 exit 0（不算失败）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const ACCESS_TOKEN_PATH = "/modelstudio/cli/generateAccessToken";
const ACCESS_TOKEN_ACTION = "GenerateCLIAccessToken";
const API_VERSION = "2026-02-10";
const GATEWAY_PRODUCT = "sfm_bailian";
const GATEWAY_PATH = "/cli/api.json";

/** region+site → token 主机 / 控制台网关主机 / 网关 action。 */
const MATRIX = {
  "cn-beijing|domestic": {
    tokenHost: "modelstudio.cn-beijing.aliyuncs.com",
    gatewayHost: "bailian-cs.console.aliyun.com",
    gatewayAction: "BroadScopeAspnGateway",
  },
  "cn-beijing|international": {
    tokenHost: "modelstudio.cn-beijing.aliyuncs.com",
    gatewayHost: "bailian-cs.console.alibabacloud.com",
    gatewayAction: "BroadScopeAspnGateway",
  },
  "ap-southeast-1|domestic": {
    tokenHost: "modelstudio.ap-southeast-1.aliyuncs.com",
    gatewayHost: "modelstudio-cs.console.aliyun.com",
    gatewayAction: "IntlBroadScopeAspnGateway",
  },
  "ap-southeast-1|international": {
    tokenHost: "modelstudio.ap-southeast-1.aliyuncs.com",
    gatewayHost: "bailian-singapore-cs.alibabacloud.com",
    gatewayAction: "IntlBroadScopeAspnGateway",
  },
};

const USAGE_APIS = [
  ["usage", "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage"],
  ["subscription", "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription"],
  ["addon/summary", "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/addon/summary"],
];

const LOGIN_INFO_API = "zeldaEasy.cornerstone-portal.cs-console.loginInfo";

/**
 * 只有「整名匹配」才算敏感字段——避免把 tokenPlan / tokenUsage 这类业务字段
 * 误伤成密钥（业务配额数据不是秘密，要完整打印）。
 */
const SECRET_KEY_RE =
  /^(cli_?access_?token|access_?token|refresh_?token|security_?token|id_?token|token|secret|secret_?key|access_?key_?secret|access_?key_?id|authorization|cookie|password|passwd|credential)$/i;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const hmacSha256Hex = (key, msg) => createHmac("sha256", key).update(msg, "utf8").digest("hex");
const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function maskSecretValue(value) {
  if (typeof value === "string") return `***(len=${value.length})`;
  if (value === null || value === undefined) return value;
  return "***";
}

/** 深拷贝 + 按字段名掩码敏感值（用于打印响应，绝不打印密钥/token 明文）。 */
function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (isRecord(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? maskSecretValue(v) : maskSecrets(v);
    }
    return out;
  }
  return value;
}

function maskAccessKey(ak) {
  if (typeof ak !== "string" || ak.length === 0) return "(空)";
  if (ak.length <= 8) return `***(len=${ak.length})`;
  return `${ak.slice(0, 4)}…${ak.slice(-4)}(len=${ak.length})`;
}

function jsonOf(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 控制台网关信封：root.data.DataV2.data.data 才是业务负载。
 * 逐层宽松回退（与官方/参考实现同口径）：
 *   data.DataV2.data.data → data.DataV2.data → data.data → 原值
 */
function businessPayload(root) {
  const d1 = isRecord(root) && isRecord(root.data) ? root.data : null;
  if (!d1) return root ?? null;
  const d2 = isRecord(d1.DataV2) ? d1.DataV2 : null;
  if (d2) {
    const inner = isRecord(d2.data) ? d2.data : null;
    if (inner && "data" in inner) return inner.data;
    return inner ?? d2;
  }
  return "data" in d1 ? d1.data : d1;
}

/**
 * 在信封各层里找业务 success 标志与错误码。
 *
 * ⚠️ 真实抓包里 `successResponse: true`（传输层成功）与 `data.success: false`
 * （业务失败）会同时出现——判断成败必须以**最内层业务 success** 为准，
 * 否则 NotLogined 会被误判成成功。
 */
function envelopeStatus(root) {
  const d1 = isRecord(root) && isRecord(root.data) ? root.data : null;
  const d2 = d1 && isRecord(d1.DataV2) ? d1.DataV2 : null;
  const d3 = d2 && isRecord(d2.data) ? d2.data : null;

  // 越靠内层越具体：data.DataV2.data.success > data.success > successResponse
  const successCandidates = [d3?.success, d1?.success, root?.successResponse, root?.success];
  let success = null;
  for (const c of successCandidates) {
    if (typeof c === "boolean") {
      success = c;
      break;
    }
  }
  // 任一层显式 false 都是业务拒绝
  const rejected = successCandidates.some((c) => c === false);

  let errorCode = "";
  let errorMsg = "";
  for (const layer of [d1, d3, root]) {
    if (!isRecord(layer)) continue;
    if (!errorCode && typeof layer.errorCode === "string" && layer.errorCode.trim()) {
      errorCode = layer.errorCode.trim();
    }
    if (!errorMsg && typeof layer.errorMsg === "string" && layer.errorMsg.trim()) {
      errorMsg = layer.errorMsg.trim();
    }
    if (!errorMsg && typeof layer.message === "string" && layer.message.trim()) {
      errorMsg = layer.message.trim();
    }
  }
  return { success, rejected, errorCode, errorMsg };
}

/** 递归找 cliAccessToken / access_token / accessToken（对齐官方实现的取法）。 */
function findToken(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findToken(item);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of ["cliAccessToken", "access_token", "accessToken"]) {
    if (typeof value[key] === "string" && value[key].length > 0) return value[key];
  }
  for (const child of Object.values(value)) {
    const hit = findToken(child);
    if (hit) return hit;
  }
  return null;
}

/** XML 错误体里取字段（阿里云 OpenAPI 错误常是 XML）。 */
function xmlField(text, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1].trim() : "";
}

// ---------------------------------------------------------------------------
// 凭据读取
// ---------------------------------------------------------------------------

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * 读 ~/.dsh/.credentials.yaml。
 * 优先取 `refs:` 块下缩进的键；找不到 refs 块时退回全文正则。
 * 只取键值，不打印任何内容。
 */
function readCredentialsYaml() {
  let text = "";
  try {
    text = readFileSync(join(DSH_HOME, ".credentials.yaml"), "utf8");
  } catch {
    return { refs: {}, global: {}, present: false };
  }
  const lines = text.split(/\r?\n/);
  const refs = {};
  let start = -1;
  let baseIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)refs\s*:\s*$/.exec(lines[i]);
    if (m) {
      start = i + 1;
      baseIndent = m[1].length;
      break;
    }
  }
  if (start >= 0) {
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= baseIndent) break; // 回到同级 → refs 块结束
      const m = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
      if (m) refs[m[1]] = unquote(m[2]);
    }
  }
  const global = {};
  for (const m of text.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.+)$/gm)) {
    global[m[1]] = unquote(m[2]);
  }
  return { refs, global, present: true };
}

const CRED_KEYS = {
  ak: "ALIBABA_CLOUD_ACCESS_KEY_ID",
  sk: "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
  st: "ALIBABA_CLOUD_SECURITY_TOKEN",
};

function resolveCredentials() {
  const yaml = readCredentialsYaml();
  const out = {};
  for (const [field, key] of Object.entries(CRED_KEYS)) {
    let value = null;
    let source = null;
    if (yaml.refs[key]) {
      value = yaml.refs[key];
      source = ".credentials.yaml (refs)";
    } else if (yaml.global[key]) {
      value = yaml.global[key];
      source = ".credentials.yaml";
    } else if (process.env[key]) {
      value = process.env[key];
      source = "process.env";
    }
    out[field] = value ? { value, source } : null;
  }
  out.yamlPresent = yaml.present;
  return out;
}

// ---------------------------------------------------------------------------
// 配置指引
// ---------------------------------------------------------------------------

function printSetupGuide(creds) {
  const missing = [];
  if (!creds.ak) missing.push("ALIBABA_CLOUD_ACCESS_KEY_ID (AK)");
  if (!creds.sk) missing.push("ALIBABA_CLOUD_ACCESS_KEY_SECRET (SK)");
  console.log("未检测到可用的阿里云百炼 Token Plan AK/SK —— 本探针只读，不修改任何配置，直接退出（exit 0）。");
  if (missing.length) console.log(`缺少：${missing.join("、")}\n`);
  console.log("配置方式（任选其一）：");
  console.log("");
  console.log("1) RAM 用户 AccessKey（推荐）");
  console.log("   - 阿里云 RAM 控制台创建 RAM 用户 → 生成 AccessKey（AK/SK）");
  console.log("   - 给该 RAM 用户附加自定义策略：Action `modelstudio:GenerateCLIAccessToken`，Resource `*`");
  console.log("     （换 cliAccessToken 的必需权限，缺失会返回 NoPermission / AuthAction=modelstudio:GenerateCLIAccessToken）");
  console.log("   - 再附加系统策略 `AliyunTokenPlanReadOnlyAccess`（读 Token Plan 配额）");
  console.log("   - ⚠️ RAM 用户还必须加入百炼业务空间，否则网关返回 BailianGateway.Team.NotAuthorised");
  console.log("");
  console.log("2) 环境变量（回退路径）");
  console.log("   - ALIBABA_CLOUD_ACCESS_KEY_ID");
  console.log("   - ALIBABA_CLOUD_ACCESS_KEY_SECRET");
  console.log("   - ALIBABA_CLOUD_SECURITY_TOKEN（可选，STS 临时凭据时必须带上）");
  console.log("");
  console.log(`3) 凭据文件 ${join(DSH_HOME, ".credentials.yaml")}`);
  console.log("   - 在 `refs:` 块下缩进写入 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET");
  console.log("");
  console.log("4) 插件设置页");
  console.log("   - DSH 设置 → 插件 → dsh-token-stats →「百炼 Token Plan 凭据」卡片中填写 AK/SK");
}

// ---------------------------------------------------------------------------
// 步1：ACS3-HMAC-SHA256 签名
// ---------------------------------------------------------------------------

/**
 * 构造 ACS3-HMAC-SHA256 签名请求头。
 *
 * CanonicalRequest =
 *   Method \n Pathname \n CanonicalQueryString \n CanonicalHeaders \n SignedHeaders \n HashedPayload
 * StringToSign = "ACS3-HMAC-SHA256" \n SHA256(CanonicalRequest)
 * Signature     = HMAC-SHA256(SecretKey, StringToSign) 的十六进制
 *
 * 与三份参考实现逐字对齐：KS-OTO/tracking-llm-plan-usage（Web Crypto 版）、
 * modelstudioai/cli（官方）、AliyunTokenBar（Swift 版）。
 */
function signAcs3({ ak, sk, st, host, action, version, method, path, body, date, nonce }) {
  const bodyHash = sha256Hex(body);
  const headers = {
    "content-type": "application/json",
    host,
    "x-acs-action": action,
    "x-acs-content-sha256": bodyHash,
    "x-acs-date": date,
    "x-acs-signature-nonce": nonce,
    "x-acs-version": version,
  };
  if (st) headers["x-acs-security-token"] = st;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const canonicalRequestHash = sha256Hex(canonicalRequest);
  const stringToSign = `ACS3-HMAC-SHA256\n${canonicalRequestHash}`;
  const signature = hmacSha256Hex(sk, stringToSign);
  const authorization = `ACS3-HMAC-SHA256 Credential=${ak},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return { headers, signedHeaders, canonicalRequest, canonicalRequestHash, stringToSign, signature, authorization };
}

async function fetchCliAccessToken(creds, host) {
  const body = "";
  const signed = signAcs3({
    ak: creds.ak.value,
    sk: creds.sk.value,
    st: creds.st ? creds.st.value : null,
    host,
    action: ACCESS_TOKEN_ACTION,
    version: API_VERSION,
    method: "POST",
    path: ACCESS_TOKEN_PATH,
    body,
    date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    nonce: randomUUID(),
  });

  const url = `https://${host}${ACCESS_TOKEN_PATH}`;
  let res;
  let text = "";
  try {
    res = await fetch(url, {
      method: "POST",
      // host 头由 undici 按 URL 自动填充，值与签名用的 host 一致；显式带上也无副作用。
      headers: { ...signed.headers, authorization: signed.authorization },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    return {
      ok: false,
      httpStatus: null,
      code: "NetworkError",
      message: `请求 ${url} 失败：${String((e && e.message) || e)}`,
      signed,
      url,
    };
  }

  const json = jsonOf(text);
  const code = (json && json.Code) || xmlField(text, "Code") || "";
  const message = (json && json.Message) || xmlField(text, "Message") || "";
  const authAction =
    (json && json.AccessDeniedDetail && json.AccessDeniedDetail.AuthAction) ||
    xmlField(text, "AuthAction") ||
    "";
  const token = json ? findToken(json) : null;

  return {
    ok: res.status >= 200 && res.status < 300 && !!token,
    httpStatus: res.status,
    code,
    message,
    authAction,
    token,
    body: json ?? text.slice(0, 400),
    signed,
    url,
  };
}

function explainTokenFailure(r) {
  const code = (r.code || "").trim();
  const msg = (r.message || "").trim();
  console.log(`  HTTP ${r.httpStatus ?? "-"}  Code=${code || "(无)"}`);
  if (msg) console.log(`  Message: ${msg}`);
  if (r.authAction) console.log(`  AuthAction: ${r.authAction}`);

  if (code === "SignatureDoesNotMatch") {
    console.log("");
    console.log("  ⚠️ 签名不匹配 —— 本探针的 ACS3 实现与网关期望不一致，按下面两行排查（不含任何密钥）：");
    console.log(`     CanonicalRequest sha256 = ${r.signed.canonicalRequestHash}`);
    console.log(`     StringToSign            = ${r.signed.stringToSign}`);
    console.log(`     SignedHeaders           = ${r.signed.signedHeaders}`);
    return;
  }
  if (code === "NoPermission" || code === "AccessDenied" || r.authAction) {
    console.log("");
    console.log("  ⚠️ RAM 权限不足：调用 GenerateCLIAccessToken 需要 Action");
    console.log(`     ${r.authAction || "modelstudio:GenerateCLIAccessToken"}（Resource *）。`);
    console.log("     请给该 RAM 用户附加自定义策略（Action=modelstudio:GenerateCLIAccessToken，Resource=*）");
    console.log("     以及系统策略 AliyunTokenPlanReadOnlyAccess。");
    console.log("     ⚠️ RAM 用户还必须加入百炼业务空间，否则后续网关会返回 Team.NotAuthorised。");
    return;
  }
  if (code === "InvalidAccessKeyId.NotFound" || code === "InvalidAccessKeyId") {
    console.log("");
    console.log("  ⚠️ AccessKeyId 无效或不存在——核对 AK 是否复制完整、是否已被禁用/删除。");
    return;
  }
  if (code === "MissingSecurityToken" || code === "InvalidSecurityToken") {
    console.log("");
    console.log("  ⚠️ STS 临时凭据问题——ALIBABA_CLOUD_SECURITY_TOKEN 需要与 AK/SK 同批次，且未过期。");
    return;
  }
  if (r.httpStatus === 401 || r.httpStatus === 403) {
    console.log("");
    console.log("  ⚠️ 鉴权被拒——多半是 RAM 策略缺少 modelstudio:GenerateCLIAccessToken。");
  }
}

// ---------------------------------------------------------------------------
// 步2/步3：控制台网关
// ---------------------------------------------------------------------------

function buildGatewayRequest({ gatewayHost, gatewayAction, api, data, region, token }) {
  const query = new URLSearchParams({
    action: gatewayAction,
    product: GATEWAY_PRODUCT,
    api,
  }).toString();
  const params = JSON.stringify({
    Api: api,
    V: "1.0",
    Data: {
      ...(data || {}),
      cornerstoneParam: {
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        switchUserType: 3,
        consoleSite: "BAILIAN_ALIYUN",
      },
    },
  });
  const body = new URLSearchParams({ params, region }).toString();
  return {
    url: `https://${gatewayHost}${GATEWAY_PATH}?${query}`,
    body,
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Bearer ${token}`,
    },
  };
}

async function callGateway({ gatewayHost, gatewayAction, api, data, region, token }) {
  const req = buildGatewayRequest({ gatewayHost, gatewayAction, api, data, region, token });
  try {
    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    const json = jsonOf(text);
    const status = envelopeStatus(json);
    return {
      httpStatus: res.status,
      ok: res.status >= 200 && res.status < 300 && !status.rejected,
      json,
      raw: text,
      status,
      payload: businessPayload(json),
      req,
    };
  } catch (e) {
    return {
      httpStatus: null,
      ok: false,
      json: null,
      raw: "",
      status: { success: null, errorCode: "NetworkError", errorMsg: String((e && e.message) || e) },
      payload: null,
      req,
    };
  }
}

function explainGatewayError(status) {
  const code = (status.errorCode || "").trim();
  const msg = (status.errorMsg || "").trim();
  console.log(`  ⚠️ 网关业务失败：errorCode=${code || "(无)"}`);
  if (msg) console.log(`     errorMsg: ${msg}`);
  if (code.includes("NotLogined")) {
    console.log("");
    console.log("     → cliAccessToken 失效或账号会话无效。重新运行本探针可换一枚新 token；");
    console.log("       若用的是 STS 凭据，确认 STS 未过期（带 x-acs-security-token 一起签名）。");
    return;
  }
  if (code.includes("Team.NotAuthorised")) {
    console.log("");
    console.log("     → RAM 用户没有加入百炼业务空间。到百炼控制台的业务空间/成员管理里");
    console.log("       把该 RAM 用户加进去，否则个人版配额读不到。");
    return;
  }
  if (code.includes("NoPermission") || code.includes("AccessDenied")) {
    console.log("");
    console.log("     → 缺 RAM 权限。给 RAM 用户附加 AliyunTokenPlanReadOnlyAccess，");
    console.log("       以及自定义策略 Action=modelstudio:GenerateCLIAccessToken（Resource=*）。");
    return;
  }
}

/** 从业务负载里找额度百分比（0-1）与重置时间（毫秒）。 */
function summarizeUsage(payload) {
  if (!isRecord(payload)) return null;
  const pct = payload.per1MonthPercentage;
  const reset = payload.per1MonthResetTime;
  const parts = [];
  if (typeof pct === "number" && Number.isFinite(pct)) {
    parts.push(`per1MonthPercentage=${pct}（${(pct * 100).toFixed(2)}%）`);
  }
  if (typeof reset === "number" && Number.isFinite(reset)) {
    const d = new Date(reset);
    parts.push(`per1MonthResetTime=${reset}（${d.toISOString()}）`);
  }
  return parts.length ? parts.join("  ") : null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const argOf = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "用法: node scripts/probe-bailian.mjs [--region cn-beijing|ap-southeast-1] [--site domestic|international]",
        "",
        "默认 region=cn-beijing site=domestic（百炼中国站个人版）。",
        "只读探针：AK/SK → cliAccessToken → 控制台网关 → 个人版用量。绝不打印密钥/token 明文。",
      ].join("\n"),
    );
    return;
  }

  const region = argOf("--region", "cn-beijing");
  const site = argOf("--site", "domestic");
  const combo = `${region}|${site}`;
  const target = MATRIX[combo];
  if (!target) {
    console.error(`未知的 region/site 组合：${combo}`);
    console.error("可选：" + Object.keys(MATRIX).join("、"));
    process.exit(1);
  }

  const creds = resolveCredentials();
  if (!creds.ak || !creds.sk) {
    printSetupGuide(creds);
    process.exit(0);
  }

  console.log("== 阿里云百炼 Token Plan（个人版）配额探针");
  console.log(`   region/site : ${combo}`);
  console.log(`   token host  : ${target.tokenHost}`);
  console.log(`   网关        : ${target.gatewayHost}  (action=${target.gatewayAction})`);
  console.log(`   AK 来源     : ${creds.ak.source}  AK=${maskAccessKey(creds.ak.value)}`);
  console.log(`   SK 来源     : ${creds.sk.source}  (值不打印)`);
  if (creds.st) console.log(`   STS token   : ${creds.st.source}  (值不打印)`);
  else console.log("   STS token   : 未配置");

  // ---- 步1：换 cliAccessToken ----
  console.log("");
  console.log("== 步1 · ACS3-HMAC-SHA256 换 cliAccessToken");
  console.log(`   POST https://${target.tokenHost}${ACCESS_TOKEN_PATH}`);
  const t0 = Date.now();
  const tokenRes = await fetchCliAccessToken(creds, target.tokenHost);
  console.log(`   耗时 ${Date.now() - t0}ms`);
  if (!tokenRes.ok) {
    explainTokenFailure(tokenRes);
    if (tokenRes.body && typeof tokenRes.body === "object") {
      console.log("");
      console.log("   响应（掩码后）:");
      console.log(JSON.stringify(maskSecrets(tokenRes.body), null, 2));
    }
    process.exit(1);
  }
  console.log(`   ✅ cliAccessToken 获取成功（len=${tokenRes.token.length}，不打印明文）`);
  const cliToken = tokenRes.token;

  // ---- 步2：校验 token ----
  console.log("");
  console.log("== 步2 · 校验 cliAccessToken（loginInfo）");
  const loginRes = await callGateway({
    gatewayHost: target.gatewayHost,
    gatewayAction: target.gatewayAction,
    api: LOGIN_INFO_API,
    data: {},
    region,
    token: cliToken,
  });
  console.log(`   POST ${loginRes.req.url}`);
  console.log(`   HTTP ${loginRes.httpStatus ?? "-"}  success=${loginRes.status.success}`);
  if (!loginRes.ok) {
    explainGatewayError(loginRes.status);
    if (loginRes.json) console.log(JSON.stringify(maskSecrets(loginRes.json), null, 2));
    process.exit(1);
  }
  const loginStatus = (() => {
    const p = loginRes.payload;
    if (!isRecord(p)) return null;
    if (typeof p.loginStatus === "string") return p.loginStatus;
    for (const v of Object.values(p)) {
      if (isRecord(v) && typeof v.loginStatus === "string") return v.loginStatus;
    }
    return null;
  })();
  console.log(`   ✅ token 有效${loginStatus ? `（loginStatus=${loginStatus}）` : ""}`);
  console.log("   响应（掩码后）:");
  console.log(JSON.stringify(maskSecrets(loginRes.json), null, 2));

  // ---- 步3：三个个人版 RPC ----
  for (const [label, api] of USAGE_APIS) {
    console.log("");
    console.log(`== 步3 · ${label}  (${api})`);
    const res = await callGateway({
      gatewayHost: target.gatewayHost,
      gatewayAction: target.gatewayAction,
      api,
      data: {},
      region,
      token: cliToken,
    });
    console.log(`   POST ${res.req.url}`);
    console.log(`   HTTP ${res.httpStatus ?? "-"}  success=${res.status.success}`);
    if (!res.ok) {
      explainGatewayError(res.status);
    }
    if (res.json) {
      console.log("   响应（掩码后，完整）:");
      console.log(JSON.stringify(maskSecrets(res.json), null, 2));
    } else if (res.raw) {
      console.log("   响应（非 JSON，已截断）:");
      console.log(res.raw.slice(0, 500));
    }
    if (res.ok && res.payload) {
      const summary = label === "usage" ? summarizeUsage(res.payload) : null;
      if (summary) console.log(`   解读: ${summary}`);
    }
  }

  console.log("");
  console.log("== 完成：以上为实测输出。");
}

main().catch((e) => {
  console.error("探针异常：", String((e && e.stack) || e));
  process.exit(1);
});
