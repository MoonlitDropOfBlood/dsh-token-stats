#!/usr/bin/env node
/**
 * Local installer for dsh-token-stats.
 *
 * Installs the plugin into the DSH web profile:
 *   1. Copies this package (the project root) into
 *      `<DSH_HOME>/profiles/web/node_modules/dsh-token-stats/`.
 *   2. Ensures the profile's `cordis.patch.yml` mounts it via an `insert` row.
 *   3. Reports whether a DSH restart is required.
 *
 * Usage:
 *   node scripts/install.mjs            # install into default profile (web)
 *   DSH_HOME=<path> node scripts/install.mjs
 *   DSH_PROFILE=<name> node scripts/install.mjs
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const PKG_NAME = "dsh-token-stats";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const PROFILE = process.env.DSH_PROFILE || "web";
const PROFILE_DIR = join(DSH_HOME, "profiles", PROFILE);
const NODE_MODULES = join(PROFILE_DIR, "node_modules");
const TARGET = join(NODE_MODULES, PKG_NAME);
const PATCH_FILE = join(PROFILE_DIR, "cordis.patch.yml");

/** Files shipped to the profile. */
const SHIP = ["package.json", "index.js", "client.js", "typert.host.js"];

function log(prefix, message) {
  console.log(`[${prefix}] ${message}`);
}

function pkgJson() {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
}

async function ensureProfile() {
  await mkdir(NODE_MODULES, { recursive: true });
}

async function copyPackage() {
  await mkdir(TARGET, { recursive: true });
  for (const file of SHIP) {
    const src = join(PROJECT_ROOT, file);
    if (!existsSync(src)) throw new Error(`missing shipped file: ${file}`);
    await cp(src, join(TARGET, file));
  }
  log("install", `copied plugin to ${TARGET}`);
}

/** Build the insert block for the plugin. */
function insertBlock() {
  return (
    "# --- dsh-token-stats (managed by scripts/install.mjs) ---\n" +
    "- insert:\n" +
    "  - id: token-stats\n" +
    `    name: '${PKG_NAME}'\n`
  );
}

/** True when the patch body is effectively empty (a bare `[]` or blank). */
function isEmptyPatch(text) {
  const body = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  return body.length === 0 || (body.length === 1 && body[0] === "[]");
}

/**
 * Merge an `insert` row for the plugin into the profile patch (idempotent).
 * If the existing patch is an empty placeholder (`[]`), it is replaced so the
 * file stays a single valid YAML list.
 */
async function ensurePatch() {
  let text = "";
  if (existsSync(PATCH_FILE)) {
    text = await readFile(PATCH_FILE, "utf8");
  }
  if (text.includes(`name: '${PKG_NAME}'`)) {
    log("patch", "plugin row already present, skipping");
    return false;
  }
  const block = insertBlock();
  if (isEmptyPatch(text)) {
    await writeFile(PATCH_FILE, block, "utf8");
    log("patch", `replaced empty patch in ${PATCH_FILE}`);
  } else {
    const trimmed = text.trimEnd();
    const next = trimmed.length === 0 ? block : trimmed + "\n\n" + block;
    await writeFile(PATCH_FILE, next, "utf8");
    log("patch", `added mount row to ${PATCH_FILE}`);
  }
  return true;
}

/**
 * Best-effort dependency availability check. DSH hoists shared deps to
 * `<DSH_HOME>/profiles/node_modules`, so a module under the profile resolves
 * them by walking up parent directories and probing `<dir>/node_modules`.
 * Reproduce that chain from the profile directory upward.
 */
async function checkDeps() {
  const deps = ["zod", "@deepseek-ai/cordis", "@deepseek-ai/dsh-typert-protocol"];
  const missing = [];
  for (const dep of deps) {
    let found = false;
    let dir = PROFILE_DIR;
    for (let depth = 0; depth < 5 && !found; depth++) {
      if (existsSync(join(dir, "node_modules", dep, "package.json"))) found = true;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!found) missing.push(dep);
  }
  if (missing.length) {
    log("warn", `dependencies not resolvable from profile: ${missing.join(", ")}`);
    log(
      "warn",
      `install the deps into the profile (dsh plugin add / npm install) so DSH ` +
        `can resolve them, then restart DSH.`,
    );
  } else {
    log("ok", "dependencies resolvable from the DSH shared node_modules layer");
  }
}

async function main() {
  const info = pkgJson();
  log("info", `installing ${info.name}@${info.version} into DSH profile "${PROFILE}"`);
  await ensureProfile();
  await copyPackage();
  await ensurePatch();
  await checkDeps();
  log("done", `restart DSH (node <dsh bin> web --profile ${PROFILE}) for the plugin to take effect.`);
}

main().catch((error) => {
  console.error(`[install] failed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
