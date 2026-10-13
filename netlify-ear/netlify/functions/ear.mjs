// ear.mjs — the doorbell (Phase 6).
//
// Telegram posts every message here. One call wakes the tracker VM, hands the
// message to bot.mjs in --once mode, and answers Telegram:
//   bot exits 0   -> 200  (Telegram acks it, no retry)
//   bot exits !=0 -> 500  (Telegram retries the same update for up to 24 h)
// The bot dedupes repeat deliveries, so a retry can never double-book an order.
//
// Zero dependencies: it talks to the Freestyle REST API with plain fetch, so the
// site deploys by drag-and-drop with no build step.
//
// Env vars (Netlify UI or API):
//   FREESTYLE_API_KEY   — VM API key
//   TELEGRAM_SECRET     — must match the secret_token set on the Telegram webhook

const API = "https://api.freestyle.sh";
const VM_ID = "vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309";
const ROOT = "/home/ubuntu/shopeefood-tracker";
const NODE = "/usr/local/bin/node";

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default async (req) => {
  if (req.method !== "POST") return json(200, { ok: true, note: "doorbell idle" });

  const key = process.env.FREESTYLE_API_KEY;
  const secret = process.env.TELEGRAM_SECRET;
  if (!key) return json(500, { ok: false, error: "FREESTYLE_API_KEY missing" });

  // Only Telegram may ring: the webhook is set with a secret_token, and Telegram
  // echoes it in this header. Anyone else gets 403 and wakes nothing.
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return json(403, { ok: false, error: "forbidden" });
  }

  let update;
  try {
    update = await req.json();
  } catch {
    return json(400, { ok: false, error: "bad json" });
  }
  if (!update?.update_id) return json(200, { ok: true, note: "nothing to do" });

  // base64 so quotes/newlines/emoji in the payload survive the shell unchanged
  const payload = Buffer.from(JSON.stringify(update), "utf8").toString("base64");
  const command = `cd ${ROOT} && echo '${payload}' | base64 -d | ${NODE} bot/bot.mjs --once`;

  let res;
  try {
    res = await fetch(`${API}/v5/vms/${VM_ID}/exec-await`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ command, timeoutMs: 55000 }),
    });
  } catch (e) {
    return json(500, { ok: false, error: `freestyle unreachable: ${e.message}` });
  }

  if (!res.ok) {
    const t = await res.text();
    return json(500, { ok: false, error: `freestyle ${res.status}`, detail: t.slice(0, 200) });
  }

  const out = await res.json();
  if (out.statusCode === 0) return json(200, { ok: true, update_id: update.update_id });
  // statusCode null = the command was killed by its timeout — still a retry
  return json(500, {
    ok: false,
    statusCode: out.statusCode,
    stderr: (out.stderr || "").slice(0, 200),
  });
};
