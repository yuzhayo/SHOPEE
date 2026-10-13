import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOPEE_ROOT = join(__dirname, "..");
process.env.FREESTYLE_API_KEY = readFileSync(join(SHOPEE_ROOT, "VPS-KEY.txt"), "utf8").split(/\r?\n/)[0].trim();
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
const UNIT = `[Unit]\nDescription=ShopeeFood tracker brain (Telegram order bot)\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${ROOT}\nExecStart=/usr/local/bin/node bot/bot.mjs\nRestart=always\nRestartSec=5\nUser=ubuntu\nStandardOutput=append:${ROOT}/logs/nohup.out\nStandardError=append:${ROOT}/logs/nohup.out\n\n[Install]\nWantedBy=multi-user.target\n`;
const s = await sh("sudo -n true && echo SUDO-OK || echo NO-SUDO", null);
if (!s.stdout.includes("SUDO-OK")) throw new Error("no passwordless sudo — cannot install the unit");
console.log("sudo: OK");
const enc = b64(UNIT);
await sh(`echo '${enc}' | base64 -d > /tmp/shopee-brain.service && sudo mv /tmp/shopee-brain.service /etc/systemd/system/shopee-brain.service && sudo chmod 644 /etc/systemd/system/shopee-brain.service`, "unit written");
const back = (await sh(`base64 -w0 < /etc/systemd/system/shopee-brain.service`, null)).stdout.trim();
if (back !== enc) throw new Error("unit byte mismatch");
const ps = await sh("ps -eo pid,args", null);
const line = ps.stdout.split("\n").find((l) => /^\s*\d+\s+node bot\/bot\.mjs\s*$/.test(l));
if (line) { const pid = line.trim().split(/\s+/)[0]; console.log(`stopping nohup brain ${pid}`); await sh(`kill ${pid} && sleep 1`, "killed"); } else console.log("no loose brain running");
await sh(`sudo systemctl daemon-reload && sudo systemctl enable --now shopee-brain && sleep 4 && echo ---STATUS---; systemctl is-active shopee-brain; systemctl show shopee-brain -p NRestarts --value; echo ---PS---; ps -eo pid,ppid,args | grep 'node bot/bot.mjs' | grep -v grep; echo ---LOG---; tail -2 ${ROOT}/logs/bot.log; echo ---BOOT---; tail -2 ${ROOT}/logs/nohup.out`, "systemd live");
console.log("SUPERVISE-DONE");