/**
 * Validates TYPERT (typert.host.js) against the REAL deployed validator —
 * @deepseek-ai/dsh-typert-loader's exported `validateTypertManifest`, the exact
 * function the DSH host runs when loading this package's `./typert` export.
 *
 * `npm run check` only syntax-checks; this smoke catches contract drift such
 * as the missing create() factories that made the v1.5.0 manifest unloadable
 * (typert-loader rejected it, so every tokenStats Remote call failed).
 *
 * Resolving the loader (in order):
 *   1. bare import — works when the workspace has the usual junctions
 *      (DSH deployment's @deepseek-ai/* + zod into ./node_modules, see AGENTS.md)
 *   2. DSH_NODE_MODULES=<path to the DSH deployment's node_modules>
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_NAME = "@duke-dsh-plugins/dsh-token-stats";

async function importLoader() {
  try {
    return await import("@deepseek-ai/dsh-typert-loader");
  } catch {
    // fall through to explicit locations
  }
  const candidates = [];
  if (process.env.DSH_NODE_MODULES) {
    candidates.push(
      join(process.env.DSH_NODE_MODULES, "@deepseek-ai", "dsh-typert-loader", "lib", "index.js"),
    );
  }
  candidates.push(
    join(pkgRoot, "node_modules", "@deepseek-ai", "dsh-typert-loader", "lib", "index.js"),
  );
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (hit === undefined) return undefined;
  return import(pathToFileURL(hit).href);
}

const loader = await importLoader();
if (loader === undefined) {
  console.error("smoke:typert — cannot import @deepseek-ai/dsh-typert-loader.");
  console.error("Junction the DSH deployment's @deepseek-ai/* and zod into ./node_modules");
  console.error("(see AGENTS.md) or set DSH_NODE_MODULES to the deployment's node_modules.");
  process.exit(1);
}

const { TYPERT } = await import(pathToFileURL(join(pkgRoot, "typert.host.js")).href);

try {
  loader.validateTypertManifest(PKG_NAME, TYPERT);
} catch (error) {
  console.error("smoke:typert — the deployed validator REJECTED the manifest:");
  console.error(String(error?.message ?? error));
  process.exit(1);
}

// Belt & braces: walk the codec inventory the loader validated and re-assert
// the create() requirement with a per-codec report.
let codecs = 0;
for (const invocation of TYPERT.invocations) {
  for (const codec of [...invocation.parameters.map((parameter) => parameter.codec), invocation.result]) {
    if (typeof codec.create !== "function") {
      console.error(`smoke:typert — codec ${codec.typeSymbol} has no create() factory`);
      process.exit(1);
    }
    codecs += 1;
  }
}

console.log(
  `smoke:typert — OK: deployed validator accepted ${TYPERT.invocations.length} invocations, ` +
    `${codecs} strict codecs all carry create() factories.`,
);
