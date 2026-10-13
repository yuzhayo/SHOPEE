// ShopeeFood Order Tracker — brain.
//
// Model (approved turn 35):
//   bare number ................ = CHECK  (no writes: no count, no dates, no log row)
//   screenshot + number, new .... = ORDER  (recorded once: count, event, log row)
//   screenshot, already in DB ... = CHECK  (duplicate; file still saved)
//   unknown + bare number ....... = "not in database yet" (no record created)
//   banned anywhere ............. = ban block; new orders still logged
//
// Reply rules (approved turn 35): verdict first · phone once (the pairing proof,
// replaces the old matched: header) · facts second · history when it exists ·
// no line repeats another line.
//
// Sheet = two tabs: customers (status/ban_reason = Jack's editable cells,
// pull BEFORE verdict, baseline compare = his edits always win) + orders
// (append-only log: every order = one row, script-side dedupe).
//
// Zero dependencies (Node 24 global fetch). Runs on the Freestyle VM.
//
// Two modes (turn 39):
//   (no flag)      polling — dev/interim: deleteWebhook + getUpdates loop
//   --once         production (the "ear" wakes the VM per message): reads ONE
//                  Telegram update as JSON on stdin, answers it, exits.
//                  exit 0 = handled (ear acks Telegram) · exit 1 = failed (retry)
//                  Never touches the webhook or the offset — the webhook IS the queue.
// Test seams (never set on the VM): TRACKER_ROOT, TG_API_BASE, TRACKER_FAKE_OCR.
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

// Overridable root + Telegram base: the local harness points both at a sandbox +
// a stub server, so tests run this exact file with zero network and zero quota.
const ROOT = process.env.TRACKER_ROOT || "/home/ubuntu/shopeefood-tracker";
const TG_BASE = process.env.TG_API_BASE || "https://api.telegram.org";
const TOKEN = readFileSync(`${ROOT}/config/bot-token.txt`, "utf8").trim();
const API = `${TG_BASE}/bot${TOKEN}`;
const LOG = `${ROOT}/logs/bot.log`;
const OFFSET_FILE = `${ROOT}/notebook/offset.txt`;
const SEEN_FILE = `${ROOT}/notebook/seen-updates.txt`;
const HISTORY = `${ROOT}/notebook/history.tsv`;
const STORE = `${ROOT}/notebook/customers.json`;
const startedAt = Date.now();

const SHEET_URL = (() => {
  try { return readFileSync(`${ROOT}/config/sheet-url.txt`, "utf8").trim(); } catch { return ""; }
})();
const SHEET_TOKEN = (() => {
  try { return readFileSync(`${ROOT}/config/sheet-token.txt`, "utf8").trim(); } catch { return ""; }
})();

mkdirSync(`${ROOT}/logs`, { recursive: true });
mkdirSync(`${ROOT}/notebook`, { recursive: true });

// ---- internal audit TSV: time phone action verdict orders order_no order_id screenshot chat
const HIST_HEADER = "time\tphone\taction\tverdict\torders\torder_no\torder_id\tscreenshot\tchat";
try {
  if (readFileSync(HISTORY, "utf8").split("\n")[0] !== HIST_HEADER) {
    renameSync(HISTORY, HISTORY + ".old");
    writeFileSync(HISTORY, HIST_HEADER + "\n");
  }
} catch {
  writeFileSync(HISTORY, HIST_HEADER + "\n");
}

