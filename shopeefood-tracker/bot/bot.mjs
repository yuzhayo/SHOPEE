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

// ---- OCR: order # + Order ID + driver + customer from a saved screenshot ----
async function ocrOrder(absPath) {
  // test seam: the local dev box has no tesseract, so the harness injects the
  // read the bot would have made. Never set on the VM (see RUNBOOK).
  if (process.env.TRACKER_FAKE_OCR) {
    try {
      const o = JSON.parse(process.env.TRACKER_FAKE_OCR);
      return {
        no: o.no || "", id: o.id || "", driver: o.driver || "",
        customer: o.customer || "", shopee: o.shopee !== false,
      };
    } catch { return { no: "", id: "", driver: "", customer: "", shopee: true }; }
  }
  const blank = { no: "", id: "", driver: "", customer: "", shopee: false };
  let stdout = "";
  try {
    ({ stdout } = await pExecFile("tesseract", [absPath, "stdout", "--psm", "6"], { timeout: 20000 }));
  } catch (e) {
    log(`ocr failed: ${e.message}`);
    return blank;
  }
  const no = (stdout.match(/#(\d{1,7})\b/) || [])[1] || "";
  const id =
    (stdout.match(/Order[\s\S]{0,12}?(\d{14,20})/) || stdout.match(/(\d{14,20})/) || [])[1] || "";
  // names sit after their labels ("Driver - RAHMAT FADLI", "Pelanggan - Nadya").
  // Validity never depends on them, so a missed name only blanks a line, never rejects.
  const nameAfter = (label) => {
    const m = stdout.match(new RegExp(`${label}\\s*[-\u2013\u2014:\u00b7.]\\s*([A-Za-z][A-Za-z .']{1,29})`, "i"));
    if (!m) return "";
    return m[1]
      .replace(/\s+(Pelanggan|Driver|Order|Total|Rincian|Informasi|Waktu|Tanggal).*$/i, "")
      .replace(/[^A-Za-z]+$/, "").trim();
  };
  const shopee = /(shopee|rincian\s*pesanan|order\s*id|pengiriman|pesanan\s*siap)/i.test(stdout);
  return { no, id, driver: nameAfter("Driver"), customer: nameAfter("Pelanggan"), shopee };
}

// ---- replies: Jack's templates T1-T13 (turn 47). Banned always carries history
// (a banned order is still logged, so there is always something to show) ----
function histOf(phone) {
  return eventLines(phone);
}
function buildReply(phone, rec, { kind, newEvent, owner, ocr, nohint }) {
  const hist = histOf(rec ? phone : owner || phone);
  const histBlock = hist.length ? `\nhistory:\n${hist.join("\n")}` : "";
  switch (kind) {
    case "new": // T1 — first order from a new customer (no history: this IS the first)
      return (
        `🆕 ${phone} — NEW CUSTOMER\norder logged\n` +
        `order number: #${newEvent.no}\norder ID: ${newEvent.id}` +
        (newEvent.driver ? `\ndriver: ${newEvent.driver}` : "") +
        (newEvent.customer ? `\ncustomer: ${newEvent.customer}` : "")
      );
    case "returning": // T2
      return (
        `✅ ${phone} — RETURNING\norder logged\n` +
        `order: #${newEvent.no}\norder ID: ${newEvent.id}` +
        (newEvent.driver ? `\ndriver: ${newEvent.driver}` : "") +
        (newEvent.customer ? `\ncustomer: ${newEvent.customer}` : "") +
        histBlock
      );
    case "dup": // T3 — keys match this customer's own record
      return `✅ ${phone} — CHECKING\norder already recorded\norder: #${ocr.no}\norder ID: ${ocr.id}${histBlock}`;
    case "wrong-owner": // T4 — keys belong to another number
      return (
        `⚠️ ${phone} — CHECKING\n` +
        `order #${ocr.no} ${ocr.id} already recorded under ${owner}\n` +
        `wrong number? nothing was recorded for ${phone}.`
      );
    case "check": { // T5 — plain history lookup (number-only, cell-11 hit, shot-only hit)
      const who = rec ? phone : owner || phone; // shot-only lookup speaks as the owner
      const ohist = histOf(who);
      const oblock = ohist.length ? `\nhistory:\n${ohist.join("\n")}` : "";
      if (!rec || !rec.events.length) {
        if (!rec) return `✅ ${who} — CHECKING${oblock}`;
        return `🆕 ${phone} — CHECKING\nno orders yet.`;
      }
      return `✅ ${phone} — CHECKING${oblock}`;
    }
    case "norecord": // T6
      return `🔍 ${phone} — NO RECORD\nnot in database.`;
    case "rejected": // T7 — Shopee shot, keys unreadable
      return `⚠️ ${phone} — REJECTED\ncriteria not met in screenshot. resend a clear screenshot + number.`;
    case "rejected-nokey": // T8 — shot alone, Shopee-looking, no keys
      return `⚠️ REJECTED — unable to read order number.\nresend a clear screenshot (NUMBER + SCREENSHOT for a new record).`;
    case "notshopee": // T9
      return `NOT SHOPEE — nothing recorded.`;
    case "nodata": { // T10 — keys not in database (shot-only miss, cell-11 miss)
      const keys = ocr && (ocr.no || ocr.id) ? `order ${evStr(ocr)} ` : "";
      return `⚠️ NO DATA — ${keys}not in database.` +
        (nohint ? "" : "\nto make a new record send NUMBER + SCREENSHOT.");
    }
    case "banned-order": { // T11 — banned, new order still logged
      const ev = newEvent ? `\norder logged\norder: #${newEvent.no}\norder ID: ${newEvent.id}` +
        (newEvent.driver ? `\ndriver: ${newEvent.driver}` : "") +
        (newEvent.customer ? `\ncustomer: ${newEvent.customer}` : "") : "";
      return `⛔ ${phone} — BANNED\nreason: ${rec.banReason || "no reason given"}\ncancel this order yourself.${ev}${histBlock}`;
    }
    case "banned-check": // T12 — banned, lookup only
      return `⛔ ${phone} — BANNED\nreason: ${rec.banReason || "no reason given"}\ncancel this order yourself.${histBlock}`;
    default:
      return `🔍 ${phone} — NO RECORD\nnot in database.`;
  }
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
          driver: e.driver || "",
          customer: e.customer || "",
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
  const hist = eventLines(phone);
  await send(
    chatId,
    `⛔ ${phone} — BANNED\nreason: ${reason}\ncancel this order yourself.` +
      (hist.length ? `\nhistory:\n${hist.join("\n")}` : "")
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
        "number = check · number + screenshot = record order · screenshot alone = lookup\n\n" +
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

  // Jack's Sheet edits win on the very next paste — read BEFORE deciding
  await sheetPull();

  const phone = text ? normalizePhone(text) : null;

  // every photo is saved: what Jack sent is evidence, even rejects
  let shot = "";
  let ocr = { no: "", id: "", driver: "", customer: "", shopee: false };
  if (photo) {
    shot = await savePhoto(photo[photo.length - 1].file_id, phone);
    if (shot) ocr = await ocrOrder(`${ROOT}/notebook/screenshots/${shot}`);
  }
  // validity = order ID + order number readable (+ phone, handled by branch).
  // Driver / customer names never block: a missed name blanks a line, never rejects.
  const keys = !!(ocr.id && ocr.no);

  const done = async (action, verdict, reply, rec) => {
    record([nowIso, phone || "", action, verdict,
      rec ? rec.events.length : 0, ocr.no || "", ocr.id || "", shot, chatId]);
    log(`reply ${action}/${verdict} ${phone || "(no number)"} -> chat ${chatId}`);
    await send(chatId, reply);
    await sheetPush();
  };

  // ---------- no number in the message ----------
  if (!phone) {
    if (!photo) {
      // random chatter: note it, stay silent (matrix cell 4, unruled — kept as today)
      record([nowIso, "", "TEXT-NO-NUMBER", "-", 0, "", "", "", chatId]);
      log(`recorded text-no-number chat ${chatId}`);
      return;
    }
    if (keys) {
      // shot-only lookup: hit -> CHECKING + owner's history, miss -> NO DATA + hint
      const owner = findOrderOwner(ocr);
      if (owner) {
        const orec = customers.get(owner);
        const kind = orec.banned ? "banned-check" : "check";
        return done("check-lookup", orec.banned ? "banned" : "checking",
          buildReply("", orec.banned ? orec : null, { kind, owner, ocr }), orec);
      }
      return done("nodata", "nodata", buildReply("", null, { kind: "nodata", ocr }));
    }
    if (ocr.shopee) return done("rejected-nokey", "rejected", buildReply("", null, { kind: "rejected-nokey" }));
    return done("not-shopee", "not-shopee", buildReply("", null, { kind: "notshopee" }));
  }

  // ---------- number, no photo: pure lookup ----------
  let rec = customers.get(phone);
  if (!photo) {
    if (!rec) return done("check-norecord", "norecord", buildReply(phone, null, { kind: "norecord" }));
    if (rec.banned) return done("check", "banned", buildReply(phone, rec, { kind: "banned-check" }), rec);
    return done("check", "checking", buildReply(phone, rec, { kind: "check" }), rec);
  }

  // ---------- number + photo, but not a Shopee order: ignore the picture (cell 11) ----------
  if (!ocr.shopee && !keys)
    if (!rec) return done("nodata", "nodata", buildReply(phone, null, { kind: "nodata", ocr: { no: "", id: "" }, nohint: true }));
    else if (rec.banned) return done("check", "banned", buildReply(phone, rec, { kind: "banned-check" }), rec);
    else return done("check", "checking", buildReply(phone, rec, { kind: "check" }), rec);

  // ---------- number + Shopee shot, keys unreadable: REJECTED ----------
  if (!keys) return done("rejected", "rejected", buildReply(phone, rec, { kind: "rejected" }));

  // ---------- number + valid Shopee keys ----------
  const dup = rec ? findOrder(rec, ocr) : false;
  const owner = dup ? phone : findOrderOwner(ocr); // P5: same order under another number?
  if (owner && owner !== phone)
    // mis-paste: the order is already booked under the right number -> book nothing
    return done("order-wrong-number", "checking", buildReply(phone, null, { kind: "wrong-owner", owner, ocr }));
  if (dup)
    if (rec.banned) return done("check-dup", "banned", buildReply(phone, rec, { kind: "banned-check" }), rec);
    else return done("check-dup", "checking", buildReply(phone, rec, { kind: "dup", ocr }), rec);

  // brand-new order keys: NEW (unknown number) or RETURNING (known), banned still logged
  const wasKnown = !!rec && rec.events.length > 0;
  if (!rec) {
    rec = {
      first: now, last: now, banned: false, banReason: "", banDate: 0,
      events: [], pushedStatus: "not banned", pushedReason: "",
    };
    customers.set(phone, rec);
  }
  const verdictNow = rec.banned ? "banned" : wasKnown ? "returning" : "new";
  const newEvent = {
    no: ocr.no, id: ocr.id, driver: ocr.driver, customer: ocr.customer,
    ts: now, shot, chat: chatId, verdict: verdictNow,
  };
  rec.events.push(newEvent);
  rec.last = now;
  saveStore();
  log(`order recorded ${phone} #${newEvent.no} ${newEvent.id} -> ${verdictNow}`);
  const kind = rec.banned ? "banned-order" : wasKnown ? "returning" : "new";
  return done("order", verdictNow, buildReply(phone, rec, { kind, newEvent }), rec);
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
