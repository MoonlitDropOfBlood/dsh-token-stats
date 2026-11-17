/* Ad-hoc verification of the Bailian (阿里云百炼 Token Plan) quota path (not shipped).
 *
 * 覆盖 bailian-quota.js 的全部导出：ACS3 签名（金标准向量 + 独立第二实现交叉校验）、
 * 换 token 请求 / 网关请求形状、网关响应解析（四层信封 + 各种失败态）、用量窗口发现、
 * 套餐 / 加购包解析、9 字段读数映射、以及 formatResetsIn 与 index.js 的一致性。
 *
 * 零 DSH 依赖：只 import node: 内置模块 + 本仓库的 bailian-quota.js。
 * 跑法：node scripts/smoke-bailian.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  BAILIAN_REGIONS,
  BAILIAN_TOKEN_HOSTS,
  BAILIAN_USAGE_API,
  BAILIAN_SUBSCRIPTION_API,
  BAILIAN_ADDON_API,
  BAILIAN_LOGIN_INFO_API,
  acs3SignedHeaders,
  buildTokenRequest,
  parseTokenResponse,
  buildGatewayRequest,
  parseGatewayResponse,
  discoverWindows,
  parseSubscriptionPayload,
  parseAddonPayload,
  formatResetsIn,
  bailianDisplay,
} from "../bailian-quota.js";

let failures = 0;
let checks = 0;

function check(label, fn) {
  checks++;
  try {
    fn();
    console.log("  ok   " + label);
  } catch (err) {
    failures++;
    console.log("  FAIL " + label + "\n         " + (err && err.message ? err.message : String(err)));
  }
}

// ===========================================================================
// 1. ACS3-HMAC-SHA256 签名
// ===========================================================================

// 金标准向量来自社区实测套件 KS-OTO/tracking-llm-plan-usage
// （server/aliyun-console.test.ts，signAcs3 用例）：该签名已被真实网关接受
// （缺权限时返 403 NoPermission 而非 SignatureDoesNotMatch）。
const GOLDEN = {
  accessKeyId: "AKIDEXAMPLE",
  accessKeySecret: "SECRETEXAMPLE",
  action: "GenerateCLIAccessToken",
  version: "2026-02-10",
  host: "modelstudio.cn-beijing.aliyuncs.com",
  path: "/modelstudio/cli/generateAccessToken",
  method: "POST",
  body: "",
  timestamp: "2026-09-14T06:00:00Z",
  nonce: "4f1a0d2c-1e0b-4a5f-9c3d-2b6e7a8f0c11",
};
const GOLDEN_CONTENT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GOLDEN_AUTHORIZATION =
  "ACS3-HMAC-SHA256 Credential=AKIDEXAMPLE," +
  "SignedHeaders=content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;" +
  "x-acs-signature-nonce;x-acs-version," +
  "Signature=ceb15ef6212bb1e921ab836d5aa9e2e109f9f68708300a4110a073a1760ecdc8";

/**
 * 测试内的**独立第二实现**（不共享 bailian-quota.js 的任何代码）：
 * 手工 hex 编码 + reduce 拼 canonical headers + 显式拼 CanonicalRequest。
 * 目的：实现漂移时两套算法互相背书。
 */
