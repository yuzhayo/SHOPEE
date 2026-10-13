// tests/bot.test.mjs — local black-box harness for the real bot.mjs.
//
// Spawns bot.mjs as a child process in --once mode against a local stub that
// plays Telegram + the Google Sheet. No network, no VM, no quota, no Jack pasting.
// Covers Jack's turn-47 templates T1-T13: NEW / RETURNING / CHECKING-dup /
// wrong-owner / plain check / NO RECORD / REJECTED x2 / NOT SHOPEE / NO DATA /
// banned-order + banned-check (both WITH history) / /start text, plus driver +
// customer extraction into the store and the Sheet push, plus the standing rails:
// P4 sheet-typed ban · P5 mis-paste guard · P8 reply retry · P10 log identity ·
// P11 WIB screenshot folder · P13 TSV verdict · --once doorbell mode (stale guard,
// seen-id dedupe, exit contract, never touches getUpdates/deleteWebhook).
//
// Run:  node tests/bot.test.mjs        (exit 0 = all green)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT = join(HERE, "..", "bot", "bot.mjs");
const FAKE_OCR = JSON.stringify({ no: "530", id: "3300155108395520491", driver: "RAHMAT FADLI", customer: "Nadya", shopee: true });
const OCR2 = JSON.stringify({ no: "531", id: "3301316233709056913", driver: "BUDI SANTOSO", customer: "Siti", shopee: true });
const OCR_BLURRY = JSON.stringify({ no: "", id: "", driver: "", customer: "", shopee: true });
const OCR_MEME = JSON.stringify({ no: "", id: "", driver: "", customer: "", shopee: false });

