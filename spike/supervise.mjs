// supervise — install a systemd unit so the brain survives reboots (P2).
// Evidence for this: the VM rebooted itself at ~04:06Z on Oct 13 and the nohup'd
// brain died with it (17 min of deafness until a manual relaunch).
// Idempotent: re-running just restarts the unit. STOP the unit before the ear
// (Phase 6) goes live — see RUNBOOK.md.
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

const UNIT = `[Unit]
Description=ShopeeFood tracker brain (Telegram order bot)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=/usr/local/bin/node bot/bot.mjs
Restart=always
RestartSec=5
User=ubuntu
StandardOutput=append:${ROOT}/logs/nohup.out
StandardError=append:${ROOT}/logs/nohup.out

[Install]
WantedBy=multi-user.target
`;

// 1 — sudo check
const s = await sh("sudo -n true && echo SUDO-OK || echo NO-SUDO", null);
if (!s.stdout.includes("SUDO-OK")) throw new Error("no passwordless sudo — cannot install the unit");
console.log("sudo: OK");

// 2 — write the unit (byte-verified)
const enc = b64(UNIT);
await sh(`echo '${enc}' | base64 -d > /tmp/shopee-brain.service && sudo mv /tmp/shopee-brain.service /etc/systemd/system/shopee-brain.service && sudo chmod 644 /etc/systemd/system/shopee-brain.service`, "unit written");
const back = (await sh(`base64 -w0 < /etc/systemd/system/shopee-brain.service`, null)).stdout.trim();
if (back !== enc) throw new Error("unit byte mismatch");

// 3 — stop the nohup'd brain by exact PID first (two pollers = duplicate replies),
//     then hand the process over to systemd
const ps = await sh("ps -eo pid,args", null);
const line = ps.stdout.split("\n").find((l) => /^\s*\d+\s+node bot\/bot\.mjs\s*$/.test(l));
if (line) {
  const pid = line.trim().split(/\s+/)[0];
  console.log(`stopping nohup brain ${pid}`);
  await sh(`kill ${pid} && sleep 1`, "killed");
} else {
  console.log("no loose brain running");
}

// 4 — enable + start under systemd, then prove exactly one brain exists
await sh(
  `sudo systemctl daemon-reload && sudo systemctl enable --now shopee-brain && sleep 4 && ` +
    `echo ---STATUS---; systemctl is-active shopee-brain; systemctl show shopee-brain -p NRestarts --value; ` +
    `echo ---PS---; ps -eo pid,ppid,args | grep 'node bot/bot.mjs' | grep -v grep; ` +
    `echo ---LOG---; tail -2 ${ROOT}/logs/bot.log; ` +
    `echo ---BOOT---; tail -2 ${ROOT}/logs/nohup.out`,
  "systemd live"
);

console.log("SUPERVISE-DONE");
