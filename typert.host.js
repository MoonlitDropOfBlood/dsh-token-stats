/**
 * dsh-token-stats — Typert Host manifest.
 *
 * Hand-written TYPERT manifest (the format the DSH typert-loader consumes from
 * the package's `./typert` export). It describes the `tokenStats` Remote
 * service the Host half publishes so the browser Client half can call it
 * through `ctx.remote.tokenStats.getStats()`.
 *
 * Keep the invocation ids, service/namespace names and method names in sync
 * with `index.js` (TokenStatsService) and `client.js`.
 */

import { z } from "zod";

// typert-loader's requireStrictCodec rejects strict codecs without a create()
// factory (v1.5.0 shipped without these, so the loader never registered this
// manifest and every tokenStats Remote call failed). Every codec below is
// paired with its factory; run `npm run smoke:typert` after changes.
const createStringSchema = () => z.string();
const createBooleanSchema = () => z.boolean();

// ---- shared shapes ---------------------------------------------------------

const modelDaySchema = z
  .object({
    key: z.string(),
    name: z.string(),
    provider: z.string(),
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    reasoning: z.number(),
    total: z.number(),
  })
  .readonly();

const daySchema = z
  .object({
    date: z.string(),
    total: z.number(),
    models: z.array(modelDaySchema).readonly(),
  })
  .readonly();

const modelRefSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    provider: z.string(),
  })
  .readonly();

const statsValueSchema = z
  .object({
    ready: z.boolean(),
    collecting: z.boolean(),
    progress: z
      .object({
        done: z.number(),
        total: z.number(),
      })
      .readonly(),
    error: z.union([z.string(), z.null()]),
    days: z.array(daySchema).readonly(),
    models: z.array(modelRefSchema).readonly(),
  })
  .readonly();

const tokenStatsResultSchema = z.union([
  z
    .object({
      ok: z.literal(true).readonly(),
      value: statsValueSchema,
    })
    .readonly(),
  z
    .object({
      ok: z.literal(false).readonly(),
      error: z
        .object({
          code: z.string().readonly(),
          message: z.string().readonly().optional(),
        })
        .readonly(),
    })
    .readonly(),
]);

const createTokenStatsResult = () => tokenStatsResultSchema;

// ---- quota / balance (套餐余额) ---------------------------------------------

const quotaDisplaySchema = z
  .object({
    fiveHrPct: z.union([z.number(), z.null()]),
    weeklyPct: z.union([z.number(), z.null()]),
    // 30d 窗口：目前只有 opencode-go 有（OpenCode Go 的 monthly 桶）；
    // 其余 provider 恒为 null（字段恒在，网关 strict 校验）。
    monthlyPct: z.union([z.number(), z.null()]),
    fiveHrResetsIn: z.union([z.string(), z.null()]),
    weeklyResetsIn: z.union([z.string(), z.null()]),
    monthlyResetsIn: z.union([z.string(), z.null()]),
    balanceText: z.union([z.string(), z.null()]),
    balanceUsd: z.union([z.number(), z.null()]),
    currency: z.union([z.string(), z.null()]),
  })
  .readonly();

const quotaValueSchema = z.union([
  z
    .object({
      ok: z.literal(true).readonly(),
      provider: z.string(),
      display: quotaDisplaySchema,
    })
    .readonly(),
  z
    .object({
      ok: z.literal(false).readonly(),
      provider: z.string(),
      kind: z.string(),
      message: z.string(),
    })
    .readonly(),
]);

const tokenStatsQuotaResultSchema = z.union([
  z
    .object({
      ok: z.literal(true).readonly(),
      value: quotaValueSchema,
    })
    .readonly(),
  z
    .object({
      ok: z.literal(false).readonly(),
      error: z
        .object({
          code: z.string().readonly(),
          message: z.string().readonly().optional(),
        })
        .readonly(),
    })
    .readonly(),
]);

const createTokenStatsQuotaResult = () => tokenStatsQuotaResultSchema;

const allQuotasValueSchema = z
  .object({
    quotas: z.record(z.string(), quotaValueSchema).readonly(),
  })
  .readonly();

const tokenStatsAllQuotasResultSchema = z.union([
  z
    .object({
      ok: z.literal(true).readonly(),
      value: allQuotasValueSchema,
    })
    .readonly(),
  z
    .object({
      ok: z.literal(false).readonly(),
      error: z
        .object({
          code: z.string().readonly(),
          message: z.string().readonly().optional(),
        })
        .readonly(),
    })
    .readonly(),
]);

