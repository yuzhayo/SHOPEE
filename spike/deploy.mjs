// Deploy local shopeefood-tracker sources + bot token to the VM.
// Fixes the dash brace-expansion folder mess from probe.mjs along the way.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const key = readFileSync(new URL("../VPS-KEY.txt", import.meta.url), "utf8")
  .split(/\r?\n/)[0].trim();
const botToken = readFileSync(new URL("../BOT-KEY.txt", import.meta.url), "utf8")
  .split(/\r?\n/)[0].trim();
if (!key || !botToken) {
  console.log("FAIL: missing key(s)");
  process.exit(1);
}
process.env.FREESTYLE_API_KEY = key;

const { Freestyle } = await import("freestyle");
const f = new Freestyle();
const vm = f.vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");

const ROOT = "/home/ubuntu/shopeefood-tracker";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const run = async (label, command) => {
  const r = await vm.exec({ command, timeoutMs: 30000 });
  console.log(`[${label}] statusCode=${r.statusCode}${r.stdout ? " | " + r.stdout.trim() : ""}${r.stderr ? " | err=" + r.stderr.trim() : ""}`);
  if (r.statusCode !== 0) throw new Error(`deploy step failed: ${label}`);
};

// 1. fix folders (dash ignored braces, created a literal {..} dir)
await run("dirs", `rm -rf '${ROOT}/{bot,brain,notebook,config,logs}'; mkdir -p ${ROOT}/bot ${ROOT}/brain ${ROOT}/notebook ${ROOT}/config ${ROOT}/logs; ls ${ROOT}`);

// 2. bot source
const src = readFileSync(new URL("../shopeefood-tracker/bot/bot.mjs", import.meta.url), "utf8");
await run("bot.mjs", `echo ${b64(src)} | base64 -d > ${ROOT}/bot/bot.mjs && wc -c ${ROOT}/bot/bot.mjs`);

// 3. bot token (mode 600)
await run("token", `echo ${b64(botToken)} | base64 -d > ${ROOT}/config/bot-token.txt && chmod 600 ${ROOT}/config/bot-token.txt && echo token-installed`);

console.log("DEPLOY-DONE");
