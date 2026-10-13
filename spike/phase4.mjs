// Phase 4 — deploy + store merge + restart (kill-before-write, no pattern-kill).
// 1. deploy bot.mjs (byte-verified)
// 2. find exact PID from ps, kill it
// 3. read customers.json → merge OCR event for Jack's screenshot (idempotent) → write back
// 4. relaunch + verify (log / ps / store / history header)
import { readFileSync } from "node:fs";

process.env.FREESTYLE_API_KEY = readFileSync("../VPS-KEY.txt", "utf8").split(/\r?\n/)[0].trim();
const { Freestyle } = await import("freestyle");
const f = new Freestyle();
const vm = f.vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");

const ROOT = "/home/ubuntu/shopeefood-tracker";

async function sh(command, stdin, label) {
  let lastErr = "";
  for (let i = 0; i < 3; i++) {
    try {
      const r = await vm.exec({ command, ...(stdin ? { stdin } : {}), timeoutMs: 30000 });
      if (r.statusCode === 0) {
        if (label && r.stdout) console.log(`--- ${label} ---\n${r.stdout.trim()}`);
        return r;
      }
      lastErr = `statusCode=${r.statusCode} ${(r.stdout || "") + (r.stderr || "")}`.slice(0, 300);
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 300);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: failed after 3 tries: ${lastErr}`);
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// 1 — deploy bot.mjs
const bot = readFileSync("../shopeefood-tracker/bot/bot.mjs");
const botB64 = b64(bot.toString("utf8"));
await sh(`echo '${botB64}' | base64 -d > ${ROOT}/bot/bot.mjs && wc -c ${ROOT}/bot/bot.mjs`, null, "deploy bot.mjs");
if ((await sh(`cat ${ROOT}/bot/bot.mjs | base64 -w0`, null)).stdout.trim() !== botB64)
  throw new Error("bot.mjs byte mismatch");

// 2b — push Sheet mail-slot URL to VM config
try {
  const url = readFileSync("../SHEET-URL.txt", "utf8").trim();
  const urlB64 = b64(url + "\n");
  await sh(`echo '${urlB64}' | base64 -d > ${ROOT}/config/sheet-url.txt && chmod 600 ${ROOT}/config/sheet-url.txt && wc -c ${ROOT}/config/sheet-url.txt`, null, "sheet-url config");
} catch {
  console.log("no SHEET-URL.txt — sync stays disabled");
}

// 2 — kill old brain by exact PID
const ps = await sh("ps -eo pid,args", null);
const line = ps.stdout.split("\n").find((l) => /^\s*\d+\s+node bot\/bot\.mjs\s*$/.test(l));
const oldPid = line ? line.trim().split(/\s+/)[0] : null;
console.log(`old brain pid: ${oldPid ?? "none (not running)"}`);
if (oldPid) await sh(`kill ${oldPid} && sleep 1`, null, "kill old");

// 3 — read store (kill happened → disk is current), merge OCR event idempotently
const cat = await sh(`cat ${ROOT}/notebook/customers.json 2>/dev/null || true`, null);
let store;
try {
  store = JSON.parse(cat.stdout);
} catch {
  store = null;
}
const T = Date.parse("2026-10-12T11:28:00.000Z");
if (!store || typeof store !== "object") store = {};
const rec = (store["6285790962643"] ||= {
  orders: 1,
  first: T,
  last: T,
  prevLast: null,
  banned: false,
  banReason: "",
  banDate: 0,
});
if (!Array.isArray(rec.events)) rec.events = [];
if (!rec.events.length) {
  rec.events.push({
    no: "530",
    id: "3300155108395520491",
    ts: T,
    shot: "2026-10-12/1791804532601_6285790962643.jpg",
  });
}
const storeStr = JSON.stringify(store, null, 1) + "\n";
const storeB64 = b64(storeStr);
await sh(`echo '${storeB64}' | base64 -d > ${ROOT}/notebook/customers.json && wc -c ${ROOT}/notebook/customers.json`, null, "store merged");

// 4 — relaunch + verify
await sh(
  `(cd ${ROOT} && nohup node bot/bot.mjs > logs/nohup.out 2>&1 &); sleep 3; ` +
    `echo ---LOG---; tail -2 ${ROOT}/logs/bot.log; ` +
    `echo ---PS---; ps -eo pid,args | grep 'node bot/bot.mjs' | grep -v grep; ` +
    `echo ---NOHUP---; cat ${ROOT}/logs/nohup.out; ` +
    `echo ---HIST---; head -2 ${ROOT}/notebook/history.tsv`,
  null,
  "relaunch + verify"
);

console.log("PHASE4-DEPLOY-DONE");