const createTokenStatsAllQuotasResult = () => tokenStatsAllQuotasResultSchema;

// ---- bailian setup / credentials (百炼 Token Plan 凭据配置) ------------------
// 设置页「百炼 Token Plan 凭据」卡片：门控（配置了 qwen token plan 模型才显示）
// + AK/SK 保存/清除。返回值只含掩码，绝不出现密钥明文。

const bailianSetupValueSchema = z
  .object({
    modelConfigured: z.boolean(),
    akConfigured: z.boolean(),
    maskedAk: z.union([z.string(), z.null()]),
    region: z.string(),
    site: z.string(),
    routes: z.array(z.string()).readonly(),
  })
  .readonly();

const tokenStatsBailianSetupResultSchema = z.union([
  z
    .object({
      ok: z.literal(true).readonly(),
      value: bailianSetupValueSchema,
    })
    .readonly(),
  z
    .object({
      ok: z.literal(false).readonly(),
      error: z
        .object({
          code: z.string().readonly(),
          message: z.string().readonly().optional(),
        })
        .readonly(),
    })
    .readonly(),
]);

const createTokenStatsBailianSetupResult = () => tokenStatsBailianSetupResultSchema;

const bailianCredentialsInputSchema = z.object({
  accessKeyId: z.string(),
  accessKeySecret: z.string(),
});

const createBailianCredentialsInput = () => bailianCredentialsInputSchema;

const bailianSaveValueSchema = z
  .object({
    saved: z.boolean(),
    maskedAk: z.string(),
  })
  .readonly();

const tokenStatsBailianSaveResultSchema = z.union([
  z
    .object({
      ok: z.literal(true).readonly(),
      value: bailianSaveValueSchema,
    })
    .readonly(),
  z
    .object({
      ok: z.literal(false).readonly(),
      error: z
        .object({
          code: z.string().readonly(),
          message: z.string().readonly().optional(),
        })
        .readonly(),
    })
    .readonly(),
]);

const createTokenStatsBailianSaveResult = () => tokenStatsBailianSaveResultSchema;

const bailianClearValueSchema = z
  .object({
    cleared: z.boolean(),
  })
  .readonly();

const tokenStatsBailianClearResultSchema = z.union([
  z
    .object({
      ok: z.literal(true).readonly(),
      value: bailianClearValueSchema,
    })
    .readonly(),
  z
    .object({
      ok: z.literal(false).readonly(),
      error: z
        .object({
          code: z.string().readonly(),
          message: z.string().readonly().optional(),
        })
        .readonly(),
    })
    .readonly(),
]);

const createTokenStatsBailianClearResult = () => tokenStatsBailianClearResultSchema;

