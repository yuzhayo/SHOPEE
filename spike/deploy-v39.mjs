// deploy-v39 — ship the turn-39 bot (fixes + --once doorbell mode) + the local
// harness to the VM. Same discipline as phase4.mjs: byte-verified upload,
// exact-PID kill (never a pattern kill), relaunch, evidence dump.
import { readFileSync } from "node:fs";

process.env.FREESTYLE_API_KEY = readFileSync("../VPS-KEY.txt", "utf8").split(/\r?\n/)[0].trim();
const { Freestyle } = await import("freestyle");
const vm = new Freestyle().vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");
const ROOT = "/home/ubuntu/shopeefood-tracker";

async function sh(command, label) {
  let lastErr = "";
  for (let i = 0; i < 3; i++) {
    try {
      const r = await vm.exec({ command, timeoutMs: 30000 });
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

async function ship(localPath, remotePath, label) {
  const data = readFileSync(localPath);
  const enc = b64(data.toString("utf8"));
  await sh(`mkdir -p $(dirname ${remotePath}) && echo '${enc}' | base64 -d > ${remotePath} && wc -c ${remotePath}`, `${label} written`);
  const back = (await sh(`base64 -w0 < ${remotePath}`, null)).stdout.trim();
  if (back !== enc) throw new Error(`${label}: byte mismatch after upload`);
  console.log(`${label}: byte-verified (${data.length} bytes)`);
}

// 1 — upload (bot first; the running brain ignores the new file until relaunch)
await ship("../shopeefood-tracker/bot/bot.mjs", `${ROOT}/bot/bot.mjs`, "bot.mjs");
await ship("../shopeefood-tracker/tests/bot.test.mjs", `${ROOT}/tests/bot.test.mjs`, "tests/bot.test.mjs");

// 2 — kill the old brain by exact PID (kill-before-write discipline: file already written,
//     the dying process can no longer overwrite anything)
const ps = await sh("ps -eo pid,args", null);
const line = ps.stdout.split("\n").find((l) => /^\s*\d+\s+node bot\/bot\.mjs\s*$/.test(l));
const oldPid = line ? line.trim().split(/\s+/)[0] : null;
console.log(`old brain pid: ${oldPid ?? "none (not running)"}`);
if (oldPid) await sh(`kill ${oldPid} && sleep 1`, "killed");

// 3 — relaunch (polling mode stays on until the ear is live) + evidence
await sh(
  `(cd ${ROOT} && nohup node bot/bot.mjs > logs/nohup.out 2>&1 &); sleep 4; ` +
    `echo ---LOG---; tail -3 ${ROOT}/logs/bot.log; ` +
    `echo ---PS---; ps -eo pid,etime,args | grep 'node bot/bot.mjs' | grep -v grep; ` +
    `echo ---NOHUP---; cat ${ROOT}/logs/nohup.out; ` +
    `echo ---STORE---; cat ${ROOT}/notebook/customers.json; ` +
    `echo ---SYNTAX---; node --check ${ROOT}/bot/bot.mjs && echo VM-SYNTAX-OK`,
  "relaunch + verify"
);

console.log("DEPLOY-V39-DONE");
