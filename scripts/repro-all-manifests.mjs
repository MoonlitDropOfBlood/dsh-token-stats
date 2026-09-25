/**
 * Full-composition reproduction: register EVERY discoverable typert manifest
 * (deployment + profile node_modules packages exporting ./typert) into one
 * real TypertRegistry in load order, with dsh-token-stats LAST (its real
 * composition position), and report any cross-package registration conflict.
 */
import { Context } from "@deepseek-ai/cordis";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { validateTypertManifest } from "@deepseek-ai/dsh-typert-loader";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ctx = new Context();
const registry = new TypertRegistry(ctx);
const typert = ctx.typert ?? (ctx.set("typert", registry), ctx.typert);

const roots = [
  "C:/Users/wwhby/AppData/Roaming/DeepSeek Harness Desktop/dsh/node_modules",
  "C:/Users/wwhby/.dsh/profiles/web/node_modules",
];

const dirs = [];
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith("@")) {
      const scopeDir = join(root, entry.name);
      for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
        if (sub.isDirectory()) dirs.push(join(scopeDir, sub.name));
      }
    } else if (entry.isDirectory() && entry.name !== ".plugin-manager") {
      dirs.push(join(root, entry.name));
    }
  }
}
// our workspace copy, standing in for the installed profile package (added last)
dirs.push("D:/ai-projects/dsh/dsh-token-stats");

const typertPkgs = [];
for (const dir of dirs) {
  const pkgJsonPath = join(dir, "package.json");
  if (!existsSync(pkgJsonPath)) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch {
    continue;
  }
  const rel = manifest?.exports?.["./typert"];
  if (typeof rel === "string") typertPkgs.push({ name: String(manifest.name), dir, rel });
}
typertPkgs.sort((a, b) => Number(a.name === "@duke-dsh-plugins/dsh-token-stats") - Number(b.name === "@duke-dsh-plugins/dsh-token-stats"));
console.log(`packages exporting ./typert: ${typertPkgs.length} (token-stats forced last)`);

let ok = 0;
const failures = [];
for (const pkg of typertPkgs) {
  try {
    const mod = await import(pathToFileURL(join(pkg.dir, pkg.rel).replaceAll("\\", "/")).href);
    const manifest = validateTypertManifest(pkg.name, mod.TYPERT);
    typert.register(manifest);
    ok += 1;
    if (pkg.name === "@duke-dsh-plugins/dsh-token-stats") console.log(`registered OK (last): ${pkg.name}`);
  } catch (error) {
    failures.push({ pkg: pkg.name, message: String(error?.message ?? error) });
    console.log(`REGISTER FAILED: ${pkg.name} -> ${String(error?.message ?? error).slice(0, 400)}`);
  }
}
console.log(`\nsummary: ${ok}/${typertPkgs.length} registered, ${failures.length} failures`);
if (failures.length > 0) process.exit(1);