export const TYPERT = {
  package: "@duke-dsh-plugins/dsh-token-stats",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-token-stats#tokenStats/getStats",
      service: "tokenStats",
      namespace: "tokenStats",
      method: "getStats",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-token-stats#TokenStatsResult",
        schema: tokenStatsResultSchema,
        create: createTokenStatsResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-token-stats#tokenStats/getQuota",
      service: "tokenStats",
      namespace: "tokenStats",
      method: "getQuota",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "provider",
          wire: "provider",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-token-stats#tokenStats/getQuota:provider",
            schema: z.string(),
            create: createStringSchema,
          },
        },
        {
          name: "force",
          wire: "force",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-token-stats#tokenStats/getQuota:force",
            schema: z.boolean(),
            create: createBooleanSchema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-token-stats#TokenStatsQuotaResult",
        schema: tokenStatsQuotaResultSchema,
        create: createTokenStatsQuotaResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-token-stats#tokenStats/getAllQuotas",
      service: "tokenStats",
      namespace: "tokenStats",
      method: "getAllQuotas",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "force",
          wire: "force",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-token-stats#tokenStats/getAllQuotas:force",
            schema: z.boolean(),
            create: createBooleanSchema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-token-stats#TokenStatsAllQuotasResult",
        schema: tokenStatsAllQuotasResultSchema,
        create: createTokenStatsAllQuotasResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-token-stats#tokenStats/getBailianSetup",
      service: "tokenStats",
      namespace: "tokenStats",
      method: "getBailianSetup",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-token-stats#TokenStatsBailianSetupResult",
        schema: tokenStatsBailianSetupResultSchema,
        create: createTokenStatsBailianSetupResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-token-stats#tokenStats/saveBailianCredentials",
      service: "tokenStats",
      namespace: "tokenStats",
      method: "saveBailianCredentials",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "input",
          wire: "input",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-token-stats#tokenStats/saveBailianCredentials:input",
            schema: bailianCredentialsInputSchema,
            create: createBailianCredentialsInput,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-token-stats#TokenStatsBailianSaveResult",
        schema: tokenStatsBailianSaveResultSchema,
        create: createTokenStatsBailianSaveResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-token-stats#tokenStats/clearBailianCredentials",
      service: "tokenStats",
      namespace: "tokenStats",
      method: "clearBailianCredentials",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-token-stats#TokenStatsBailianClearResult",
        schema: tokenStatsBailianClearResultSchema,
        create: createTokenStatsBailianClearResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
  ],
  model: {
    services: [
      {
        description:
          "Token usage statistics service: aggregates per-model token consumption from the durable session log for the DeepSeek Harness web UI.",
        summary: "Token usage statistics service.",
        tags: [],
        jsDoc: "/**\n * Token usage statistics service: per-day, per-model token aggregates.\n */",
        key: "tokenStats",
        exportName: "TokenStatsService",
        members: [
          {
            kind: "method",
            name: "getStats",
            signature: "@Remote('getStats') async getStats(): Promise<TokenStatsResult>",
            summary:
              "Return the whole-dataset snapshot (last ~400 days, per-model per-day) for the Client charts.",
            jsDoc:
              "/**\n * Return the whole-dataset snapshot: ready/collecting state, backfill progress,\n * per-day per-model aggregates and the ordered model list.\n * @returns success or a business failure.\n */",
          },
          {
            kind: "method",
            name: "getQuota",
            signature:
              "@Remote('getQuota') async getQuota(provider: string, force: boolean): Promise<TokenStatsQuotaResult>",
            summary:
              "Read one provider's plan quota / balance (minimax | deepseek | kimi | openrouter | zhipu), cached per provider.",
            jsDoc:
              "/**\n * Read the plan quota / balance for one provider through the credentials seam\n * and the provider's own endpoint. Success caches 30 s; failures back off\n * exponentially (5 s → 30 min). `force` drops the cached entry first.\n * @param provider - internal provider key.\n * @param force - bypass the cache.\n * @returns success with the display payload or a business failure.\n */",
          },
          {
            kind: "method",
            name: "getAllQuotas",
            signature:
              "@Remote('getAllQuotas') async getAllQuotas(force: boolean): Promise<TokenStatsAllQuotasResult>",
            summary:
              "Read every supported provider's quota / balance in parallel (settings page balance section).",
            jsDoc:
              "/**\n * Snapshot all supported providers at once; each entry is the same wire\n * value getQuota returns. `force` bypasses every provider's cache.\n * @param force - bypass the caches.\n * @returns success with the per-provider quota map.\n */",
          },
          {
            kind: "method",
            name: "getBailianSetup",
            signature:
              "@Remote('getBailianSetup') async getBailianSetup(): Promise<TokenStatsBailianSetupResult>",
            summary:
              "Bailian Token Plan credential-setup state: whether a qwen token plan model is configured (gate), whether AK/SK exist, masked AK, region/site.",
            jsDoc:
              "/**\n * Setup state for the settings-page Bailian Token Plan credential card.\n * modelConfigured gates the card (only shown when a qwen token plan model\n * key resolves). Never returns secret material — only a masked AccessKey ID.\n * @returns success with the setup state or a business failure.\n */",
          },
          {
            kind: "method",
            name: "saveBailianCredentials",
            signature:
              "@Remote('saveBailianCredentials') async saveBailianCredentials(input: BailianCredentialsInput): Promise<TokenStatsBailianSaveResult>",
            summary:
              "Save Alibaba Cloud AK/SK into the official DSH credentials store and drop bailian caches.",
            jsDoc:
              "/**\n * Persist ALIBABA_CLOUD_ACCESS_KEY_ID / SECRET through the credentials\n * service (never echoed, never logged). Clears the bailian token / aux /\n * quota caches so the next read uses the new credentials.\n * @param input - AccessKey ID and Secret (trimmed, both required).\n * @returns success with a masked AK or a business failure.\n */",
          },
          {
            kind: "method",
            name: "clearBailianCredentials",
            signature:
              "@Remote('clearBailianCredentials') async clearBailianCredentials(): Promise<TokenStatsBailianClearResult>",
            summary:
              "Remove the stored Alibaba Cloud AK/SK (env-configured credentials are unaffected) and drop bailian caches.",
            jsDoc:
              "/**\n * Unset ALIBABA_CLOUD_ACCESS_KEY_ID / SECRET from the credentials store\n * and clear the bailian caches. Environment-variable credentials, if any,\n * keep applying as the fallback path.\n * @returns success or a business failure.\n */",
          },
        ],
        types: [
          {
            name: "TokenStatsValue",
            declaration:
              "export interface TokenStatsValue {\n    readonly ready: boolean;\n    readonly collecting: boolean;\n    readonly progress: { readonly done: number; readonly total: number };\n    readonly error: string | null;\n    readonly days: readonly { readonly date: string; readonly total: number; readonly models: readonly TokenStatsModelDay[] }[];\n    readonly models: readonly TokenStatsModelRef[];\n}",
          },
          {
            name: "TokenStatsModelDay",
            declaration:
              "export interface TokenStatsModelDay {\n    readonly key: string;\n    readonly name: string;\n    readonly provider: string;\n    readonly input: number;\n    readonly output: number;\n    readonly cacheRead: number;\n    readonly cacheWrite: number;\n    readonly reasoning: number;\n    readonly total: number;\n}",
          },
          {
            name: "TokenStatsModelRef",
            declaration:
              "export interface TokenStatsModelRef {\n    readonly key: string;\n    readonly name: string;\n    readonly provider: string;\n}",
          },
          {
            name: "TokenStatsResult",
            declaration:
              "export type TokenStatsResult = { ok: true; value: TokenStatsValue } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "TokenStatsQuotaDisplay",
            declaration:
              "export interface TokenStatsQuotaDisplay {\n    readonly fiveHrPct: number | null;\n    readonly weeklyPct: number | null;\n    readonly monthlyPct: number | null;\n    readonly fiveHrResetsIn: string | null;\n    readonly weeklyResetsIn: string | null;\n    readonly monthlyResetsIn: string | null;\n    readonly balanceText: string | null;\n    readonly balanceUsd: number | null;\n    readonly currency: string | null;\n}",
          },
          {
            name: "TokenStatsQuotaValue",
            declaration:
              "export type TokenStatsQuotaValue =\n    | { readonly ok: true; readonly provider: string; readonly display: TokenStatsQuotaDisplay }\n    | { readonly ok: false; readonly provider: string; readonly kind: string; readonly message: string };",
          },
          {
            name: "TokenStatsQuotaResult",
            declaration:
              "export type TokenStatsQuotaResult = { ok: true; value: TokenStatsQuotaValue } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "TokenStatsAllQuotasValue",
            declaration:
              "export interface TokenStatsAllQuotasValue {\n    readonly quotas: Record<string, TokenStatsQuotaValue>;\n}",
          },
          {
            name: "TokenStatsAllQuotasResult",
            declaration:
              "export type TokenStatsAllQuotasResult = { ok: true; value: TokenStatsAllQuotasValue } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "BailianSetupValue",
            declaration:
              "export interface BailianSetupValue {\n    readonly modelConfigured: boolean;\n    readonly akConfigured: boolean;\n    readonly maskedAk: string | null;\n    readonly region: string;\n    readonly site: string;\n    readonly routes: readonly string[];\n}",
          },
          {
            name: "TokenStatsBailianSetupResult",
            declaration:
              "export type TokenStatsBailianSetupResult = { ok: true; value: BailianSetupValue } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "BailianCredentialsInput",
            declaration:
              "export interface BailianCredentialsInput {\n    accessKeyId: string;\n    accessKeySecret: string;\n}",
          },
          {
            name: "BailianSaveValue",
            declaration:
              "export interface BailianSaveValue {\n    readonly saved: boolean;\n    readonly maskedAk: string;\n}",
          },
          {
            name: "TokenStatsBailianSaveResult",
            declaration:
              "export type TokenStatsBailianSaveResult = { ok: true; value: BailianSaveValue } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "BailianClearValue",
            declaration:
              "export interface BailianClearValue {\n    readonly cleared: boolean;\n}",
          },
          {
            name: "TokenStatsBailianClearResult",
            declaration:
              "export type TokenStatsBailianClearResult = { ok: true; value: BailianClearValue } | { ok: false; error: { code: string; message?: string } };",
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
};