let pass = 0, fail = 0;
const check = (name, cond, evidence = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${evidence ? `  [${evidence}]` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${evidence ? `  [${evidence}]` : ""}`); }
};

// ---------- stub: Telegram API + the Sheet's exec endpoint ----------
const hits = [];     // every request seen (proof of what the bot never calls)
const sent = [];     // sendMessage payloads
const pushes = [];   // Sheet POST payloads
let sheetRows = [];  // customers rows the Sheet hands back on GET
let failSends = 0;   // refuse this many sendMessage calls first (P8)

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://stub");
  hits.push(`${req.method} ${url.pathname}`);
  let body = "";
  for await (const c of req) body += c;

  if (url.pathname.endsWith("/sendMessage")) {
    if (failSends > 0) {
      failSends--;
      res.end(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests: retry after 0", parameters: { retry_after: 0 } }));
      return;
    }
    sent.push(JSON.parse(body));
    res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    return;
  }
  if (url.pathname.endsWith("/getFile")) {
    res.end(JSON.stringify({ ok: true, result: { file_path: "photos/test.jpg" } }));
    return;
  }
  if (url.pathname.startsWith("/file/bot")) {
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // tiny fake jpg
    return;
  }
  if (url.pathname === "/exec") {
    if (req.method === "GET") { res.end(JSON.stringify({ rows: sheetRows })); return; }
    const payload = JSON.parse(body);
    pushes.push(payload);
    res.end(`ok deleted:${(payload.delete || []).length}`);
    return;
  }
  res.end(JSON.stringify({ ok: false, description: `unhandled ${req.method} ${url.pathname}` }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- sandbox + child runner ----------
function sandbox(name) {
  const root = mkdtempSync(join(tmpdir(), `tracker-${name}-`));
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(join(root, "notebook"), { recursive: true });
  writeFileSync(join(root, "config", "bot-token.txt"), "TESTTOKEN\n");
  writeFileSync(join(root, "config", "sheet-url.txt"), `${base}/exec\n`);
  writeFileSync(join(root, "config", "sheet-token.txt"), "TESTSHEET\n");
  return root;
}
const checkExit = (r) => check("exit 0", r.code === 0, r.code === 0 ? "" : `code=${r.code}\n${r.out}`);
function runRaw(root, raw, ocr) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BOT, "--once"], {
      env: { ...process.env, TRACKER_ROOT: root, TG_API_BASE: base, TRACKER_FAKE_OCR: ocr || FAKE_OCR },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.stdin.end(raw);
    child.on("close", (code) => resolve({ code, out }));
  });
}
const runOnce = (root, update, ocr) => runRaw(root, JSON.stringify(update), ocr);

let uid = 1000;
const nowUnix = () => Math.floor(Date.now() / 1000);
const textUpdate = (text, over = {}) => ({
  update_id: uid++,
  message: { date: nowUnix(), chat: { id: 555, type: "private" }, text, ...over },
});
const shotUpdate = (caption, over = {}) => ({
  update_id: uid++,
  message: {
    date: nowUnix(), chat: { id: 555, type: "private" }, text: caption,
    photo: [{ file_id: "PH1", file_unique_id: "U1", width: 1, height: 1 }], ...over,
  },
});
const store = (root) => JSON.parse(readFileSync(join(root, "notebook", "customers.json"), "utf8"));
const tsv = (root) => readFileSync(join(root, "notebook", "history.tsv"), "utf8").trim().split("\n");
const lastReply = () => sent[sent.length - 1].text;
const wibDay = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

// ================= S1: bare number, unknown phone -> T6 NO RECORD =================
console.log("S1 bare check of an unknown number");
{
  const root = sandbox("s1");
  sheetRows = []; pushes.length = 0; sent.length = 0;
  const r = await runOnce(root, textUpdate("089999999999"));
  checkExit(r);
  check("T6 exact", lastReply() === "🔍 6289999999999 — NO RECORD\nnot in database.", lastReply().replace(/\n/g, " | "));
  check("no record created", !store(root)["6289999999999"]);
  check("TSV action = check-norecord", tsv(root).at(-1).split("\t")[2] === "check-norecord");
  check("TSV verdict = norecord", tsv(root).at(-1).split("\t")[3] === "norecord");
}

// ================= S2-S5: the customer flow on one sandbox =================
console.log("S2 new order (screenshot + number) -> T1");
const rootA = sandbox("flow");
{
  sheetRows = []; pushes.length = 0; sent.length = 0;
  const r = await runOnce(rootA, shotUpdate("081112223333"));
  const t = lastReply();
  checkExit(r);
  check("T1 exact", t === "🆕 6281112223333 — NEW CUSTOMER\norder logged\norder number: #530\norder ID: 3300155108395520491\ndriver: RAHMAT FADLI\ncustomer: Nadya", t.replace(/\n/g, " | "));
  check("P11 screenshot saved under WIB day", tsv(rootA).at(-1).split("\t")[7].startsWith(wibDay()), tsv(rootA).at(-1).split("\t")[7]);
  const rec = store(rootA)["6281112223333"];
  check("store event keeps driver + customer", rec.events.length === 1 && rec.events[0].driver === "RAHMAT FADLI" && rec.events[0].customer === "Nadya");
  check("P13 TSV verdict = new (at order time)", tsv(rootA).at(-1).split("\t")[3] === "new");
  const lg = pushes.at(-1).log.at(-1);
  check("sheet log row carries driver + customer", lg.verdict === "new" && lg.driver === "RAHMAT FADLI" && lg.customer === "Nadya", JSON.stringify(lg));
}

console.log("S3 same screenshot again = duplicate -> T3");
{
  sent.length = 0;
  const r = await runOnce(rootA, shotUpdate("081112223333"));
  const t = lastReply();
  checkExit(r);
  check("T3 exact", t === "✅ 6281112223333 — CHECKING\norder already recorded\norder: #530\norder ID: 3300155108395520491\nhistory:\n#530 3300155108395520491", t.replace(/\n/g, " | "));
  check("still 1 event (no double count)", store(rootA)["6281112223333"].events.length === 1);
  check("TSV action = check-dup", tsv(rootA).at(-1).split("\t")[2] === "check-dup");
}

console.log("S4 mis-paste: same order under a different number (P5) -> T4");
{
  sent.length = 0;
  const r = await runOnce(rootA, shotUpdate("082223334444"));
  const t = lastReply();
  checkExit(r);
  check("T4 exact", t === "⚠️ 6282223334444 — CHECKING\norder #530 3300155108395520491 already recorded under 6281112223333\nwrong number? nothing was recorded for 6282223334444.", t.replace(/\n/g, " | "));
  check("wrong number recorded nothing", !store(rootA)["6282223334444"]);
  check("TSV action = order-wrong-number", tsv(rootA).at(-1).split("\t")[2] === "order-wrong-number");
}

console.log("S5 second order from the same customer -> T2");
{
  sent.length = 0;
  const r = await runOnce(rootA, shotUpdate("081112223333"), OCR2);
  const t = lastReply();
  checkExit(r);
  check("T2 exact", t === "✅ 6281112223333 — RETURNING\norder logged\norder: #531\norder ID: 3301316233709056913\ndriver: BUDI SANTOSO\ncustomer: Siti\nhistory:\n#530 3300155108395520491\n#531 3301316233709056913", t.replace(/\n/g, " | "));
  check("store has 2 events", store(rootA)["6281112223333"].events.length === 2);
  check("TSV verdict = returning", tsv(rootA).at(-1).split("\t")[3] === "returning");
}

console.log("S6 commands still work");
{
  sent.length = 0;
  await runOnce(rootA, textUpdate("/who 081112223333"));
  check("/who = returning with history", lastReply().startsWith("✅ 6281112223333 — returning") && lastReply().includes("history:"));
  await runOnce(rootA, textUpdate("/start"));
  check("/start = T13 model reminder", lastReply().includes("number + screenshot = record order"));
}

// ================= S7-S8: the Sheet is the remote control =================
console.log("S7 ban typed into the Sheet, number never seen by the bot (P4) -> T12");
{
  sent.length = 0;
  sheetRows = [{ phone: "081234567890", orders: 0, first: "", last: "", status: "banned", banReason: "fraud test" }];
  const r = await runOnce(rootA, textUpdate("081234567890"));
  const t = lastReply();
  checkExit(r);
  check("T12 shape (banned + reason)", t.startsWith("⛔ 6281234567890 — BANNED") && t.includes("reason: fraud test"), t.replace(/\n/g, " | "));
  check("record created from the cell", store(rootA)["6281234567890"]?.banned === true);
}

console.log("S8 unban typed into the Sheet");
{
  sent.length = 0;
  sheetRows = [{ phone: "081234567890", orders: 0, first: "", last: "", status: "not banned", banReason: "" }];
  await runOnce(rootA, textUpdate("081234567890"));
  check("known number, zero orders -> CHECKING + no orders yet", lastReply() === "🆕 6281234567890 — CHECKING\nno orders yet.", lastReply().replace(/\n/g, " | "));
  sheetRows = [];
}

// ================= S9-S11: doorbell-mode safety rails =================
console.log("S9 stale paste (sitting in Telegram for hours) stays unanswered");
{
  sent.length = 0;
  const r = await runOnce(rootA, textUpdate("081112223333", { date: nowUnix() - 7200 }));
  check("exit 0 (acked)", r.code === 0);
  check("no reply sent", sent.length === 0);
  check("logged as stale", r.out.includes("stale update"));
}

console.log("S10 dropped send is retried, not lost (P8)");
{
  sent.length = 0; failSends = 1;
  const r = await runOnce(rootA, textUpdate("081112223333"));
  check("reply still arrived", sent.length === 1, lastReply().split("\n")[0]);
  check("retry was logged", r.out.includes("retry in"));
  failSends = 0;
}

console.log("S11 --once never touches the webhook or the update offset");
{
  check("no deleteWebhook call", !hits.some((h) => h.includes("deleteWebhook")));
  check("no getUpdates call", !hits.some((h) => h.includes("getUpdates")));
  check("no offset file written", !existsSync(join(rootA, "notebook", "offset.txt")));
  check("repeat update is acked, not re-answered", (await runOnce(rootA, { update_id: uid - 3, message: { date: nowUnix(), chat: { id: 555 }, text: "081112223333" } })).out.includes("already handled"));
}

// ================= S12: P10 log identity =================
console.log("S12 an event without a timestamp keeps one stable identity (P10)");
{
  const root = sandbox("p10");
  sheetRows = []; pushes.length = 0;
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "628111111111": {
      first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
      events: [{ no: "7", id: "9999999999999999", chat: 1, verdict: "new" }],
      pushedStatus: "not banned", pushedReason: "",
    },
  }));
  await runOnce(root, textUpdate("081111111111"));
  check("sheet log row time is empty, not a fresh timestamp", pushes.at(-1).log.at(-1).time === "", JSON.stringify(pushes.at(-1).log.at(-1)));
}

// ================= S13: the ear's exit contract =================
console.log("S13 broken input = non-zero exit, so Telegram is asked to retry");
{
  const r = await runRaw(sandbox("bad"), "{not json");
  check("exit 1 on bad stdin", r.code === 1);
  check("logged", r.out.includes("bad json"));
}

// ================= S14: unreadable Shopee shot + number -> T7 REJECTED =================
console.log("S14 blurry screenshot with a number is rejected, never recorded");
{
  const root = sandbox("s14");
  sheetRows = []; sent.length = 0;
  const r = await runOnce(root, shotUpdate("081445556666"), OCR_BLURRY);
  const t = lastReply();
  checkExit(r);
  check("T7 exact", t === "⚠️ 6281445556666 — REJECTED\ncriteria not met in screenshot. resend a clear screenshot + number.", t.replace(/\n/g, " | "));
  check("nothing recorded", !store(root)["6281445556666"]);
  check("TSV action = rejected", tsv(root).at(-1).split("\t")[2] === "rejected");
}

// ================= S15: screenshot with no number =================
console.log("S15a meme without a number -> T9 NOT SHOPEE");
{
  const root = sandbox("s15");
  sheetRows = []; sent.length = 0;
  const r = await runOnce(root, shotUpdate(""), OCR_MEME);
  checkExit(r);
  check("T9 exact", lastReply() === "NOT SHOPEE — nothing recorded.", lastReply());
  check("TSV action = not-shopee", tsv(root).at(-1).split("\t")[2] === "not-shopee");
}
console.log("S15b Shopee shot without a number, keys unreadable -> T8");
{
  const root = sandbox("s15b");
  sheetRows = []; sent.length = 0;
  await runOnce(root, shotUpdate(""), OCR_BLURRY);
  check("T8 exact", lastReply() === "⚠️ REJECTED — unable to read order number.\nresend a clear screenshot (NUMBER + SCREENSHOT for a new record).", lastReply().replace(/\n/g, " | "));
}
console.log("S15c Shopee shot without a number, keys unknown -> T10 NO DATA");
{
  const root = sandbox("s15c");
  sheetRows = []; sent.length = 0;
  await runOnce(root, shotUpdate(""));
  const t = lastReply();
  check("T10 shape", t === "⚠️ NO DATA — order #530 3300155108395520491 not in database.\nto make a new record send NUMBER + SCREENSHOT.", t.replace(/\n/g, " | "));
  check("TSV action = nodata", tsv(root).at(-1).split("\t")[2] === "nodata");
}
console.log("S15d Shopee shot without a number, keys known -> CHECKING + owner history");
{
  const root = sandbox("s15d");
  sheetRows = []; sent.length = 0;
  await runOnce(root, shotUpdate("081778889999")); // registers the order first
  sent.length = 0;
  await runOnce(root, shotUpdate(""));
  const t = lastReply();
  check("speaks as the owner with history", t === "✅ 6281778889999 — CHECKING\nhistory:\n#530 3300155108395520491", t.replace(/\n/g, " | "));
  check("TSV action = check-lookup", tsv(root).at(-1).split("\t")[2] === "check-lookup");
}

// ================= S16: number + non-Shopee shot (cell 11) =================
console.log("S16a known number + meme degrades to a plain check");
{
  const root = sandbox("s16");
  sheetRows = []; sent.length = 0;
  await runOnce(root, shotUpdate("081667778888")); // registers first (default OCR)
  sent.length = 0;
  await runOnce(root, shotUpdate("081667778888"), OCR_MEME);
  const t = lastReply();
  check("T5 with history", t === "✅ 6281667778888 — CHECKING\nhistory:\n#530 3300155108395520491", t.replace(/\n/g, " | "));
  check("no second event", store(root)["6281667778888"].events.length === 1);
}
console.log("S16b unknown number + meme -> plain NO DATA");
{
  const root = sandbox("s16b");
  sheetRows = []; sent.length = 0;
  await runOnce(root, shotUpdate("082009991111"), OCR_MEME);
  check("NO DATA without the hint", lastReply() === "⚠️ NO DATA — not in database.", lastReply().replace(/\n/g, " | "));
}

// ================= S17: banned numbers still log, history always shown =================
console.log("S17a /ban confirmation carries history");
{
  const root = sandbox("s17");
  sheetRows = []; sent.length = 0;
  await runOnce(root, shotUpdate("085556667777")); // one order first
  sent.length = 0;
  await runOnce(root, textUpdate("/ban 085556667777 fake order"));
  const t = lastReply();
  check("ban head + history", t.startsWith("⛔ 6285556667777 — BANNED") && t.includes("reason: fake order") && t.includes("history:\n#530 3300155108395520491"), t.replace(/\n/g, " | "));
}
console.log("S17b banned number sends a valid new order -> T11 still logged, with history");
{
  const root = sandbox("s17b");
  sheetRows = []; sent.length = 0;
  await runOnce(root, textUpdate("/ban 085443332211 late again"));
  sent.length = 0;
  const r = await runOnce(root, shotUpdate("085443332211"));
  const t = lastReply();
  checkExit(r);
  check("T11 shape", t.startsWith("⛔ 6285443332211 — BANNED") && t.includes("order logged") && t.includes("order: #530") && t.includes("driver: RAHMAT FADLI") && t.includes("history:\n#530 3300155108395520491"), t.replace(/\n/g, " | "));
  const rec = store(root)["6285443332211"];
  check("order IS in the store", rec.events.length === 1 && rec.events[0].verdict === "banned");
  check("sheet log verdict = banned", pushes.at(-1).log.at(-1).verdict === "banned");
}
console.log("S17c banned number repeats the order -> T12 with history");
{
  const root = sandbox("s17c");
  sheetRows = []; sent.length = 0;
  await runOnce(root, shotUpdate("084332221100"));
  await runOnce(root, textUpdate("/ban 084332221100 no show"));
  sent.length = 0;
  await runOnce(root, shotUpdate("084332221100"));
  const t = lastReply();
  check("T12 shape", t.startsWith("⛔ 6284332221100 — BANNED") && t.includes("history:\n#530 3300155108395520491") && !t.includes("order logged"), t.replace(/\n/g, " | "));
  check("still 1 event", store(root)["6284332221100"].events.length === 1);
}

console.log("S18a re-paste fills blank driver + customer, reply stays T3");
{
  const root = sandbox("s18a");
  sheetRows = []; pushes.length = 0; sent.length = 0;
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "6289090909090": {
      first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
      events: [{ no: "530", id: "3300155108395520491", driver: "", customer: "", ts: 1791804480000, shot: "old.jpg", chat: 555, verdict: "new" }],
      pushedStatus: "not banned", pushedReason: "",
    },
  }));
  const r = await runOnce(root, shotUpdate("089090909090"));
  const t = lastReply();
  checkExit(r);
  check("still T3", t === "✅ 6289090909090 — CHECKING\norder already recorded\norder: #530\norder ID: 3300155108395520491\nhistory:\n#530 3300155108395520491", t.replace(/\n/g, " | "));
  const ev = store(root)["6289090909090"].events[0];
  check("blanks filled from the fresh shot", ev.driver === "RAHMAT FADLI" && ev.customer === "Nadya");
  check("fill was logged", r.out.includes("backfill 6289090909090 #530"));
  check("sheet push carries the filled names", pushes.at(-1).log.at(-1).driver === "RAHMAT FADLI" && pushes.at(-1).log.at(-1).customer === "Nadya");
}

console.log("S18b filled cells are never overwritten by a re-paste");
{
  const root = sandbox("s18b");
  sheetRows = []; sent.length = 0;
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "6289191919191": {
      first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
      events: [{ no: "530", id: "3300155108395520491", driver: "ORIGINAL DRIVER", customer: "Original", ts: 1791804480000, shot: "old.jpg", chat: 555, verdict: "new" }],
      pushedStatus: "not banned", pushedReason: "",
    },
  }));
  const r = await runOnce(root, shotUpdate("089191919191"));
  checkExit(r);
  const ev = store(root)["6289191919191"].events[0];
  check("original names kept", ev.driver === "ORIGINAL DRIVER" && ev.customer === "Original");
  check("no backfill logged", !r.out.includes("backfill"));
}

console.log("S18c wrong-number paste never fills the owner's blanks");
{
  const root = sandbox("s18c");
  sheetRows = []; sent.length = 0;
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "6289292929292": {
      first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
      events: [{ no: "530", id: "3300155108395520491", driver: "", customer: "", ts: 1791804480000, shot: "old.jpg", chat: 555, verdict: "new" }],
      pushedStatus: "not banned", pushedReason: "",
    },
  }));
  await runOnce(root, shotUpdate("089393939393"));
  check("T4 warning", lastReply().startsWith("⚠️ 6289393939393 — CHECKING"));
  const ev = store(root)["6289292929292"].events[0];
  check("owner blanks untouched", ev.driver === "" && ev.customer === "");
}

console.log("S19a /delete by order ID removes the order + queues the Sheet tombstone");
{
  const root = sandbox("s19a");
  sheetRows = []; pushes.length = 0; sent.length = 0;
  const seed = {
    first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
    events: [
      { no: "530", id: "3300155108395520491", driver: "RAHMAT FADLI", customer: "Nadya", ts: 1791804480000, shot: "a.jpg", chat: 555, verdict: "new" },
      { no: "531", id: "3301316233709056913", driver: "BUDI SANTOSO", customer: "Siti", ts: 1791804490000, shot: "b.jpg", chat: 555, verdict: "returning" },
    ],
    pushedStatus: "not banned", pushedReason: "",
  };
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({ "6289090909090": seed }));
  const r = await runOnce(root, textUpdate("/delete 3300155108395520491"));
  const t = lastReply();
  checkExit(r);
  check("T14 exact", t === "🗑️ order #530 3300155108395520491 — DELETED\nwas 6289090909090's order · 1 order left.", t.replace(/\n/g, " | "));
  check("event gone locally, other kept", store(root)["6289090909090"].events.length === 1 && store(root)["6289090909090"].events[0].no === "531");
  const last = pushes.at(-1);
  check("tombstone queued with row identity", last.delete.length === 1 && last.delete[0].phone === "6289090909090" && last.delete[0].no === "530" && typeof last.delete[0].time === "string" && last.delete[0].time.length > 0, JSON.stringify(last.delete));
  check("deleted order absent from the push log", !last.log.some((l) => l.id === "3300155108395520491"));
}

console.log("S19b /delete unknown order ID refuses");
{
  const root = sandbox("s19b");
  sheetRows = []; sent.length = 0;
  await runOnce(root, textUpdate("/delete 9999999999999999"));
  check("NO DATA refusal", lastReply() === "🔍 NO DATA — order 9999999999999999 not in database.", lastReply());
}

console.log("S19c /delete by number + #number");
{
  const root = sandbox("s19c");
  sheetRows = []; pushes.length = 0; sent.length = 0;
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "6289191919191": {
      first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
      events: [{ no: "530", id: "3300155108395520491", driver: "", customer: "", ts: 1791804480000, shot: "a.jpg", chat: 555, verdict: "new" }],
      pushedStatus: "not banned", pushedReason: "",
    },
  }));
  await runOnce(root, textUpdate("/delete 089191919191 #530"));
  check("deleted, zero left", lastReply().startsWith("🗑️ order #530 3300155108395520491 — DELETED") && lastReply().includes("0 orders left"), lastReply().replace(/\n/g, " | "));
  check("customer shell kept (number still known)", !!store(root)["6289191919191"] && store(root)["6289191919191"].events.length === 0);
  await runOnce(root, textUpdate("/delete 089191919191 #999"));
  check("unknown #no under a known number refuses", lastReply() === "🔍 NO DATA — order #999 not under 6289191919191.", lastReply());
}

console.log("S20 /delete whole customer removes record + both tombstone kinds");
{
  const root = sandbox("s20");
  sheetRows = []; pushes.length = 0; sent.length = 0;
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "6289292929292": {
      first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
      events: [
        { no: "530", id: "3300155108395520491", driver: "", customer: "", ts: 1791804480000, shot: "a.jpg", chat: 555, verdict: "new" },
        { no: "531", id: "3301316233709056913", driver: "", customer: "", ts: 1791804490000, shot: "b.jpg", chat: 555, verdict: "returning" },
      ],
      pushedStatus: "not banned", pushedReason: "",
    },
  }));
  await runOnce(root, textUpdate("/delete 089292929292"));
  const t = lastReply();
  check("T15 exact", t === "🗑️ 6289292929292 — CUSTOMER DELETED\n2 orders removed.", t.replace(/\n/g, " | "));
  check("record gone locally", !store(root)["6289292929292"]);
  const last = pushes.at(-1);
  check("2 row tombstones + 1 customer tombstone", last.delete.length === 3 && last.delete.some((d) => d.customer === true && d.phone === "6289292929292"), JSON.stringify(last.delete));
  check("customer absent from pushed rows", !last.rows.some((r) => r.phone === "6289292929292"));
}

console.log("S21a /update by order ID patches one cell, propagates on push");
{
  const root = sandbox("s21");
  sheetRows = []; pushes.length = 0; sent.length = 0;
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "6289393939393": {
      first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
      events: [{ no: "530", id: "3300155108395520491", driver: "", customer: "", ts: 1791804480000, shot: "a.jpg", chat: 555, verdict: "new" }],
      pushedStatus: "not banned", pushedReason: "",
    },
  }));
  await runOnce(root, textUpdate("/update 3300155108395520491 driver RAHMAT FADLI"));
  check("T16 exact", lastReply() === "✏️ order #530 3300155108395520491 — UPDATED\ndriver: (blank) → RAHMAT FADLI", lastReply().replace(/\n/g, " | "));
  check("store patched", store(root)["6289393939393"].events[0].driver === "RAHMAT FADLI");
  check("push log row carries the correction", pushes.at(-1).log.at(-1).driver === "RAHMAT FADLI");
}

console.log("S21b /update by number + #number, multi-word name");
{
  const root = sandbox("s21b");
  sheetRows = []; sent.length = 0;
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "6289494949494": {
      first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
      events: [{ no: "531", id: "3301316233709056913", driver: "BUDI SANTOSO", customer: "", ts: 1791804490000, shot: "b.jpg", chat: 555, verdict: "returning" }],
      pushedStatus: "not banned", pushedReason: "",
    },
  }));
  await runOnce(root, textUpdate("/update 089494949494 #531 customer Siti Rahma"));
  check("patched with spaces kept", lastReply().includes("customer: (blank) → Siti Rahma"), lastReply().replace(/\n/g, " | "));
  check("store patched", store(root)["6289494949494"].events[0].customer === "Siti Rahma");
}

console.log("S22 refusals: unknown target, bad field");
{
  const root = sandbox("s22");
  sheetRows = []; sent.length = 0;
  await runOnce(root, textUpdate("/update 9999999999999999 driver X"));
  check("unknown order refuses", lastReply().startsWith("🔍 NO DATA"), lastReply());
  await runOnce(root, textUpdate("/update 3300155108395520491 phone 123"));
  check("bad field shows usage", lastReply().includes("/update <orderID> driver|customer <name>"), lastReply().replace(/\n/g, " | "));
  await runOnce(root, textUpdate("/delete gibberish"));
  check("bad delete shows usage", lastReply().includes("/delete <orderID>"), lastReply().replace(/\n/g, " | "));
}

console.log("S23 /today counts this WIB day only");
{
  const root = sandbox("s23");
  sheetRows = []; sent.length = 0;
  const now = Date.now(), old = now - 3 * 86400e3;
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "6289595959595": {
      first: old, last: now, banned: false, banReason: "", banDate: 0,
      events: [
        { no: "530", id: "3300155108395520491", driver: "A", customer: "B", ts: now, shot: "a.jpg", chat: 555, verdict: "new" },
        { no: "531", id: "3301316233709056913", driver: "C", customer: "D", ts: now, shot: "b.jpg", chat: 555, verdict: "returning" },
        { no: "500", id: "3200000000000000", driver: "E", customer: "F", ts: old, shot: "c.jpg", chat: 555, verdict: "new" },
      ],
      pushedStatus: "not banned", pushedReason: "",
    },
  }));
  await runOnce(root, textUpdate("/today"));
  check("2 today, old one excluded", lastReply().includes("orders: 2 · new: 1 · returning: 1 · banned: 0"), lastReply().replace(/\n/g, " | "));
}

console.log("S24 repeat-offender line appears from the 2nd banned order");
{
  const root = sandbox("s24");
  sheetRows = []; sent.length = 0;
  const mk = (n, v2) => ({
    first: 1791804480000, last: 1791804480000, banned: true, banReason: "fake", banDate: 1791804480000,
    events: [
      { no: "530", id: "3300155108395520491", driver: "", customer: "", ts: 1791804480000, shot: "a.jpg", chat: 555, verdict: "banned" },
      ...(n > 1 ? [{ no: "531", id: v2, driver: "", customer: "", ts: 1791804490000, shot: "b.jpg", chat: 555, verdict: "banned" }] : []),
    ],
    pushedStatus: "banned", pushedReason: "fake",
  });
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "6289696969696": mk(2, "3301316233709056913"),
    "6289797979797": mk(1),
  }));
  await runOnce(root, textUpdate("089696969696"));
  check("2nd shows the counter", lastReply().includes("2nd order while banned."), lastReply().replace(/\n/g, " | "));
  sent.length = 0;
  await runOnce(root, textUpdate("089797979797"));
  check("1st stays quiet", !lastReply().includes("order while banned"), lastReply().replace(/\n/g, " | "));
}

console.log("S25 /find searches driver + customer names");
{
  const root = sandbox("s25");
  sheetRows = []; sent.length = 0;
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "6289595959595": {
      first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
      events: [{ no: "530", id: "3300155108395520491", driver: "RAHMAT FADLI", customer: "Nadya", ts: 1791804480000, shot: "a.jpg", chat: 555, verdict: "new" }],
      pushedStatus: "not banned", pushedReason: "",
    },
  }));
  await runOnce(root, textUpdate("/find rahmat"));
  check("driver hit shows order + owner", lastReply().includes("#530 · 3300155108395520491 · 6289595959595"), lastReply().replace(/\n/g, " | "));
  sent.length = 0;
  await runOnce(root, textUpdate("/find NADYA"));
  check("case-insensitive customer hit", lastReply().includes("#530 ·"), lastReply().replace(/\n/g, " | "));
  sent.length = 0;
  await runOnce(root, textUpdate("/find zzznope"));
  check("clean miss", lastReply() === '🔍 no matches for "zzznope".', lastReply());
}

console.log("S26 /flag by name and by #number, warning fires on next order");
{
  const root = sandbox("s26");
  sheetRows = []; sent.length = 0;
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "6289595959595": {
      first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
      events: [{ no: "530", id: "3300155108395520491", driver: "BUDI SANTOSO", customer: "Siti", ts: 1791804480000, shot: "a.jpg", chat: 555, verdict: "new" }],
      pushedStatus: "not banned", pushedReason: "",
    },
  }));
  await runOnce(root, textUpdate("/flag driver RAHMAT FADLI"));
  check("name form flags exact", lastReply() === "⚠️ driver RAHMAT FADLI — FLAGGED", lastReply());
  sent.length = 0;
  await runOnce(root, textUpdate("/flag driver #530 pipe burst"));
  check("#number form flags that order's driver + reason", lastReply() === "⚠️ driver BUDI SANTOSO — FLAGGED\nreason: pipe burst", lastReply().replace(/\n/g, " | "));
  const flags = JSON.parse(readFileSync(join(root, "notebook", "flagged-drivers.json"), "utf8"));
  check("flag file holds both", !!flags["RAHMAT FADLI"] && !!flags["BUDI SANTOSO"]);
  console.log("S26b flagged driver triggers the warning on a fresh order");
  const root2 = sandbox("s26b");
  sheetRows = []; sent.length = 0;
  await runOnce(root2, textUpdate("/flag driver RAHMAT FADLI"));
  sent.length = 0;
  await runOnce(root2, shotUpdate("080000000002")); // default OCR driver = RAHMAT FADLI
  check("T1 carries the flag warning", lastReply().includes("⚠️ driver RAHMAT FADLI is flagged: no reason given"), lastReply().replace(/\n/g, " | "));
}

console.log("S27 /flag refusals + /unflag");
{
  const root = sandbox("s27");
  sheetRows = []; sent.length = 0;
  writeFileSync(join(root, "notebook", "customers.json"), JSON.stringify({
    "6289595959595": {
      first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
      events: [{ no: "530", id: "3300155108395520491", driver: "", customer: "", ts: 1791804480000, shot: "a.jpg", chat: 555, verdict: "new" }],
      pushedStatus: "not banned", pushedReason: "",
    },
    "6289696969696": {
      first: 1791804480000, last: 1791804480000, banned: false, banReason: "", banDate: 0,
      events: [{ no: "530", id: "9999999999999999", driver: "OTHER DRIVER", customer: "Z", ts: 1791804480000, shot: "b.jpg", chat: 555, verdict: "new" }],
      pushedStatus: "not banned", pushedReason: "",
    },
  }));
  await runOnce(root, textUpdate("/flag driver #530"));
  check("shared #number lists owners, flags nothing", lastReply().includes("belongs to 2 numbers") && lastReply().includes("flag by driver name instead"), lastReply().replace(/\n/g, " | "));
  sent.length = 0;
  await runOnce(root, textUpdate("/flag driver #999"));
  check("unknown #number refuses", lastReply() === "🔍 NO DATA — order #999 not in database.", lastReply());
  sent.length = 0;
  await runOnce(root, textUpdate("/flag driver #530"));
  sent.length = 0;
  await runOnce(root, textUpdate("/unflag driver NOBODY"));
  check("unflag miss is plain", lastReply() === "NOBODY — not flagged (nothing to undo)", lastReply());
  sent.length = 0;
  await runOnce(root, textUpdate("/flag driver Speedy"));
  await runOnce(root, textUpdate("/unflag driver speedy"));
  check("unflag hit (case-insensitive)", lastReply() === "✅ driver SPEEDY unflagged.", lastReply());
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
