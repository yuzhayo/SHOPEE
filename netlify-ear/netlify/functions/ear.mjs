// ear.mjs — the doorbell (Phase 6) — v3.5 ACK-FIRST
// Ack-first contract: validate -> launch the VM exec detached (202) -> 200 to
// Telegram immediately. The bot's reply goes via sendMessage from the VM, so
// the ear never waits for OCR/Sheet. 500 ONLY when the launch itself failed
// (then Telegram retrying later is correct — nothing ran yet).

const API = process.env.FREESTYLE_API || "https://api.freestyle.sh";
const VM_ID = process.env.VM_ID || "vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309";
const ROOT = process.env.TRACKER_ROOT || "/home/ubuntu/shopeefood-tracker";
const NODE = process.env.TRACKER_NODE || "/usr/local/bin/node";

const EXEC_TIMEOUT_MS = 60000; // server-side budget: the VM run finishes on its own, we don't wait for it
const FETCH_TIMEOUT_MS = 10000; // just long enough to get the launch confirmation (202 Accepted)
const BACKGROUND_AFTER_SECS = 3; // ask the API to detach the exec from our connection after 3s
const MAX_BODY_BYTES = 20000;

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
  if (!secret) return json(500, { ok: false, error: "TELEGRAM_SECRET not configured" });
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return json(403, { ok: false, error: "forbidden" });
  }

  let text;
  try {
    text = await req.text();
  } catch {
    return json(400, { ok: false, error: "bad body" });
  }
  if (text.length > MAX_BODY_BYTES) return json(413, { ok: false, error: "payload too large" });
  if (text.length === 0) return json(200, { ok: true, note: "empty" });

  let update;
  try {
    update = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: "bad json" });
  }
  if (!update?.update_id || typeof update.update_id !== "number") return json(200, { ok: true, note: "nothing to do" });

  const payload = Buffer.from(JSON.stringify(update), "utf8").toString("base64");
  const command = `cd ${ROOT} && echo '${payload}' | base64 -d | ${NODE} bot/bot.mjs --once`;

  let res;
  try {
    res = await fetch(`${API}/v5/vms/${VM_ID}/exec-await`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        // Detach the exec from this connection: the API keeps running it
        // server-side (cold boot, OCR, Sheet sync) and answers 202 now.
        // We ack Telegram immediately, so it never retries into a dup storm.
        "x-freestyle-background-after-secs": String(BACKGROUND_AFTER_SECS),
      },
      body: JSON.stringify({ command, timeoutMs: EXEC_TIMEOUT_MS }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return json(500, { ok: false, error: `freestyle unreachable: ${e.message}` });
  }

  // 202 = launch confirmed, work detached and running on the VM.
  // Ack Telegram NOW (200) — the bot's own reply goes via sendMessage later.
  if (res.status === 202) return json(200, { ok: true, accepted: true, update_id: update.update_id });

  if (!res.ok) {
    const t = await res.text();
    return json(500, { ok: false, error: `freestyle ${res.status}`, detail: t.slice(0, 200) });
  }

  const out = await res.json();
  if (out.statusCode === 0) return json(200, { ok: true, update_id: update.update_id });
  return json(500, { ok: false, statusCode: out.statusCode, stderr: (out.stderr || "").slice(0, 200) });
};