// CLEAN verification: zero contact with the VM for 10 minutes (idle timeout = 30 s),
// then one read-only state snapshot + one read of log/process identity.
// If the VM is still "running" after 10 min of total silence, the only thing that could
// have kept it alive is the brain's own polling (nobody else touched it).
import { readFileSync } from "node:fs";

process.env.FREESTYLE_API_KEY = readFileSync("../VPS-KEY.txt", "utf8").split(/\r?\n/)[0].trim();
const { Freestyle } = await import("freestyle");
const vm = new Freestyle().vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");

console.log(`T0 ${new Date().toISOString()} — ZERO contact for 600 s (no data(), no exec)`);
await new Promise((r) => setTimeout(r, 600000));
const d = await vm.data();
console.log(`T1 ${new Date().toISOString()} -> state=${d.state} lastNetworkActivity=${d.lastNetworkActivity} totalRunSeconds=${d.totalRunSeconds}`);
console.log(
  d.state === "paused"
    ? "RESULT: PAUSED — polling does NOT hold the VM awake (my turn-38 claim would be wrong)."
    : "RESULT: RUNNING after 10 min of total silence — polling DOES hold it awake (claim confirmed)."
);
const r = await vm.exec({
  command:
    "date -u; ps -eo pid,etime,args | grep 'node bot/bot.mjs' | grep -v grep; " +
    "tail -4 /home/ubuntu/shopeefood-tracker/logs/bot.log",
  timeoutMs: 30000,
});
console.log("--- identity + log ---\n" + r.stdout);
