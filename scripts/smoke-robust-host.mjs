// Throwaway robustness check (not part of the package): hostile ctx seams.
import { TokenStatsService } from "../index.js";

const initKey = Object.getOwnPropertySymbols(TokenStatsService.prototype).find(
  (s) => typeof TokenStatsService.prototype[s] === "function"
);

let provided = [];
const ctx = {
  reflect: { provide(name, svc) { provided.push(name); } },
  on() { throw new Error("0.1.7-style event seam unavailable"); },
  get() { return undefined; },
  effect() { throw new Error("effect seam unavailable"); },
};
const svc = new TokenStatsService(ctx, {});
try {
  svc[initKey]();
  console.log("init survived throwing seams");
} catch (e) {
  console.log("INIT THREW (bad):", e.message);
  process.exit(1);
}
const stats = await svc.getStats();
console.log("getStats ok:", stats.ok, "ready:", stats.value.ready, "error:", stats.value.error);
const q = await svc.getQuota("deepseek", false);
console.log("getQuota ok:", q.ok, "kind:", q.value.kind);
const all = await svc.getAllQuotas(false);
console.log("getAllQuotas ok:", all.ok, "providers:", Object.keys(all.value.quotas).length);

// Normal ctx (seams fine, no sessionQuery): everything must register.
const ctx2 = {
  reflect: { provide() {} },
  on() { return () => {}; },
  get() { return undefined; },
  effect(fn) { return fn(); },
};
const svc2 = new TokenStatsService(ctx2, {});
svc2[initKey]();
const stats2 = await svc2.getStats();
console.log("normal ctx getStats ok:", stats2.ok, "error:", stats2.value.error);