// ---- memory: phone -> {first, last, banned, banReason, banDate, events[], pushedStatus, pushedReason}
// events[] = the orders (source of the count); pushed* = what we last wrote to the Sheet
// (anything else in status/ban_reason cells = Jack's edit -> wins).
let customers = new Map();
try {
  customers = new Map(Object.entries(JSON.parse(readFileSync(STORE, "utf8"))));
} catch {
  // first boot: empty store
}
for (const rec of customers.values()) {
  if (!Array.isArray(rec.events)) rec.events = [];
  // dedupe events: same order id (or same order no) = one order
  const seen = new Set();
  rec.events = rec.events.filter((e) => {
    const k = e.id || (e.no ? `#${e.no}` : `t${e.ts}`);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  delete rec.orders; // v1 counter retired — orders = events.length
  delete rec.dirty;  // dirty retired — baseline compare instead
  if (typeof rec.pushedStatus !== "string") {
    rec.pushedStatus = rec.banned ? "banned" : "not banned";
    rec.pushedReason = rec.banned ? rec.banReason || "" : "";
  }
}
saveStore();

function saveStore() {
  const tmp = STORE + ".tmp";
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(customers), null, 1));
  renameSync(tmp, STORE); // atomic — crash can't tear the file
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  appendFileSync(LOG, line + "\n");
  console.log(line);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Belt: a transient network error must log, never silently kill the brain.
process.on("unhandledRejection", (e) => {
  log(`unhandled rejection: ${e?.message ?? e}`);
});

// ---- dates: displayed in WIB (UTC+7) ----
function dWIB(ts) {
  return new Date(ts + 7 * 3600e3);
}
function fmtDate(ts) {
  return dWIB(ts).toISOString().slice(0, 10);
}
function fmtShort(ts) {
  const d = dWIB(ts);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const s = `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === new Date().getFullYear() ? s : `${s} ${d.getUTCFullYear()}`;
}
function wibStamp(ts) {
  return dWIB(ts).toISOString().slice(0, 16).replace("T", " ");
}

// Guardrail: everything becomes 628XXXXXXXXXX or nothing.
function normalizePhone(text) {
  const m = text.match(/(?:\+|00)?\d[\d\s\-()]{7,20}\d/);
  if (!m) return null;
  let d = m[0].replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "62" + d.slice(1);
  else if (d.startsWith("8")) d = "62" + d;
  if (!/^628\d{8,12}$/.test(d)) return null;
  return d;
}

function stateOf(rec) {
  if (!rec) return "unknown";
  if (rec.banned) return "banned";
  return rec.events.length ? "returning" : "new";
}

function evStr(e) {
  return e.no && e.id ? `#${e.no} ${e.id}` : e.no ? `#${e.no}` : e.id || "";
}
function eventLines(phone) {
  const rec = customers.get(phone);
  return (rec?.events ?? []).map(evStr).filter(Boolean);
}

// Already recorded? Order ID wins; fallback order no. Nothing readable -> not a dup.
function findOrder(rec, ocr) {
  if (!ocr) return false;
  if (ocr.id) return rec.events.some((e) => e.id === ocr.id);
  if (ocr.no) return rec.events.some((e) => e.no === ocr.no);
  return false;
}

// P5: which phone does this order already belong to, if any (mis-paste guard)?
function findOrderOwner(ocr) {
  if (!ocr || (!ocr.id && !ocr.no)) return null;
  for (const [ph, r] of customers) {
    const hit = ocr.id ? r.events.some((e) => e.id === ocr.id) : r.events.some((e) => e.no === ocr.no);
    if (hit) return ph;
  }
  return null;
}

// ---- screenshot: always saved (record what Jack sent) ----
async function savePhoto(fileId, phone) {
  try {
    const g = await (await fetch(`${API}/getFile?file_id=${fileId}`)).json();
    if (!g.ok) {
      log(`getFile failed: ${JSON.stringify(g)}`);
      return "";
    }
    const buf = Buffer.from(
      await (await fetch(`${TG_BASE}/file/bot${TOKEN}/${g.result.file_path}`)).arrayBuffer()
    );
    // P11: folder day = WIB, same clock as the replies (UTC put the 00:00-07:00
    // WIB pastes into yesterday's folder)
    const day = dWIB(Date.now()).toISOString().slice(0, 10);
    const dir = `${ROOT}/notebook/screenshots/${day}`;
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}_${phone || "nophone"}.jpg`;
    writeFileSync(`${dir}/${name}`, buf);
    log(`screenshot saved: ${day}/${name} (${buf.length} bytes)`);
    return `${day}/${name}`;
  } catch (e) {
    log(`savePhoto error: ${e.message}`);
    return "";
  }
}

// ---- OCR: order # + Order ID from a saved screenshot (tesseract, offline, free) ----
async function ocrOrder(absPath) {
  // test seam: the local dev box has no tesseract, so the harness injects the
  // read the bot would have made. Never set on the VM (see RUNBOOK).
  if (process.env.TRACKER_FAKE_OCR) {
    try { return JSON.parse(process.env.TRACKER_FAKE_OCR); } catch { return { no: "", id: "" }; }
  }
  try {
    const { stdout } = await pExecFile("tesseract", [absPath, "stdout", "--psm", "6"], { timeout: 20000 });
    const no = (stdout.match(/#(\d{1,7})\b/) || [])[1] || "";
    const id =
      (stdout.match(/Order[\s\S]{0,12}?(\d{14,20})/) || stdout.match(/(\d{14,20})/) || [])[1] || "";
    return { no, id };
  } catch (e) {
    log(`ocr failed: ${e.message}`);
    return { no: "", id: "" };
  }
}

// ---- replies (approved templates) ----
function buildReply(phone, rec, { action, dup, wasKnown, newEvent, shot }) {
  if (!rec) return `🆕 ${phone} — not in database yet`;

  if (rec.banned) {
    let t =
      `⛔ ${phone} — banned ${fmtShort(rec.banDate)}\n` +
      `reason: ${rec.banReason || "no reason given"}\n` +
      `cancel this order yourself.`;
    if (action === "order" && newEvent) t += `\norder logged: ${evStr(newEvent)}`;
    return t;
  }

  const n = rec.events.length;
  const emoji = wasKnown ? "✅" : "🆕";
  const state = wasKnown ? "returning" : "new customer";
  const suffix =
    action === "order" ? " · order logged" : dup ? " · order already recorded" : "";
  const facts =
    n <= 1
      ? `orders: ${n} · first & last: ${fmtShort(rec.first)}`
      : `orders: ${n} · last: ${fmtShort(rec.last)} · first: ${fmtShort(rec.first)}`;

  let t = `${emoji} ${phone} — ${state}${suffix}\n${facts}`;
  const hist = eventLines(phone);
  if (hist.length) t += `\nhistory:\n${hist.join("\n")}`;
  if (action === "order" && shot) t += `\n📸 saved: ${shot}`;
  return t;
}

function record(fields) {
  appendFileSync(HISTORY, fields.map((f) => String(f ?? "")).join("\t") + "\n");
}

// P8: a verdict that never arrives is the worst failure (the order may already be
// booked), so: one retry with backoff, on network errors and retryable API errors.
async function send(chatId, text, attempt = 0) {
  try {
    const r = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const j = await r.json();
    if (j.ok) return true;
    const retryable =
      !!j.parameters?.retry_after || /retry|too many|timeout|terminated|failed/i.test(j.description || "");
    if (attempt === 0 && retryable) {
      const wait = (j.parameters?.retry_after ?? 2) * 1000 + 500;
      log(`sendMessage refused (${j.description}) -> retry in ${wait}ms`);
      await sleep(wait);
      return send(chatId, text, attempt + 1);
    }
    log(`sendMessage failed: ${JSON.stringify(j)}`);
    return false;
  } catch (e) {
    if (attempt === 0) {
      log(`sendMessage error (${e.message}) -> retry in 2000ms`);
      await sleep(2000);
      return send(chatId, text, attempt + 1);
    }
    log(`sendMessage error (retry exhausted): ${e.message}`);
    return false;
  }
}

// ---- Sheet: PULL first (Jack's cells win vs our last push) ----
async function sheetPull() {
  if (!SHEET_URL || !SHEET_TOKEN) return false;
  try {
    const g = await fetch(`${SHEET_URL}?token=${encodeURIComponent(SHEET_TOKEN)}`);
    const txt = await g.text();
    if (!txt.trim().startsWith("{")) {
      log(`sheet pull unavailable: ${txt.trim().slice(0, 60)}`);
      return false;
    }
    const { rows } = JSON.parse(txt);
    let changed = false;
    for (const r of rows) {
      const phone = normalizePhone(String(r.phone ?? ""));
      if (!phone) continue;
      let rec = customers.get(phone);
      const sStatus =
        String(r.status ?? "").trim().toLowerCase() === "banned" ? "banned" : "not banned";
      const sReason = String(r.banReason ?? "").trim();
      // P4: a ban typed into the Sheet must work even for a number the bot never
      // saw (pre-emptive ban). Only a ban may create a record; plain rows may not.
      if (!rec) {
        if (sStatus !== "banned") continue;
        rec = {
          first: Date.now(),
          last: Date.now(),
          banned: false,
          banReason: "",
          banDate: 0,
          events: [],
          pushedStatus: "not banned",
          pushedReason: "",
        };
        customers.set(phone, rec);
        log(`sheet ban created record for unseen ${phone}`);
      }
      if (sStatus !== rec.pushedStatus || (sStatus === "banned" && sReason !== (rec.pushedReason || ""))) {
        const wantsBan = sStatus === "banned";
        rec.banned = wantsBan;
        rec.banReason = wantsBan ? sReason || "no reason given" : "";
        rec.banDate = wantsBan ? Date.now() : 0;
        changed = true;
        log(`sheet edit applied: ${wantsBan ? "BAN" : "UNBAN"} ${phone}${wantsBan ? ` (${rec.banReason})` : ""}`);
      }
    }
    if (changed) saveStore();
    return changed;
  } catch (e) {
    log(`sheet pull failed: ${e.message}`);
    return false;
  }
}

// ---- Sheet: PUSH merged customers + full order log (script dedupes log rows) ----
async function sheetPush() {
  if (!SHEET_URL || !SHEET_TOKEN) return false;
  try {
    const rows = [...customers.entries()].map(([phone, r]) => ({
      phone,
      orders: r.events.length,
      first: fmtDate(r.first),
      last: fmtDate(r.last),
      status: r.banned ? "banned" : "not banned",
      banReason: r.banned ? r.banReason || "" : "",
    }));
    const logRows = [];
    for (const [phone, r] of customers)
      for (const e of r.events)
        logRows.push({
          time: e.ts ? wibStamp(e.ts) : "", // P10: no ts -> empty, never a fresh identity per push
          phone,
          verdict: e.verdict || "-",
          no: e.no || "",
          id: e.id || "",
          shot: e.shot || "",
          chat: e.chat ?? "",
        });
    const res = await fetch(SHEET_URL, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: SHEET_TOKEN, rows, log: logRows }),
    });
    const txt = await res.text();
    const ok = txt.trim().startsWith("ok");
    log(`sheet sync: ${ok ? "ok" : "unexpected: " + txt.slice(0, 60)} (${rows.length} customers, ${logRows.length} orders)`);
    if (ok) {
      for (const r of customers.values()) {
        r.pushedStatus = r.banned ? "banned" : "not banned";
        r.pushedReason = r.banned ? r.banReason || "" : "";
      }
      saveStore();
    }
    return ok;
  } catch (e) {
    log(`sheet sync failed: ${e.message}`);
    return false;
  }
}

// ---- commands ----
function argAfter(cmd, text) {
  return text.replace(new RegExp(`^/${cmd}(?:@\\w+)?\\s*`), "").trim();
}

async function handleBan(chatId, text) {
  const rest = argAfter("ban", text);
  const phone = normalizePhone(rest);
  if (!phone) {
    await send(chatId, "usage: /ban 0857xxxx reason here\nexample: /ban 085790962643 always late");
    return;
  }
  const reason = rest.replace(/^[\d\s\-()+]+/, "").trim() || "no reason given";
  const rec =
    customers.get(phone) ??
    { first: Date.now(), last: Date.now(), banned: false, banReason: "", banDate: 0, events: [], pushedStatus: "not banned", pushedReason: "" };
  rec.banned = true;
  rec.banReason = reason;
  rec.banDate = Date.now();
  customers.set(phone, rec);
  saveStore();
  log(`ban ${phone} (chat ${chatId}): ${reason}`);
  await send(
    chatId,
    `⛔ ${phone} — banned ${fmtShort(rec.banDate)}\nreason: ${reason}\ncancel this order yourself.\norders: ${rec.events.length}`
  );
  await sheetPush();
}

async function handleUnban(chatId, text) {
  const phone = normalizePhone(argAfter("unban", text));
  if (!phone) {
    await send(chatId, "usage: /unban 0857xxxx");
    return;
  }
  const rec = customers.get(phone);
  if (!rec || !rec.banned) {
    await send(chatId, `${phone} — not banned (nothing to undo)`);
    return;
  }
  rec.banned = false;
  rec.banReason = "";
  rec.banDate = 0;
  saveStore();
  log(`unban ${phone} (chat ${chatId})`);
  await send(chatId, `✅ ${phone} unbanned — normal verdicts resume`);
  await sheetPush();
}

async function handleWho(chatId, text) {
  const phone = normalizePhone(argAfter("who", text));
  if (!phone) {
    await send(chatId, "usage: /who 0857xxxx");
    return;
  }
  const rec = customers.get(phone);
  if (!rec) {
    await send(chatId, `🆕 ${phone} — not in database yet`);
    return;
  }
  const n = rec.events.length;
  const lines = [
    rec.banned
      ? `⛔ ${phone} — banned ${fmtShort(rec.banDate)}\nreason: ${rec.banReason || "no reason given"}`
      : `${n ? "✅" : "🆕"} ${phone} — ${n ? "returning" : "new customer"}`,
    n <= 1
      ? `orders: ${n} · first & last: ${fmtShort(rec.first)}`
      : `orders: ${n} · last: ${fmtShort(rec.last)} · first: ${fmtShort(rec.first)}`,
  ];
  const ev = eventLines(phone);
  if (ev.length) lines.push("history:", ...ev);
  await send(chatId, lines.join("\n"));
}

// ---- update handling ----
async function handleUpdate(u) {
  const msg = u.message ?? u.channel_post;
  if (!msg || (msg.from && msg.from.is_bot)) return;
  const chatId = msg.chat.id;
  const text = (msg.text ?? msg.caption ?? "").trim();
  const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo : null;
  if (!text && !photo) return;

  if (/^\/(start|help)\b/.test(text)) {
    await send(
      chatId,
      "ShopeeFood tracker.\n" +
        "bare number = check · screenshot + number = order (recorded once)\n\n" +
        "commands:\n/ban <number> <reason>\n/unban <number>\n/who <number>\n/status"
    );
    return;
  }
  if (/^\/status\b/.test(text)) {
    const up = Math.round((Date.now() - startedAt) / 60000);
    await send(
      chatId,
      `🟢 alive · up ${up} min · memory: ${customers.size} customers · orders: ${[...customers.values()].reduce((a, r) => a + r.events.length, 0)}`
    );
    return;
  }
  if (/^\/ban\b/.test(text)) return handleBan(chatId, text);
  if (/^\/unban\b/.test(text)) return handleUnban(chatId, text);
  if (/^\/who\b/.test(text)) return handleWho(chatId, text);
  if (text.startsWith("/")) return;

  const nowIso = new Date().toISOString();
  const now = Date.now();

  // no number anywhere -> record it, stay silent
  const phone = text ? normalizePhone(text) : null;
  if (!phone) {
    let shot = "";
    if (photo) shot = await savePhoto(photo[photo.length - 1].file_id, null);
    record([nowIso, "", photo ? "SCREENSHOT-ONLY" : "TEXT-NO-NUMBER", "-", 0, "", "", shot, chatId]);
    log(`recorded ${photo ? "screenshot-only" : "text-no-number"} chat ${chatId} (${shot || "no file"})`);
    return;
  }

  // Jack's Sheet edits win on the very next paste — read BEFORE deciding
  await sheetPull();

  let shot = "";
  let ocr = null;
  if (photo) {
    shot = await savePhoto(photo[photo.length - 1].file_id, phone);
    if (shot) ocr = await ocrOrder(`${ROOT}/notebook/screenshots/${shot}`);
  }

  let rec = customers.get(phone);
  const wasKnown = !!rec && rec.events.length > 0;
  let action = "check";
  let dupMatched = false;
  let newEvent = null;

  if (photo) {
    const dup = rec ? findOrder(rec, ocr) : false;
    const owner = dup ? phone : findOrderOwner(ocr); // P5: same order under another number?
    if (owner && owner !== phone) {
      // mis-paste: the order is already booked under the right number -> book nothing
      record([nowIso, phone, "order-wrong-number", "-", 0, ocr?.no ?? "", ocr?.id ?? "", shot, chatId]);
      log(`wrong-number order ${phone} #${ocr?.no || "?"} ${ocr?.id || "(no id)"} -> belongs to ${owner}`);
      await send(
        chatId,
        `⚠️ ${phone} — order ${evStr(ocr)} already recorded under ${owner}\nwrong number? nothing was recorded for ${phone}.`
      );
      await sheetPush();
      return;
    }
    if (dup) {
      dupMatched = true;
      log(`dup order ${phone} #${ocr?.no || "?"} ${ocr?.id || "(no id)"} -> check`);
    } else {
      action = "order";
      if (!rec) {
        rec = {
          first: now,
          last: now,
          banned: false,
          banReason: "",
          banDate: 0,
          events: [],
          pushedStatus: "not banned",
          pushedReason: "",
        };
        customers.set(phone, rec);
      }
      const verdictNow = rec.banned ? "banned" : wasKnown ? "returning" : "new";
      newEvent = { no: ocr?.no || "", id: ocr?.id || "", ts: now, shot, chat: chatId, verdict: verdictNow };
      rec.events.push(newEvent);
      rec.last = now;
      saveStore();
      log(`order recorded ${phone} #${newEvent.no || "?"} ${newEvent.id || "(no id)"} -> ${verdictNow}`);
    }
  }

  const reply = buildReply(phone, rec, { action, dup: dupMatched, wasKnown, newEvent, shot });
  const audit = dupMatched ? "check-dup" : action;
  // P13: the TSV logs the verdict AT THE MOMENT (the Sheet log row does too);
  // reading the state after the write would say "returning" for a first order.
  const tsvVerdict = newEvent?.verdict ?? stateOf(rec);
  record([
    nowIso,
    phone,
    audit,
    tsvVerdict,
    rec ? rec.events.length : 0,
    ocr?.no ?? "",
    ocr?.id ?? "",
    shot,
    chatId,
  ]);
  log(`reply ${audit}/${tsvVerdict} ${phone} -> chat ${chatId}`);
  await send(chatId, reply);

  // push EVERY cycle: checks included, so the orders log backfills and edits stay fresh
  await sheetPush();
}