function independentAcs3(input) {
  const hex = (buf) =>
    Array.from(buf)
      .map((b) => (b < 16 ? "0" : "") + b.toString(16))
      .join("");
  const sha256 = (s) => hex(createHash("sha256").update(s, "utf8").digest());
  const hmac = (key, s) => hex(createHmac("sha256", key).update(s, "utf8").digest());

  const table = {
    "content-type": "application/json",
    host: input.host,
    "x-acs-action": input.action,
    "x-acs-content-sha256": sha256(input.body),
    "x-acs-date": input.timestamp,
    "x-acs-signature-nonce": input.nonce,
    "x-acs-version": input.version,
  };
  if (input.securityToken) table["x-acs-security-token"] = input.securityToken;

  const names = Object.keys(table).sort();
  const canonicalHeaders = names.reduce((acc, n) => acc + n + ":" + table[n] + "\n", "");
  const signedHeaders = names.reduce((acc, n) => (acc ? acc + ";" : "") + n, "");
  const bodyHash = table["x-acs-content-sha256"];
  const canonicalRequest =
    input.method +
    "\n" +
    input.path +
    "\n" +
    (input.query ?? "") +
    "\n" +
    canonicalHeaders +
    "\n" +
    signedHeaders +
    "\n" +
    bodyHash;
  const stringToSign = "ACS3-HMAC-SHA256\n" + sha256(canonicalRequest);
  const signature = hmac(input.accessKeySecret, stringToSign);
  return {
    headers: table,
    signedHeaders,
    canonicalRequest,
    authorization:
      `ACS3-HMAC-SHA256 Credential=${input.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

console.log("== 1. ACS3 签名 ==");
{
  const headers = acs3SignedHeaders(GOLDEN);

  check("ACS3 金标准：x-acs-content-sha256 = sha256(空 body)", () => {
    assert.equal(headers["x-acs-content-sha256"], GOLDEN_CONTENT_SHA256);
  });

  check("ACS3 金标准：Authorization 与社区实测向量逐字节一致", () => {
    assert.equal(headers.Authorization, GOLDEN_AUTHORIZATION);
  });

  check("ACS3 独立第二实现交叉校验（Authorization 一致）", () => {
    const ref = independentAcs3(GOLDEN);
    assert.equal(headers.Authorization, ref.authorization);
    for (const [name, value] of Object.entries(ref.headers)) {
      assert.equal(headers[name], value, "header 不一致: " + name);
    }
  });

  check("ACS3 SignedHeaders 排序（升序，含 host/content-type）", () => {
    const expected =
      "content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version";
    assert.ok(headers.Authorization.includes("SignedHeaders=" + expected));
    assert.equal(ref_signedHeaders(GOLDEN), expected);
  });

  check("ACS3 canonical 结构可复算（签名 = HMAC(文档所述 CanonicalRequest)）", () => {
    const names = [
      "content-type",
      "host",
      "x-acs-action",
      "x-acs-content-sha256",
      "x-acs-date",
      "x-acs-signature-nonce",
      "x-acs-version",
    ];
    const canonicalHeaders = names.map((n) => `${n}:${headers[n]}`).join("\n") + "\n";
    const canonicalRequest = [
      "POST",
      GOLDEN.path,
      "",
      canonicalHeaders,
      names.join(";"),
      headers["x-acs-content-sha256"],
    ].join("\n");
    const expected = createHmac("sha256", GOLDEN.accessKeySecret)
      .update("ACS3-HMAC-SHA256\n" + createHash("sha256").update(canonicalRequest, "utf8").digest("hex"), "utf8")
      .digest("hex");
    assert.ok(headers.Authorization.endsWith("Signature=" + expected));
  });

  check("ACS3 头部齐全（content-type/host/x-acs-*）", () => {
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers.host, "modelstudio.cn-beijing.aliyuncs.com");
    assert.equal(headers["x-acs-action"], "GenerateCLIAccessToken");
    assert.equal(headers["x-acs-version"], "2026-02-10");
    assert.equal(headers["x-acs-date"], "2026-09-14T06:00:00Z");
    assert.equal(headers["x-acs-signature-nonce"], "4f1a0d2c-1e0b-4a5f-9c3d-2b6e7a8f0c11");
    assert.equal(headers["x-acs-security-token"], undefined);
  });

  check("ACS3 带 STS securityToken 时加入签名头并改变签名", () => {
    const withToken = acs3SignedHeaders({ ...GOLDEN, securityToken: "sts-token" });
    assert.equal(withToken["x-acs-security-token"], "sts-token");
    assert.ok(withToken.Authorization.includes("x-acs-security-token"));
    assert.notEqual(withToken.Authorization, headers.Authorization);
    const ref = independentAcs3({ ...GOLDEN, securityToken: "sts-token" });
    assert.equal(withToken.Authorization, ref.authorization);
  });

  check("ACS3 换 body / 换 date / 换 secret 都改变签名", () => {
    const base = headers.Authorization;
    assert.notEqual(acs3SignedHeaders({ ...GOLDEN, body: "{}" }).Authorization, base);
    assert.notEqual(acs3SignedHeaders({ ...GOLDEN, timestamp: "2026-09-14T06:00:01Z" }).Authorization, base);
    assert.notEqual(acs3SignedHeaders({ ...GOLDEN, accessKeySecret: "other" }).Authorization, base);
  });

  check("ACS3 缺省 timestamp/nonce 时自动生成（ISO 秒级 + UUID）", () => {
    const auto = acs3SignedHeaders({
      accessKeyId: "ak",
      accessKeySecret: "sk",
      host: "h.example.com",
      path: "/p",
      action: "A",
      version: "V",
    });
    assert.match(auto["x-acs-date"], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.match(auto["x-acs-signature-nonce"], /^[0-9a-f-]{36}$/);
  });
}

function ref_signedHeaders(input) {
  return independentAcs3(input).signedHeaders;
}

// ===========================================================================
// 2. 请求形状
// ===========================================================================

console.log("== 2. 请求构造 ==");
{
  const req = buildTokenRequest({
    accessKeyId: "ak",
    accessKeySecret: "sk",
    timestamp: "2026-09-14T06:00:00Z",
    nonce: "n-1",
  });
  check("buildTokenRequest: URL = Model Studio 换票端点", () => {
    assert.equal(req.url, "https://modelstudio.cn-beijing.aliyuncs.com/modelstudio/cli/generateAccessToken");
  });
  check("buildTokenRequest: body 为空（POST 无体）", () => {
    assert.equal(req.body, "");
  });
  check("buildTokenRequest: 头部含 host/action/version/Authorization", () => {
    assert.equal(req.headers.host, "modelstudio.cn-beijing.aliyuncs.com");
    assert.equal(req.headers["x-acs-action"], "GenerateCLIAccessToken");
    assert.equal(req.headers["x-acs-version"], "2026-02-10");
    assert.ok(req.headers.Authorization.startsWith("ACS3-HMAC-SHA256 Credential=ak,"));
  });
  check("buildTokenRequest: 国际区域主机正确", () => {
    const intl = buildTokenRequest({
      accessKeyId: "ak",
      accessKeySecret: "sk",
      region: "ap-southeast-1",
      timestamp: "2026-09-14T06:00:00Z",
      nonce: "n-1",
    });
    assert.equal(intl.url, "https://modelstudio.ap-southeast-1.aliyuncs.com/modelstudio/cli/generateAccessToken");
    assert.equal(intl.headers.host, BAILIAN_TOKEN_HOSTS["ap-southeast-1"]);
  });
}

{
  const gw = buildGatewayRequest({ api: BAILIAN_USAGE_API, token: "tok" });
  check("buildGatewayRequest: URL 含 action/product/api（api 已编码）", () => {
    assert.equal(
      gw.url,
      "https://bailian-cs.console.aliyun.com/cli/api.json?action=BroadScopeAspnGateway" +
        "&product=sfm_bailian&api=" +
        encodeURIComponent(BAILIAN_USAGE_API),
    );
    assert.ok(gw.url.includes("%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage"));
  });
  check("buildGatewayRequest: 头 = Bearer + form-urlencoded + Accept", () => {
    assert.equal(gw.headers.Authorization, "Bearer tok");
    assert.equal(gw.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.equal(gw.headers.Accept, "*/*");
  });
  check("buildGatewayRequest: body = params + region（params 可反解回 JSON）", () => {
    const form = new URLSearchParams(gw.body);
    assert.equal(form.get("region"), "cn-beijing");
    const params = JSON.parse(form.get("params"));
    assert.equal(params.Api, BAILIAN_USAGE_API);
    assert.equal(params.V, "1.0");
    assert.deepEqual(params.Data.cornerstoneParam, {
      protocol: "V2",
      console: "ONE_CONSOLE",
      productCode: "p_efm",
      switchUserType: 3,
      consoleSite: "BAILIAN_ALIYUN",
    });
  });
  check("buildGatewayRequest: 业务 data 与 cornerstoneParam 合并", () => {
    const withData = buildGatewayRequest({
      api: BAILIAN_SUBSCRIPTION_API,
      token: "tok",
      data: { queryInstanceInfoRequest: { commodityCode: "bailian" } },
    });
    const params = JSON.parse(new URLSearchParams(withData.body).get("params"));
    assert.deepEqual(params.Data.queryInstanceInfoRequest, { commodityCode: "bailian" });
    assert.equal(params.Data.cornerstoneParam.productCode, "p_efm");
  });
  check("buildGatewayRequest: 国际站 / 国际区域主机与 action 正确", () => {
    const intl = buildGatewayRequest({
      region: "cn-beijing",
      site: "international",
      api: BAILIAN_USAGE_API,
      token: "tok",
    });
    assert.ok(intl.url.startsWith("https://bailian-cs.console.alibabacloud.com/cli/api.json?"));
    assert.ok(intl.url.includes("action=BroadScopeAspnGateway"));
    const sg = buildGatewayRequest({
      region: "ap-southeast-1",
      site: "domestic",
      api: BAILIAN_USAGE_API,
      token: "tok",
    });
    assert.ok(sg.url.startsWith("https://modelstudio-cs.console.aliyun.com/cli/api.json?"));
    assert.ok(sg.url.includes("action=IntlBroadScopeAspnGateway"));
    assert.equal(new URLSearchParams(sg.body).get("region"), "ap-southeast-1");
  });
  check("区域矩阵常量与契约一致", () => {
    assert.equal(BAILIAN_REGIONS["cn-beijing"].domestic.csGateway, "bailian-cs.console.aliyun.com");
    assert.equal(BAILIAN_REGIONS["cn-beijing"].international.csGateway, "bailian-cs.console.alibabacloud.com");
    assert.equal(BAILIAN_REGIONS["ap-southeast-1"].domestic.action, "IntlBroadScopeAspnGateway");
    assert.equal(BAILIAN_REGIONS["ap-southeast-1"].international.csGateway, "bailian-singapore-cs.alibabacloud.com");
    assert.equal(BAILIAN_USAGE_API, "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage");
    assert.equal(BAILIAN_SUBSCRIPTION_API, "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription");
    assert.equal(BAILIAN_ADDON_API, "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/addon/summary");
    assert.equal(BAILIAN_LOGIN_INFO_API, "zeldaEasy.cornerstone-portal.cs-console.loginInfo");
  });
}

// ===========================================================================
// 3. 网关响应解析
// ===========================================================================

console.log("== 3. parseGatewayResponse ==");
{
  const captured = JSON.stringify({
    code: "200",
    data: {
      DataV2: {
        ret: ["SUCCESS::接口调用成功"],
        data: {
          msg: "Success.",
          code: "SUCCESS",
          data: { per1MonthResetTime: 1790920800000, per1MonthPercentage: 0.2750906925 },
          requestId: "b7d15d79-f23b-4639-8654-b495dd80e520",
          success: true,
        },
      },
      success: true,
      httpStatus: 200,
      errorCode: "",
      api: BAILIAN_USAGE_API,
      errorMsg: "",
    },
    httpStatusCode: "200",
    requestId: "b7d15d79-f23b-4639-8654-b495dd80e520",
    successResponse: true,
  });
  const res = parseGatewayResponse(200, captured);
  check("四层信封：data.DataV2.data.data 解出业务负载", () => {
    assert.equal(res.ok, true);
    assert.equal(res.payload.per1MonthPercentage, 0.2750906925);
    assert.equal(res.payload.per1MonthResetTime, 1790920800000);
  });
}
{
  check("flat 回退：无 DataV2 时取 data", () => {
    const res = parseGatewayResponse(200, JSON.stringify({ data: { success: true, foo: 1 } }));
    assert.equal(res.ok, true);
    assert.equal(res.payload.foo, 1);
  });
  check("flat 回退：根对象即业务负载", () => {
    const res = parseGatewayResponse(200, JSON.stringify({ per1WeekPercentage: 0.5 }));
    assert.equal(res.ok, true);
    assert.equal(res.payload.per1WeekPercentage, 0.5);
  });
  check("flat 回退：data.data 两层", () => {
    const res = parseGatewayResponse(200, JSON.stringify({ data: { data: { b: 2 } } }));
    assert.equal(res.ok, true);
    assert.equal(res.payload.b, 2);
  });
  check("HTTP 200 + success:false + NotLogined → auth/notLogined", () => {
    const body = JSON.stringify({
      code: "200",
      data: {
        success: false,
        httpStatus: 200,
        errorCode: "BailianGateway.Login.NotLogined",
        api: BAILIAN_USAGE_API,
        errorMsg: "BailianGateway.Login.NotLogined",
      },
      successResponse: true,
    });
    const res = parseGatewayResponse(200, body);
    assert.equal(res.ok, false);
    assert.equal(res.kind, "auth");
    assert.equal(res.notLogined, true);
    assert.ok(res.message.includes("NotLogined"));
  });
  check("HTTP 200 + success:false + NoPermission + AuthAction → auth", () => {
    const body = JSON.stringify({
      data: {
        success: false,
        errorCode: "NoPermission",
        errorMsg: "denied",
        AccessDeniedDetail: { AuthAction: "modelstudio:GenerateCLIAccessToken" },
      },
    });
    const res = parseGatewayResponse(200, body);
    assert.equal(res.ok, false);
    assert.equal(res.kind, "auth");
    assert.equal(res.authAction, "modelstudio:GenerateCLIAccessToken");
    assert.ok(res.message.includes("NoPermission"));
  });
  check("Team.NotAuthorised → auth 且提示加入百炼业务空间", () => {
    const body = JSON.stringify({
      data: { success: false, errorCode: "BailianGateway.Team.NotAuthorised", errorMsg: "team" },
    });
    const res = parseGatewayResponse(200, body);
    assert.equal(res.ok, false);
    assert.equal(res.kind, "auth");
    assert.ok(res.message.includes("业务空间"));
  });
  check("其它 errorCode → other（带 errorCode/errorMsg）", () => {
    const body = JSON.stringify({ data: { success: false, errorCode: "SomeOther.Error", errorMsg: "数据库超时" } });
    const res = parseGatewayResponse(200, body);
    assert.equal(res.ok, false);
    assert.equal(res.kind, "other");
    assert.ok(res.message.includes("数据库超时"));
  });
  check("HTML 登录页 → auth + notLogined", () => {
    const res = parseGatewayResponse(200, "<html><body>please login</body></html>");
    assert.equal(res.ok, false);
    assert.equal(res.kind, "auth");
    assert.equal(res.notLogined, true);
  });
  check("HTTP 500 → other（消息带状态 + body 前 200 字符）", () => {
    const res = parseGatewayResponse(500, "<html>bad gateway</html>");
    assert.equal(res.ok, false);
    assert.equal(res.kind, "other");
    assert.ok(res.message.includes("500"));
  });
  check("HTTP 429 → rate_limited；HTTP 401 → auth；HTTP 404 → network", () => {
    assert.equal(parseGatewayResponse(429, "slow down").kind, "rate_limited");
    assert.equal(parseGatewayResponse(401, "nope").kind, "auth");
    assert.equal(parseGatewayResponse(404, "nope").kind, "network");
  });
  check("非法 JSON（非 HTML）→ parse", () => {
    const res = parseGatewayResponse(200, "{not json");
    assert.equal(res.ok, false);
    assert.equal(res.kind, "parse");
  });
}

// ===========================================================================
// 4. 用量窗口
// ===========================================================================

console.log("== 4. discoverWindows ==");
{
  check("真实形状：per1Month 0.2750906925 → 27.5%", () => {
    const wins = discoverWindows({ per1MonthPercentage: 0.2750906925, per1MonthResetTime: 1790920800000 });
    assert.equal(wins.length, 1);
    assert.deepEqual(wins[0], {
      key: "per1Month",
      count: 1,
      unit: "Month",
      percentage: 27.5,
      resetTimeMs: 1790920800000,
    });
  });
  check("legacy 三窗口：5h / 1w / 1m 全部产出且按窗口时长升序", () => {
    const wins = discoverWindows({
      per5HourPercentage: 0.25,
      per5HourResetTime: 1789371600000,
      per1WeekPercentage: 0.5,
      per1WeekResetTime: 1789975200000,
      per1MonthPercentage: 0.4,
      per1MonthResetTime: 1790920800000,
    });
    assert.deepEqual(
      wins.map((w) => w.key),
      ["per5Hour", "per1Week", "per1Month"],
    );
    assert.equal(wins[0].percentage, 25);
    assert.equal(wins[1].percentage, 50);
    assert.equal(wins[2].percentage, 40);
  });
  check("防御：>1 视为已是百分数（27.5 → 27.5，180 → 100）", () => {
    const wins = discoverWindows({ per1WeekPercentage: 27.5, per1DayPercentage: 180 });
    const week = wins.find((w) => w.key === "per1Week");
    const day = wins.find((w) => w.key === "per1Day");
    assert.equal(week.percentage, 27.5);
    assert.equal(day.percentage, 100);
  });
  check("防御：负值钳到 0；>100 钳到 100", () => {
    const wins = discoverWindows({ per1WeekPercentage: -0.03, per1MonthPercentage: 150 });
    assert.equal(wins.find((w) => w.key === "per1Week").percentage, 0);
    assert.equal(wins.find((w) => w.key === "per1Month").percentage, 100);
  });
  check("0 值有效（不被当成缺失）", () => {
    const wins = discoverWindows({ per1WeekPercentage: 0, per1WeekResetTime: 1789975200000 });
    assert.equal(wins.length, 1);
    assert.equal(wins[0].percentage, 0);
    assert.equal(wins[0].resetTimeMs, 1789975200000);
  });
  check("两字段全缺 → 空数组", () => {
    assert.deepEqual(discoverWindows({}), []);
    assert.deepEqual(discoverWindows({ foo: 1 }), []);
    assert.deepEqual(discoverWindows(null), []);
  });
  check("只给一个字段 → 仍产出窗口，另一侧为 null", () => {
    const wins = discoverWindows({ per5HourPercentage: 0.88 });
    assert.equal(wins.length, 1);
    assert.equal(wins[0].percentage, 88);
    assert.equal(wins[0].resetTimeMs, null);
  });
  check("字符串数字宽容（'0.42' → 42，'1790920800000' → ms）", () => {
    const wins = discoverWindows({ per1WeekPercentage: "0.42", per1WeekResetTime: "1790920800000" });
    assert.equal(wins[0].percentage, 42);
    assert.equal(wins[0].resetTimeMs, 1790920800000);
  });
  check("秒级 resetTime 归一到毫秒（防御式）", () => {
    const wins = discoverWindows({ per1WeekResetTime: 1789975200 });
    assert.equal(wins[0].resetTimeMs, 1789975200000);
  });
  check("非数字百分比不产出百分比（窗口仍可由 resetTime 产出）", () => {
    const wins = discoverWindows({ per1WeekPercentage: "abc", per1WeekResetTime: 1789975200000 });
    assert.equal(wins.length, 1);
    assert.equal(wins[0].percentage, null);
    assert.equal(wins[0].resetTimeMs, 1789975200000);
  });
}

// ===========================================================================
// 5. 换 token 响应解析
// ===========================================================================

console.log("== 5. parseTokenResponse ==");
{
  check("{cliAccessToken:'x'} → ok", () => {
    const res = parseTokenResponse(200, JSON.stringify({ cliAccessToken: "x" }));
    assert.equal(res.ok, true);
    assert.equal(res.token, "x");
  });
  check("嵌套 token 也能递归找到", () => {
    const res = parseTokenResponse(200, JSON.stringify({ data: { result: { cliAccessToken: "nested" } } }));
    assert.equal(res.ok, true);
    assert.equal(res.token, "nested");
  });
  check("access_token / accessToken 变体也认", () => {
    assert.equal(parseTokenResponse(200, JSON.stringify({ access_token: "a" })).token, "a");
    assert.equal(parseTokenResponse(200, JSON.stringify({ accessToken: "b" })).token, "b");
  });
  check("NoPermission XML（带 AuthAction）→ auth + 中文提示", () => {
    const xml =
      "<Error><Code>NoPermission</Code><Message>You are not authorized to perform this action.</Message>" +
      "<RequestId>req-1</RequestId>" +
      "<AccessDeniedDetail><AuthAction>modelstudio:GenerateCLIAccessToken</AuthAction></AccessDeniedDetail></Error>";
    const res = parseTokenResponse(403, xml);
    assert.equal(res.ok, false);
    assert.equal(res.kind, "auth");
    assert.equal(res.authAction, "modelstudio:GenerateCLIAccessToken");
    assert.ok(res.message.includes("RAM 权限不足"));
    assert.ok(res.message.includes("modelstudio:GenerateCLIAccessToken"));
    assert.ok(res.message.includes("NoPermission"));
  });
  check("SignatureDoesNotMatch → auth", () => {
    const res = parseTokenResponse(
      403,
      JSON.stringify({ Code: "SignatureDoesNotMatch", Message: "Specified signature is not matched" }),
    );
    assert.equal(res.ok, false);
    assert.equal(res.kind, "auth");
    assert.ok(res.message.includes("SignatureDoesNotMatch"));
  });
  check("垃圾文本 → parse（消息截断 ≤ 200 字符）", () => {
    const res = parseTokenResponse(200, "x".repeat(5000));
    assert.equal(res.ok, false);
    assert.equal(res.kind, "parse");
    assert.ok(res.message.length <= 260, "消息过长: " + res.message.length);
  });
  check("200 但没有 token → parse", () => {
    const res = parseTokenResponse(200, JSON.stringify({ Message: "ok" }));
    assert.equal(res.ok, false);
    assert.equal(res.kind, "parse");
  });
}

// ===========================================================================
// 6. 套餐 / 加购包 / 读数映射
// ===========================================================================

console.log("== 6. 套餐 / 加购包 / bailianDisplay ==");
{
  check("parseSubscriptionPayload: 完整负载", () => {
    const sub = parseSubscriptionPayload({
      instanceCode: "sfm_tokenplansolo_public_cn-gz84w63sy2k",
      specCode: "pro",
      remainingDays: 46,
      startTime: 1785404529000,
      endTime: 1793376000000,
      autoRenewFlag: false,
      status: "VALID",
    });
    assert.equal(sub.specCode, "pro");
    assert.equal(sub.status, "VALID");
    assert.equal(sub.remainingDays, 46);
    assert.equal(sub.startTimeMs, 1785404529000);
    assert.equal(sub.endTimeMs, 1793376000000);
    assert.equal(sub.autoRenewFlag, false);
  });
  check("parseSubscriptionPayload: 缺 specCode / status / remainingDays → null", () => {
    assert.equal(parseSubscriptionPayload({ status: "VALID", remainingDays: 3 }), null);
    assert.equal(parseSubscriptionPayload({ specCode: "pro", remainingDays: 3 }), null);
    assert.equal(parseSubscriptionPayload({ specCode: "pro", status: "VALID" }), null);
    assert.equal(parseSubscriptionPayload(null), null);
  });
  check("parseSubscriptionPayload: 字符串数字宽容", () => {
    const sub = parseSubscriptionPayload({ specCode: "pro", status: "VALID", remainingDays: "25" });
    assert.equal(sub.remainingDays, 25);
  });
  check("parseAddonPayload: 三字段全可选，缺省 0", () => {
    assert.deepEqual(parseAddonPayload({ remainingCredits: 320000, totalCredits: 625000, activeCount: 2 }), {
      remainingCredits: 320000,
      totalCredits: 625000,
      activeCount: 2,
    });
    assert.deepEqual(parseAddonPayload({}), { remainingCredits: 0, totalCredits: 0, activeCount: 0 });
    assert.equal(parseAddonPayload(null), null);
    assert.equal(parseAddonPayload("nope"), null);
  });
  check("bailianDisplay: 月窗口映射到 monthlyPct / monthlyResetsIn", () => {
    const windows = discoverWindows({ per1MonthPercentage: 0.2750906925, per1MonthResetTime: Date.now() + 3600e3 });
    const d = bailianDisplay({ windows });
    assert.equal(d.monthlyPct, 27.5);
    assert.equal(typeof d.monthlyResetsIn, "string");
    assert.equal(d.fiveHrPct, null);
    assert.equal(d.fiveHrResetsIn, null);
    assert.equal(d.weeklyPct, null);
    assert.equal(d.weeklyResetsIn, null);
  });
  check("bailianDisplay: 5h / 1w 窗口映射到对应字段（其它 per* 忽略）", () => {
    const windows = discoverWindows({
      per5HourPercentage: 0.25,
      per5HourResetTime: Date.now() + 3600e3,
      per1WeekPercentage: 0.5,
      per1WeekResetTime: Date.now() + 86400e3,
      per2DayPercentage: 0.9,
      per2DayResetTime: Date.now() + 172800e3,
    });
    const d = bailianDisplay({ windows });
    assert.equal(d.fiveHrPct, 25);
    assert.equal(d.weeklyPct, 50);
    assert.equal(d.monthlyPct, null);
    assert.equal(typeof d.fiveHrResetsIn, "string");
    assert.equal(typeof d.weeklyResetsIn, "string");
  });
  check("bailianDisplay: balanceText 三种分支", () => {
    const windows = discoverWindows({ per1MonthPercentage: 0.1, per1MonthResetTime: Date.now() + 1000 });
    const withAddon = bailianDisplay({
      windows,
      addon: { remainingCredits: 320000, totalCredits: 625000, activeCount: 1 },
      subscription: { specCode: "pro", remainingDays: 20 },
    });
    assert.equal(withAddon.balanceText, "加购包剩余 320000 Credits");
    const withSub = bailianDisplay({
      windows,
      addon: { remainingCredits: 0, totalCredits: 0, activeCount: 0 },
      subscription: { specCode: "pro", remainingDays: 20 },
    });
    assert.equal(withSub.balanceText, "套餐 pro · 剩 20 天");
    const bare = bailianDisplay({ windows });
    assert.equal(bare.balanceText, null);
  });
  check("bailianDisplay: 9 字段恒在（缺省 null）", () => {
    const d = bailianDisplay({});
    assert.deepEqual(Object.keys(d).sort(), [
      "balanceText",
      "balanceUsd",
      "currency",
      "fiveHrPct",
      "fiveHrResetsIn",
      "monthlyPct",
      "monthlyResetsIn",
      "weeklyPct",
      "weeklyResetsIn",
    ]);
    assert.equal(d.balanceUsd, null);
    assert.equal(d.currency, null);
  });
}

// ===========================================================================
// 7. formatResetsIn 与 index.js 一致性
// ===========================================================================

console.log("== 7. formatResetsIn 与 index.js 一致 ==");

// 直接从 index.js 源码里抽出 formatResetsIn 来跑（不 import index.js，避免拉起 DSH 依赖）。
function loadIndexFormatResetsIn() {
  const source = readFileSync(fileURLToPath(new URL("../index.js", import.meta.url)), "utf8");
  const match = /function formatResetsIn\(resetsAtMs\) \{[\s\S]*?\n\}/.exec(source);
  assert.ok(match, "index.js 里找不到 formatResetsIn");
  // eslint-disable-next-line no-new-func
  return new Function("return (" + match[0] + ")")();
}
{
  const indexFormat = loadIndexFormatResetsIn();
  const now = Date.now();
  const cases = [
    ["未来 10 秒", now + 10_000],
    ["未来 5 分钟", now + 5 * 60_000 + 10_000],
    ["未来 59 分钟", now + 59 * 60_000 + 10_000],
    ["未来 1 小时", now + 60 * 60_000 + 10_000],
    ["未来 2.5 小时", now + 150 * 60_000],
    ["未来 25 小时", now + 25 * 3600_000],
    ["刚刚过去", now - 1000],
    ["过去 1 小时", now - 3600_000],
  ];
  for (const [label, ts] of cases) {
    check("formatResetsIn 与 index.js 一致：" + label, () => {
      assert.equal(formatResetsIn(ts), indexFormat(ts));
    });
  }
  check("formatResetsIn：非法入参 → null（index.js 返回空串）", () => {
    assert.equal(formatResetsIn(undefined), null);
    assert.equal(formatResetsIn(null), null);
    assert.equal(formatResetsIn(0), null);
    assert.equal(formatResetsIn("123"), null);
    assert.equal(indexFormat(undefined), "");
  });
  check("formatResetsIn：过去时间 → “即将重置”（与 index.js 同款）", () => {
    assert.equal(formatResetsIn(Date.now() - 5000), "即将重置");
  });
}

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES / ${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
