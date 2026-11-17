/**
 * bailian-quota.js — 阿里云百炼 Token Plan（个人版）配额查询的**纯函数**层。
 *
 * 链路（通道 A：AK/SK 纯 HTTP，免 Cookie）：
 *   1. `buildTokenRequest` + `acs3SignedHeaders` → ACS3-HMAC-SHA256 签名
 *      POST https://modelstudio.<region>.aliyuncs.com/modelstudio/cli/generateAccessToken
 *      → `cliAccessToken`
 *   2. `buildGatewayRequest` → POST https://<csGateway>/cli/api.json?action=…&product=sfm_bailian&api=…
 *      `Authorization: Bearer <cliAccessToken>`，form 体只有 `params` + `region`
 *   3. `parseGatewayResponse` → 解信封；`discoverWindows` / `parseSubscriptionPayload` /
 *      `parseAddonPayload` → 业务负载；`bailianDisplay` → 9 字段读数。
 *
 * 设计约束：
 *   · 零 DSH 依赖，只用 `node:crypto`（宿主/浏览器都不需要它）。
 *   · 全部导出都是纯函数/常量，`timestamp` / `nonce` 可注入 → 签名可复现、可单测。
 *   · 本文件**不做任何网络请求**（fetch 由宿主侧 index.js 负责）。
 *
 * 契约来源：官方开源 CLI（modelstudioai/cli，gateway.ts / refresh-token.ts）与社区实测
 * （KS-OTO/tracking-llm-plan-usage，server/aliyun-console.ts + aliyun-console.test.ts）。
 */

