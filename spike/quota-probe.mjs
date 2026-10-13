// Decisive experiment: does the brain's OWN polling keep the VM awake?
// vm.data() twice, 75 s apart, with NOTHING else touching the VM in between.
// Then: what did the brain log during that window, and is the process still the same PID?
import { readFileSync } from "node:fs";

process.env.FREESTYLE_API_KEY = readFileSync("../VPS-KEY.txt", "utf8").split(/\r?\n/)[0].trim();
const { Freestyle } = await import("freestyle");
const vm = new Freestyle().vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");

const snap = async (label) => {
  const d = await vm.data();
  console.log(
    `${label}: state=${d.state} totalRunSeconds=${d.totalRunSeconds} lastNetworkActivity=${d.lastNetworkActivity}`
  );
  return d;
};

const a = await snap("T0     ");
console.log("… waiting 75 s without touching the VM …");
await new Promise((r) => setTimeout(r, 75000));
const b = await snap("T0+75s ");

console.log(`delta run seconds: ${b.totalRunSeconds - a.totalRunSeconds} (expect ~0 if it paused, ~75 if polling kept it awake)`);

const r = await vm.exec({
  command:
    "date -u; echo ---PS---; ps -eo pid,etime,rss,args | grep 'node bot/bot.mjs' | grep -v grep; " +
    "echo ---LOGTAIL---; tail -6 /home/ubuntu/shopeefood-tracker/logs/bot.log",
  timeoutMs: 30000,
});
console.log("--- after-probe read ---");
console.log(r.stdout);
