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

export const TYPERT = {
  package: "dsh-token-stats",
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
        ],
      },
    ],
    events: [],
    objects: [],
  },
};
