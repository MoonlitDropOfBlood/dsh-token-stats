/**
 * Runs the REAL DSH compatibility gate against this package's own manifest.
 *
 * Why this exists: on dsh 0.2.0-rc.1 the plugin was silently dropped at boot.
 * `dsh-app-boot`'s `loadProfileDirectory` calls `evaluatePluginCompatibility` on
 * every profile bundle and, on a mismatch, *throws into `skippedBundles`* — the
 * `cordis.patch.yml` row never applies, `index.js` never mounts, `client.js`
 * never reaches `__DSH_BOOT__`, and `typert.host.js` is never even imported.
 * No exception surfaces; the UI just quietly has no Token 统计 page.
 *
 * The trap this guards: `semver.satisfies(runtime, range, {includePrerelease:true})`
 * admits `0.2.0-rc.1` under a `... <0.2.0` cap (a prerelease sorts *below* its
 * release), so `engines.dsh` looked correct while the real culprit sat in a
 * different peer. `evaluatePluginCompatibility` covers both — it checks every
 * `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer — so asserting on its result is
 * the only check that actually predicts "will this bundle load?".
 *
 * Resolving app-boot (in order):
 *   1. bare import — works when the workspace has the usual junctions
 *      (DSH deployment's @deepseek-ai/* + zod into ./node_modules, see AGENTS.md)
 *   2. DSH_NODE_MODULES=<path to the DSH deployment's node_modules>
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function importAppBoot() {
  try {
    return await import("@deepseek-ai/dsh-app-boot");
  } catch {
    // fall through to explicit locations
  }
  const candidates = [];
  if (process.env.DSH_NODE_MODULES) {
    candidates.push(join(process.env.DSH_NODE_MODULES, "@deepseek-ai", "dsh-app-boot", "lib", "index.js"));
  }
  candidates.push(join(pkgRoot, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js"));
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (hit === undefined) return undefined;
  return import(pathToFileURL(hit).href);
}

const appBoot = await importAppBoot();
if (appBoot === undefined || typeof appBoot.evaluatePluginCompatibility !== "function") {
  console.error("smoke:compat — cannot import evaluatePluginCompatibility from @deepseek-ai/dsh-app-boot.");
  console.error("Junction the DSH deployment's @deepseek-ai/* into ./node_modules (see AGENTS.md)");
  console.error("or set DSH_NODE_MODULES to the deployment's node_modules.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const runtimeVersion = appBoot.getDshRuntimeVersion();
const issue = appBoot.evaluatePluginCompatibility(manifest, {}, runtimeVersion);

if (issue !== undefined) {
  console.error(
    `smoke:compat — FAIL: this bundle would be SKIPPED on dsh ${runtimeVersion}. ` +
      "Incompatible peers: " +
      JSON.stringify(issue.peers, null, 2),
  );
  console.error("");
  console.error("Widen the offending peerDependencies range(s) so they admit the running runtime.");
  console.error("A `<0.2.0` cap silently EXCLUDES nothing for 0.2.0-rc.x but excludes 0.2.0 final —");
  console.error("prefer an explicit `<0.3.0` upper bound, or a union like `^0.1.0-rc.7 || ^0.2.0-rc.1`.");
  process.exit(1);
}

// Also assert the manifest fields DSH itself reads, so a typo surfaces here rather
// than as a silent skip or an empty market card.
const peers = manifest.peerDependencies ?? {};
if (peers["@deepseek-ai/dsh"] !== manifest.engines?.dsh) {
  console.error(
    `smoke:compat — engines.dsh (${manifest.engines?.dsh}) and the @deepseek-ai/dsh peer ` +
      `(${peers["@deepseek-ai/dsh"]}) disagree; keep them identical (dsh-market shows the union).`,
  );
  process.exit(1);
}

const skipped = new Set();
for (const [name, range] of Object.entries(peers)) {
  if (name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-")) skipped.add(`${name}@${range}`);
}

console.log(
  `smoke:compat — OK: the deployed gate accepts ${manifest.name}@${manifest.version} on dsh ` +
    `${runtimeVersion} (engines.dsh ${manifest.engines.dsh}; peers ${skipped.size} dsh range(s)).`,
);