// ---- main loop (dev mode: long polling; production switch = Phase 6) ----
let offset = 0;
try {
  offset = Number(readFileSync(OFFSET_FILE, "utf8")) || 0;
} catch {
  // first boot
}

async function main() {
  try {
    await fetch(`${API}/deleteWebhook`, { method: "POST" });
  } catch (e) {
    log(`deleteWebhook failed (continuing): ${e.message}`);
  }
  log(`brain started, offset=${offset}, polling...`);
  (async () => {
    await sheetPull();
    await sheetPush();
  })();
  for (;;) {
    try {
      const r = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`, {
        signal: AbortSignal.timeout(40000),
      });
      const j = await r.json();
      if (!j.ok) {
        log(`poll error: ${JSON.stringify(j)}`);
        await sleep(3000);
        continue;
      }
      for (const u of j.result) {
        offset = u.update_id + 1;
        try {
          await handleUpdate(u);
        } catch (e) {
          log(`handle error: ${e.message}`);
        }
        writeFileSync(OFFSET_FILE, String(offset));
      }
    } catch (e) {
      log(`poll exception: ${e.message}`);
      await sleep(3000);
    }
  }
}

// ---- modes ----
// polling (no flag): dev/interim — deleteWebhook + getUpdates loop.
// --once (production): one Telegram update on stdin, answer, exit.
const STALE_SECONDS = 900; // never answer a paste that sat in Telegram for hours

// Exit cleanly: set the code, let stdout flush, then leave. Exiting mid-write
// truncates the last log line (Linux) and aborts libuv outright (Windows).
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 100).unref();
}

function seenIds() {
  try { return readFileSync(SEEN_FILE, "utf8").trim().split("\n").filter(Boolean); } catch { return []; }
}
function wasSeen(id) {
  return seenIds().includes(String(id));
}
function markSeen(id) {
  const ids = seenIds();
  ids.push(String(id));
  writeFileSync(SEEN_FILE, ids.slice(-500).join("\n") + "\n"); // bounded memory
}

async function runOnce() {
  let u;
  try {
    u = JSON.parse(readFileSync(0, "utf8")); // stdin = the update, straight from the ear
  } catch (e) {
    log(`--once: bad json on stdin: ${e.message}`);
    finish(1);
    return;
  }
  const msg = u?.message ?? u?.channel_post;
  if (!msg || !u.update_id) return finish(0); // nothing to answer — ack it
  if (wasSeen(u.update_id)) {
    log(`--once: update ${u.update_id} already handled -> acked`);
    return finish(0);
  }
  const ageSec = Math.round(Date.now() / 1000 - (msg.date ?? 0));
  if (msg.date && ageSec > STALE_SECONDS) {
    log(`--once: stale update ${u.update_id} (${Math.round(ageSec / 60)} min old) -> acked, not answered`);
    return finish(0);
  }
  try {
    await handleUpdate(u);
    markSeen(u.update_id);
    finish(0); // handled -> the ear acks Telegram
  } catch (e) {
    log(`--once: handle failed: ${e.message}`);
    finish(1); // failed -> the ear asks Telegram to retry
  }
}

const MODE = process.argv.includes("--once") ? "once" : "poll";
if (MODE === "once") await runOnce();
else await main();