import { createHash, createHmac, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 区域 × 站点 → 控制台网关主机 + 网关 action。
 * domestic = 阿里云站（百炼中国），international = 阿里云国际站。
 */
export const BAILIAN_REGIONS = {
  "cn-beijing": {
    domestic: { csGateway: "bailian-cs.console.aliyun.com", action: "BroadScopeAspnGateway" },
    international: { csGateway: "bailian-cs.console.alibabacloud.com", action: "BroadScopeAspnGateway" },
  },
  "ap-southeast-1": {
    domestic: { csGateway: "modelstudio-cs.console.aliyun.com", action: "IntlBroadScopeAspnGateway" },
    international: { csGateway: "bailian-singapore-cs.alibabacloud.com", action: "IntlBroadScopeAspnGateway" },
  },
};

/** 换 cliAccessToken 的 Model Studio 主机（按区域）。 */
export const BAILIAN_TOKEN_HOSTS = {
  "cn-beijing": "modelstudio.cn-beijing.aliyuncs.com",
  "ap-southeast-1": "modelstudio.ap-southeast-1.aliyuncs.com",
};

/** 个人版 Token Plan 业务 RPC（网关 `api` 参数）。 */
export const BAILIAN_USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
export const BAILIAN_SUBSCRIPTION_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription";
export const BAILIAN_ADDON_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/addon/summary";
/** 续期校验用（cliAccessToken 失效时确认登录态）。 */
export const BAILIAN_LOGIN_INFO_API = "zeldaEasy.cornerstone-portal.cs-console.loginInfo";

/** 换 token 的固定契约（官方 CLI）。 */
const TOKEN_PATH = "/modelstudio/cli/generateAccessToken";
const TOKEN_ACTION = "GenerateCLIAccessToken";
const TOKEN_VERSION = "2026-02-10";

/** 默认 RAM Action（缺权限时提示用户加哪个）。 */
const DEFAULT_AUTH_ACTION = "modelstudio:GenerateCLIAccessToken";

/** 窗口单位 → 小时数（用于窗口升序排序）。 */
const UNIT_HOURS = { Hour: 1, Day: 24, Week: 168, Month: 720 };

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function sha256Hex(input) {
  return createHash("sha256").update(String(input ?? ""), "utf8").digest("hex");
}

function hmacSha256Hex(secret, input) {
  return createHmac("sha256", String(secret ?? "")).update(String(input ?? ""), "utf8").digest("hex");
}

/** 截断长文本（防刷屏）。 */
function truncate(text, max = 200) {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object";
}

/** 宽容取数：字符串数字也认；非数返回 null。 */
function toNumberOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 时间戳 → 毫秒（秒级自动 ×1000；无法解析返回 null）。 */
function toMillis(value) {
  const n = toNumberOrNull(value);
  if (n === null) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

// ---------------------------------------------------------------------------
// ① ACS3-HMAC-SHA256 签名
// ---------------------------------------------------------------------------

/**
 * 构造 ACS3-HMAC-SHA256 请求头（阿里云 API 网关 V3 签名）。
 *
 * CanonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, bodyHash].join("\n")
 *   canonicalHeaders = 按头名升序，每个 "名:值\n"
 *   signedHeaders    = 升序头名以 ";" 连接
 * StringToSign     = "ACS3-HMAC-SHA256\n" + sha256hex(CanonicalRequest)
 * Signature        = hmacSHA256hex(裸SK, StringToSign)
 *
 * `timestamp` / `nonce` 可注入（测试复现签名时必须固定，否则每次都变）。
 *
 * @returns {Record<string,string>} fetch 可直接使用的 headers（含 `Authorization`）。
 */
export function acs3SignedHeaders({
  accessKeyId,
  accessKeySecret,
  securityToken,
  host,
  path,
  action,
  version,
  method = "POST",
  query = "",
  body = "",
  timestamp,
  nonce,
}) {
  const bodyHash = sha256Hex(body);
  const headers = {
    "content-type": "application/json",
    host,
    "x-acs-action": action,
    "x-acs-content-sha256": bodyHash,
    "x-acs-date": timestamp ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    "x-acs-signature-nonce": nonce ?? randomUUID(),
    "x-acs-version": version,
  };
  if (securityToken) headers["x-acs-security-token"] = securityToken;

  const signedNames = Object.keys(headers)
    .filter((name) => name === "host" || name === "content-type" || name.startsWith("x-acs-"))
    .sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name]}`).join("\n") + "\n";
  const signedHeaders = signedNames.join(";");

  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const stringToSign = "ACS3-HMAC-SHA256\n" + sha256Hex(canonicalRequest);
  const signature = hmacSha256Hex(accessKeySecret, stringToSign);

  return {
    ...headers,
    Authorization:
      `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

/**
 * 构造「AK/SK → cliAccessToken」请求。
 *
 * @returns {{url:string, headers:Record<string,string>, body:string}} body 为空（POST 无体）。
 */
export function buildTokenRequest({
  accessKeyId,
  accessKeySecret,
  securityToken,
  region = "cn-beijing",
  timestamp,
  nonce,
}) {
  const host = BAILIAN_TOKEN_HOSTS[region] ?? BAILIAN_TOKEN_HOSTS["cn-beijing"];
  const headers = acs3SignedHeaders({
    accessKeyId,
    accessKeySecret,
    securityToken,
    host,
    path: TOKEN_PATH,
    action: TOKEN_ACTION,
    version: TOKEN_VERSION,
    method: "POST",
    query: "",
    body: "",
    timestamp,
    nonce,
  });
  return { url: `https://${host}${TOKEN_PATH}`, headers, body: "" };
}

// ---------------------------------------------------------------------------
// ② 换 token 响应解析
// ---------------------------------------------------------------------------

const AUTH_ERROR_CODES = [
  "nopermission",
  "forbidden",
  "accessdenied",
  "invalidaccesskeyid",
  "signaturedoesnotmatch",
  "unauthorized",
  "invalidsecuritytoken",
  "expiredsecuritytoken",
  "authfailure",
  "invalidsignature",
  "notauthorized",
  "notauthorised",
];

/** 从 XML 错误体里抠 Code / Message / AuthAction。 */
function extractXmlError(text) {
  const code = /<Code>([^<]*)<\/Code>/i.exec(text)?.[1]?.trim() ?? "";
  const message = /<Message>([^<]*)<\/Message>/i.exec(text)?.[1]?.trim() ?? "";
  let authAction = /<AuthAction>([^<]*)<\/AuthAction>/i.exec(text)?.[1]?.trim() ?? "";
  if (!authAction) {
    const detail = /<AccessDeniedDetail>([\s\S]*?)<\/AccessDeniedDetail>/i.exec(text)?.[1] ?? "";
    authAction = /<AuthAction>([^<]*)<\/AuthAction>/i.exec(detail)?.[1]?.trim() ?? "";
  }
  return { code, message, authAction };
}

/** 从 JSON 错误体里抠 Code / Message / AuthAction。 */
function extractJsonError(json) {
  const code = String(json?.Code ?? json?.code ?? json?.ErrorCode ?? json?.errorCode ?? "").trim();
  const message = String(json?.Message ?? json?.message ?? json?.errorMsg ?? "").trim();
  const authAction = String(
    json?.AccessDeniedDetail?.AuthAction ??
      json?.AuthAction ??
      json?.authAction ??
      json?.AccessDeniedDetail?.authAction ??
      "",
  ).trim();
  return { code, message, authAction };
}

function isAuthErrorCode(code, status) {
  const c = String(code || "").toLowerCase();
  if (c && AUTH_ERROR_CODES.some((k) => c.includes(k))) return true;
  return status === 401 || status === 403;
}

/** 在响应体里递归找 token 字段（cliAccessToken / access_token / accessToken）。 */
function findToken(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findToken(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const key of ["cliAccessToken", "access_token", "accessToken"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  for (const key of Object.keys(value)) {
    const found = findToken(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * 解析换 token 响应。
 *
 * @returns {{ok:true, token:string} | {ok:false, kind:"auth"|"parse", message:string, authAction?:string}}
 */
export function parseTokenResponse(status, text) {
  const raw = typeof text === "string" ? text : String(text ?? "");
  const code = typeof status === "number" ? status : 0;
  const is2xx = code >= 200 && code < 300;

  let json = null;
  let jsonOk = false;
  try {
    json = JSON.parse(raw);
    jsonOk = true;
  } catch {
    jsonOk = false;
  }

  if (jsonOk) {
    const token = findToken(json);
    if (is2xx && token) return { ok: true, token };

    const { code: errCode, message: errMsg, authAction } = extractJsonError(json);
    const auth = isAuthErrorCode(errCode, code);
    const bits = [];
    if (errCode) bits.push(errCode);
    if (errMsg) bits.push(errMsg);
    const head = bits.length ? bits.join(" | ") : `HTTP ${code}`;
    const hint = authAction
      ? `RAM 权限不足：请在 RAM 策略中补充 ${authAction} 权限`
      : /^(NoPermission|AccessDenied)$/i.test(errCode)
        ? `RAM 权限不足：请在 RAM 策略中补充 ${DEFAULT_AUTH_ACTION} 权限`
        : "";
    const body = truncate(raw, 200);
    const message = [hint, head, body].filter(Boolean).join(" | ");
    return auth
      ? { ok: false, kind: "auth", message, ...(authAction ? { authAction } : {}) }
      : { ok: false, kind: "parse", message, ...(authAction ? { authAction } : {}) };
  }

  // 非 JSON：多半是 XML 错误体（ACS3 网关的标准错误格式）
  const { code: errCode, message: errMsg, authAction } = extractXmlError(raw);
  const auth = isAuthErrorCode(errCode, code) || /AccessDeniedDetail/i.test(raw);
  const bits = [];
  if (errCode) bits.push(errCode);
  if (errMsg) bits.push(errMsg);
  const head = bits.length ? bits.join(" | ") : `HTTP ${code}`;
  const hint = authAction
    ? `RAM 权限不足：请在 RAM 策略中补充 ${authAction} 权限`
    : /^(NoPermission|AccessDenied)$/i.test(errCode)
      ? `RAM 权限不足：请在 RAM 策略中补充 ${DEFAULT_AUTH_ACTION} 权限`
      : "";
  const body = truncate(raw, 200);
  const message = [hint, head, body].filter(Boolean).join(" | ");
  return auth
    ? { ok: false, kind: "auth", message, ...(authAction ? { authAction } : {}) }
    : { ok: false, kind: "parse", message, ...(authAction ? { authAction } : {}) };
}

// ---------------------------------------------------------------------------
// ③ 控制台网关请求
// ---------------------------------------------------------------------------

/**
 * 构造控制台网关请求（`/cli/api.json`）。
 *
 * @param {object} opts
 * @param {string} opts.region  "cn-beijing" | "ap-southeast-1"
 * @param {string} opts.site    "domestic" | "international"
 * @param {string} opts.api     业务 RPC 名
 * @param {object} [opts.data]  业务参数（会与 cornerstoneParam 合并）
 * @param {string} opts.token   cliAccessToken
 */
export function buildGatewayRequest({ region = "cn-beijing", site = "domestic", api, data = {}, token }) {
  const regionConf = BAILIAN_REGIONS[region] ?? BAILIAN_REGIONS["cn-beijing"];
  const gw = regionConf[site] ?? regionConf.domestic;
  const url =
    `https://${gw.csGateway}/cli/api.json?action=${gw.action}` +
    `&product=sfm_bailian&api=${encodeURIComponent(api)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "*/*",
  };
  const params = JSON.stringify({
    Api: api,
    V: "1.0",
    Data: {
      ...data,
      cornerstoneParam: {
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        switchUserType: 3,
        consoleSite: "BAILIAN_ALIYUN",
        ...(data && data.cornerstoneParam ? data.cornerstoneParam : {}),
      },
    },
  });
  const body = new URLSearchParams({ params, region }).toString();
  return { url, headers, body };
}

// ---------------------------------------------------------------------------
// ④ 控制台网关响应解析
// ---------------------------------------------------------------------------

/**
 * 逐层容忍地剥信封：取第一个非 null 对象。
 * 顺序（真实抓包为准）：data.DataV2.data.data → data.DataV2.data → data.DataV2
 *                      → data.data → data → 根对象
 */
function unwrapPayload(root) {
  const candidates = [
    root?.data?.DataV2?.data?.data,
    root?.data?.DataV2?.data,
    root?.data?.DataV2,
    root?.data?.data,
    root?.data,
    root,
  ];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && typeof candidate === "object") return candidate;
  }
  return root ?? null;
}

/** 在负载里找 AuthAction（错误信封常带）。 */
function findAuthAction(value, depth = 0) {
  if (depth > 5 || !isPlainObject(value)) return "";
  const direct = value.AuthAction ?? value.authAction ?? value.AccessDeniedDetail?.AuthAction;
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  for (const key of Object.keys(value)) {
    const found = findAuthAction(value[key], depth + 1);
    if (found) return found;
  }
  return "";
}

/**
 * 解析控制台网关响应。
 *
 * ⚠️ 失败形态 = **HTTP 200 + `data.success === false` + errorCode**（不能只看状态码）。
 *
 * @returns {{ok:true, payload:any} | {ok:false, kind:string, message:string, notLogined?:boolean, authAction?:string}}
 */
export function parseGatewayResponse(status, text) {
  const raw = typeof text === "string" ? text : String(text ?? "");
  const code = typeof status === "number" ? status : 0;

  if (code !== 200) {
    let kind = "network";
    if (code === 401 || code === 403) kind = "auth";
    else if (code === 429) kind = "rate_limited";
    else if (code >= 500) kind = "other";
    return { ok: false, kind, message: `HTTP ${code}: ${truncate(raw, 200)}` };
  }

  // HTML 登录页 = 会话/票据失效（网关会把未登录重定向到登录页）
  if (/<html/i.test(raw) && /login|signin/i.test(raw)) {
    return {
      ok: false,
      kind: "auth",
      notLogined: true,
      message: `百炼网关返回登录页（会话已失效）：${truncate(raw, 200)}`,
    };
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, kind: "parse", message: `响应不是合法 JSON: ${truncate(raw, 200)}` };
  }

  const envelope = isPlainObject(json?.data) ? json.data : null;
  const failed = envelope?.success === false || json?.successResponse === false;
  if (failed) {
    const errorCode = String(
      envelope?.errorCode ?? json?.errorCode ?? json?.data?.errorCode ?? "",
    ).trim();
    const errorMsg = String(
      envelope?.errorMsg ?? json?.errorMsg ?? json?.data?.errorMsg ?? "",
    ).trim();
    const authAction = findAuthAction(json);
    if (/notlogined/i.test(errorCode)) {
      return {
        ok: false,
        kind: "auth",
        notLogined: true,
        message: `百炼会话未登录（${errorCode || "NotLogined"}）：${errorMsg || "请重新登录控制台"}`,
        ...(authAction ? { authAction } : {}),
      };
    }
    if (/nopermission|forbidden|notauthoris/i.test(errorCode)) {
      const hint = /notauthoris/i.test(errorCode)
        ? "RAM 用户需加入百炼业务空间，否则网关返回 BailianGateway.Team.NotAuthorised"
        : `百炼网关拒绝访问（${errorCode}）`;
      return {
        ok: false,
        kind: "auth",
        message: `${hint}：${errorMsg || errorCode}`,
        ...(authAction ? { authAction } : {}),
      };
    }
    return {
      ok: false,
      kind: "other",
      message: `百炼网关错误（${errorCode || "UnknownError"}）：${errorMsg || errorCode}`,
      ...(authAction ? { authAction } : {}),
    };
  }

  return { ok: true, payload: unwrapPayload(json) };
}

// ---------------------------------------------------------------------------
// ⑤ 用量窗口
// ---------------------------------------------------------------------------

const WINDOW_KEY_RE = /^per(\d+)(Hour|Day|Week|Month)(Percentage|ResetTime)$/;

/**
 * 从用量负载里发现配额窗口。
 *
 * 窗口字段通名：`per<count><Unit>Percentage` / `per<count><Unit>ResetTime`
 * （例：`per5HourPercentage`、`per1WeekPercentage`、`per1MonthPercentage`）。
 *
 * ⚠️ **Percentage 是 0–1 比值**（实测 0.2750906925 ⇒ 控制台 27.51%）；
 * 防御式：>1 视为已经是百分数；一律钳制 0–100，四舍五入到 0.1。
 *
 * 两字段全缺 → 不产出该窗口；任一存在 → 产出（缺失侧记 null）。
 *
 * @returns {Array<{key:string, count:number, unit:string, percentage:number|null, resetTimeMs:number|null}>}
 */
export function discoverWindows(payload) {
  if (!isPlainObject(payload)) return [];
  const groups = new Map();
  for (const [name, rawValue] of Object.entries(payload)) {
    const match = WINDOW_KEY_RE.exec(name);
    if (!match) continue;
    const count = Number(match[1]);
    const unit = match[2];
    const kind = match[3];
    const key = `per${count}${unit}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, count, unit, percentage: null, resetTimeMs: null };
      groups.set(key, group);
    }
    if (kind === "Percentage") {
      const value = toNumberOrNull(rawValue);
      if (value === null) continue;
      const percent = value <= 1 ? value * 100 : value;
      group.percentage = Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10;
    } else {
      const millis = toMillis(rawValue);
      if (millis === null) continue;
      group.resetTimeMs = millis;
    }
  }
  const list = [...groups.values()];
  list.sort((a, b) => {
    const ha = (UNIT_HOURS[a.unit] ?? 0) * a.count;
    const hb = (UNIT_HOURS[b.unit] ?? 0) * b.count;
    if (ha !== hb) return ha - hb;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return list;
}

// ---------------------------------------------------------------------------
// ⑥ 套餐 / 加购包
// ---------------------------------------------------------------------------

/**
 * 解析套餐（subscription）负载。
 *
 * specCode / status / remainingDays 三者必需（缺任一 → null）；其余可选。
 *
 * @returns {{specCode:string, status:string, remainingDays:number, startTimeMs:number|null, endTimeMs:number|null, autoRenewFlag:boolean}|null}
 */
export function parseSubscriptionPayload(payload) {
  if (!isPlainObject(payload)) return null;
  const specCode = typeof payload.specCode === "string" ? payload.specCode.trim() : "";
  const status = typeof payload.status === "string" ? payload.status.trim() : "";
  const remainingDays = toNumberOrNull(payload.remainingDays);
  if (!specCode || !status || remainingDays === null) return null;
  return {
    specCode,
    status,
    remainingDays: Math.trunc(remainingDays),
    startTimeMs: toMillis(payload.startTime),
    endTimeMs: toMillis(payload.endTime),
    autoRenewFlag: payload.autoRenewFlag === true || payload.autoRenewFlag === "true",
  };
}

/**
 * 解析加购包（addon/summary）负载：三个字段全可选，缺省 0。
 *
 * @returns {{remainingCredits:number, totalCredits:number, activeCount:number}|null}
 */
export function parseAddonPayload(payload) {
  if (!isPlainObject(payload)) return null;
  return {
    remainingCredits: toNumberOrNull(payload.remainingCredits) ?? 0,
    totalCredits: toNumberOrNull(payload.totalCredits) ?? 0,
    activeCount: Math.trunc(toNumberOrNull(payload.activeCount) ?? 0),
  };
}

// ---------------------------------------------------------------------------
// ⑦ 展示层
// ---------------------------------------------------------------------------

/**
 * 倒计时文案。**与 index.js 的 formatResetsIn 行为一致**（同一个仓库、同一个读数口径）：
 *   · 未来 → "<h>h<m>m 后重置"（不足 1 小时 → "<m>m 后重置"）
 *   · 过去/此刻 → "即将重置"
 *   · 非法入参 → null（index.js 返回 ""，这里用 null 表达「无读数」，wire 语义更干净）
 */
export function formatResetsIn(resetsAtMs) {
  if (typeof resetsAtMs !== "number" || !resetsAtMs) return null;
  const ms = resetsAtMs - Date.now();
  if (ms <= 0) return "即将重置";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return h + "h" + m + "m 后重置";
  return m + "m 后重置";
}

/**
 * 把窗口 / 套餐 / 加购包映射成 9 字段读数（与 typert.host.js 的 wire 形状一致）。
 *
 * · `per5Hour` → fiveHrPct / fiveHrResetsIn
 * · `per1Week` → weeklyPct / weeklyResetsIn
 * · `per1Month` → monthlyPct / monthlyResetsIn
 * · 其他 `per*` 窗口忽略；没有对应窗口 → null。
 */
export function bailianDisplay({ windows, subscription, addon } = {}) {
  const list = Array.isArray(windows) ? windows : [];
  const pick = (key) => list.find((w) => w && w.key === key) ?? null;

  const five = pick("per5Hour");
  const week = pick("per1Week");
  const month = pick("per1Month");

  let balanceText = null;
  if (addon && Number(addon.totalCredits) > 0) {
    balanceText = `加购包剩余 ${addon.remainingCredits} Credits`;
  } else if (subscription) {
    balanceText = `套餐 ${subscription.specCode} · 剩 ${subscription.remainingDays} 天`;
  }

  return {
    fiveHrPct: five ? (five.percentage ?? null) : null,
    fiveHrResetsIn: five && five.resetTimeMs ? formatResetsIn(five.resetTimeMs) : null,
    weeklyPct: week ? (week.percentage ?? null) : null,
    weeklyResetsIn: week && week.resetTimeMs ? formatResetsIn(week.resetTimeMs) : null,
    monthlyPct: month ? (month.percentage ?? null) : null,
    monthlyResetsIn: month && month.resetTimeMs ? formatResetsIn(month.resetTimeMs) : null,
    balanceText,
    balanceUsd: null,
    currency: null,
  };
}
