// netlify-ear — everything that touches the Netlify doorbell + the webhook switch.
//
//   node netlify-ear.mjs env <site-url>      set the two secrets on the site
//   node netlify-ear.mjs switch <site-url>   point Telegram at the ear, stop polling
//   node netlify-ear.mjs rollback            back to polling (deleteWebhook + unit on)
//
// Secrets stay in files: VPS-KEY.txt (VM), BOT-KEY.txt (Telegram),
// WEBHOOK-SECRET.txt (generated here once, shared with Telegram + Netlify).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

process.env.FREESTYLE_API_KEY = readFileSync("../VPS-KEY.txt", "utf8").split(/\r?\n/)[0].trim();
const { Freestyle } = await import("freestyle");
const vm = new Freestyle().vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");

const TOKEN = readFileSync("../BOT-KEY.txt", "utf8").split(/\r?\n/)[0].trim();
const TG = `https://api.telegram.org/bot${TOKEN}`;
const ROOT = "/home/ubuntu/shopeefood-tracker";

const mode = process.argv[2];
const arg = process.argv[3];

async function sh(command) {
  let lastErr = "";
  for (let i = 0; i < 3; i++) {
    try {
      const r = await vm.exec({ command, timeoutMs: 30000 });
      if (r.statusCode === 0) return r;
      lastErr = `statusCode=${r.statusCode} ${(r.stdout || "") + (r.stderr || "")}`.slice(0, 300);
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 300);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`failed after 3 tries: ${lastErr}`);
}

// ---- the shared webhook secret: one value, two homes (Telegram + Netlify) ----
function webhookSecret() {
  const f = "../WEBHOOK-SECRET.txt";
  if (existsSync(f)) return readFileSync(f, "utf8").split(/\r?\n/)[0].trim();
  const s = randomBytes(24).toString("hex");
  writeFileSync(f, s + "\n");
  return s;
}

if (mode === "env" && arg) {
  const netlifyToken = readFileSync("../NETLIFY-TOKEN.txt", "utf8").split(/\r?\n/)[0].trim();
  const secret = webhookSecret();
  const apiKey = readFileSync("../VPS-KEY.txt", "utf8").split(/\r?\n/)[0].trim();

  const api = async (path, init = {}) => {
    const r = await fetch(`https://api.netlify.com/api/v1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${netlifyToken}`, "content-type": "application/json", ...(init.headers || {}) },
    });
    if (!r.ok) throw new Error(`netlify ${init.method || "GET"} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  const sites = await api("/sites");
  const site = sites.find((s) => s.url?.includes(arg.replace(/^https?:\/\//, "").replace(/\/$/, "")) || s.name === arg);
  if (!site) throw new Error(`no site matched ${arg}`);
  const env = { ...(site.env ?? {}) };
  env.FREESTYLE_API_KEY = apiKey;
  env.TELEGRAM_SECRET = secret;
  await api(`/sites/${site.id}`, { method: "PATCH", body: JSON.stringify({ env }) });
  console.log(`site: ${site.name} (${site.url})`);
  console.log(`env set: FREESTYLE_API_KEY + TELEGRAM_SECRET`);
  console.log(`ear url: ${site.url}/.netlify/functions/ear`);
}

if (mode === "switch" && arg) {
  const site = arg.replace(/\/$/, "");
  const ear = `${site}/.netlify/functions/ear`;
  const set = await (
    await fetch(`${TG}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: ear,
        secret_token: webhookSecret(),
        allowed_updates: ["message", "channel_post"],
        drop_pending_updates: false,
      }),
    })
  ).json();
  if (!set.ok) throw new Error(`setWebhook failed: ${JSON.stringify(set)}`);
  console.log(`webhook -> ${ear}`);

  const info = await (await fetch(`${TG}/getWebhookInfo`)).json();
  console.log(`webhook info: url=${info.result.url} pending=${info.result.pending_update_count} last_error=${info.result.last_error_message || "none"}`);

  await sh(`sudo systemctl disable --now shopee-brain && echo unit-stopped`);
  const ps = await sh("ps -eo pid,args | grep 'node bot/bot.mjs' | grep -v grep || true");
  console.log(`polling brain: ${ps.stdout.trim() || "none (good — the ear is the only listener now)"}`);
  console.log("SWITCH-DONE — paste one number in Telegram to verify");
}

if (mode === "rollback") {
  const del = await (await fetch(`${TG}/deleteWebhook`)).json();
  console.log(`deleteWebhook: ${del.ok ? "ok" : JSON.stringify(del)}`);
  await sh(`sudo systemctl enable --now shopee-brain && sleep 3 && systemctl is-active shopee-brain`);
  const ps = await sh("ps -eo pid,ppid,args | grep 'node bot/bot.mjs' | grep -v grep");
  console.log(`polling brain back: ${ps.stdout.trim()}`);
  console.log("ROLLBACK-DONE — polling mode again");
}

if (!["env", "switch", "rollback"].includes(mode)) {
  console.log("usage: node netlify-ear.mjs env <site-url> | switch <site-url> | rollback");
}
