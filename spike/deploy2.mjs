// Deploy v2 — payload via exec stdin (avoids the 502 from huge command lines).
// Auto-detects stdin semantics (decoded vs raw-base64) by byte-count verify.
import { readFileSync } from "node:fs";

const key = readFileSync(new URL("../VPS-KEY.txt", import.meta.url), "utf8").split(/\r?\n/)[0].trim();
const botToken = readFileSync(new URL("../BOT-KEY.txt", import.meta.url), "utf8").split(/\r?\n/)[0].trim();
if (!key || !botToken) { console.log("FAIL: missing key(s)"); process.exit(1); }
process.env.FREESTYLE_API_KEY = key;

const { Freestyle } = await import("freestyle");
const f = new Freestyle();
const vm = f.vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");
const ROOT = "/home/ubuntu/shopeefood-tracker";

async function exec(opts, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await vm.exec({ timeoutMs: 30000, ...opts }); }
    catch (e) {
      lastErr = e;
      console.log(`  exec attempt ${i + 1}/${tries} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw lastErr;
}

async function writeFile(path, content) {
  const expected = Buffer.byteLength(content, "utf8");
  const b = Buffer.from(content, "utf8").toString("base64");
  for (const cmd of [`cat > ${path}`, `base64 -d > ${path}`]) {
    const w = await exec({ command: cmd, stdin: b });
    if (w.statusCode !== 0) continue;
    const c = await exec({ command: `wc -c < ${path}` });
    if (Number(c.stdout.trim()) === expected) {
      console.log(`wrote ${path} (${expected} bytes) via \`${cmd.split(" >")[0]}\``);
      return true;
    }
    console.log(`  verify mismatch for ${path} via \`${cmd.split(" >")[0]}\``);
  }
  throw new Error(`could not write ${path} (expected ${expected} bytes)`);
}

const src = readFileSync(new URL("../shopeefood-tracker/bot/bot.mjs", import.meta.url), "utf8");
await writeFile(`${ROOT}/bot/bot.mjs`, src);
await writeFile(`${ROOT}/config/bot-token.txt`, botToken);
await exec({ command: `chmod 600 ${ROOT}/config/bot-token.txt` });

const v = await exec({ command: `ls -la ${ROOT}/bot ${ROOT}/config; head -2 ${ROOT}/bot/bot.mjs` });
console.log("--- remote verify ---\n" + v.stdout);
console.log("DEPLOY-DONE");
