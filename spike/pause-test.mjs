// Clean test: NO contact with the VM for 4 minutes (idle timeout is 30 s), then read state once.
// Result decides whether a live-polling brain keeps the VM awake at all.
import { readFileSync } from "node:fs";

process.env.FREESTYLE_API_KEY = readFileSync("../VPS-KEY.txt", "utf8").split(/\r?\n/)[0].trim();
const { Freestyle } = await import("freestyle");
const vm = new Freestyle().vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");

const t0 = new Date().toISOString();
console.log(`T0 ${t0} — going quiet for 240 s (brain is polling, nothing else touches the VM)…`);
await new Promise((r) => setTimeout(r, 240000));
const d = await vm.data();
console.log(
  `T0+240s: state=${d.state} totalRunSeconds=${d.totalRunSeconds} lastNetworkActivity=${d.lastNetworkActivity}`
);
console.log(
  d.state === "paused"
    ? "VERDICT: the brain's polling does NOT hold the VM awake → poll-only design is unreliable by nature."
    : "VERDICT: VM still running after 8× the idle timeout with only the brain polling → polling does hold it awake (yesterday's freeze = separate event)."
);
