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
    fiveHrResetsIn: z.union([z.string(), z.null()]),
    weeklyResetsIn: z.union([z.string(), z.null()]),
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
              "export interface TokenStatsQuotaDisplay {\n    readonly fiveHrPct: number | null;\n    readonly weeklyPct: number | null;\n    readonly fiveHrResetsIn: string | null;\n    readonly weeklyResetsIn: string | null;\n    readonly balanceText: string | null;\n    readonly balanceUsd: number | null;\n    readonly currency: string | null;\n}",
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
        ],
      },
    ],
    events: [],
    objects: [],
  },
};
