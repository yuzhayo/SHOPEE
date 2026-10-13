// tests/bot.test.mjs — local black-box harness for the real bot.mjs.
//
// It spawns bot.mjs as a child process in --once mode against a local stub that
// plays Telegram + the Google Sheet. No network, no VM, no quota, no Jack pasting.
// Covered (turn-39 audit batch): P4 sheet-typed ban · P5 mis-paste guard ·
// P8 reply retry · P10 log identity · P11 WIB screenshot folder · P13 TSV verdict ·
// the --once doorbell mode (stale guard, seen-id dedupe, exit contract, and the
// proof it never touches getUpdates/deleteWebhook).
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
const FAKE_OCR = JSON.stringify({ no: "530", id: "3300155108395520491" });

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
    pushes.push(JSON.parse(body));
    res.end("ok");
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
function runRaw(root, raw) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BOT, "--once"], {
      env: { ...process.env, TRACKER_ROOT: root, TG_API_BASE: base, TRACKER_FAKE_OCR: FAKE_OCR },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.stdin.end(raw);
    child.on("close", (code) => resolve({ code, out }));
  });
}
const runOnce = (root, update) => runRaw(root, JSON.stringify(update));

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

// ================= S1: bare number, unknown phone =================
console.log("S1 bare check of an unknown number");
{
  const root = sandbox("s1");
  sheetRows = []; pushes.length = 0; sent.length = 0;
  const r = await runOnce(root, textUpdate("089999999999"));
  checkExit(r);
  check("reply = not in database yet", lastReply() === "🆕 6289999999999 — not in database yet", lastReply());
  check("no order recorded", (store(root)["6289999999999"]?.events.length ?? 0) === 0);
  check("sheet push sent (empty ledger)", pushes.at(-1)?.rows?.length === 0 && pushes.at(-1)?.log?.length === 0);
  check("TSV logged as check", tsv(root).at(-1).split("\t")[2] === "check");
}

// ================= S2-S5: the customer flow on one sandbox =================
console.log("S2 new order (screenshot + number)");
const rootA = sandbox("flow");
{
  sheetRows = []; pushes.length = 0; sent.length = 0;
  const r = await runOnce(rootA, shotUpdate("081112223333"));
  const t = lastReply();
  checkExit(r);
  check("reply = new customer + order logged", t.startsWith("🆕 6281112223333 — new customer · order logged"), t.split("\n")[0]);
  check("history shows the order", t.includes("#530 3300155108395520491"));
  check("screenshot line present", /📸 saved: \d{4}-\d{2}-\d{2}\/\d+_6281112223333\.jpg/.test(t), (t.match(/📸 saved:.*/) ?? [""])[0]);
  const day = (t.match(/📸 saved: (\d{4}-\d{2}-\d{2})\//) ?? [])[1];
  check("P11 screenshot folder = WIB day", day === wibDay(), `folder ${day} vs WIB today ${wibDay()}`);
  const rec = store(rootA)["6281112223333"];
  check("store has exactly 1 event", rec.events.length === 1);
  check("P13 TSV verdict = new (at order time)", tsv(rootA).at(-1).split("\t")[3] === "new");
  const lg = pushes.at(-1).log.at(-1);
  check("sheet log row verdict = new", lg.verdict === "new" && lg.no === "530" && lg.id === "3300155108395520491", JSON.stringify(lg));
}

console.log("S3 same screenshot again = duplicate");
{
  sent.length = 0;
  const r = await runOnce(rootA, shotUpdate("081112223333"));
  const t = lastReply();
  checkExit(r);
  check("reply = returning + already recorded", t.startsWith("✅ 6281112223333 — returning · order already recorded"), t.split("\n")[0]);
  check("still 1 event (no double count)", store(rootA)["6281112223333"].events.length === 1);
  check("TSV action = check-dup", tsv(rootA).at(-1).split("\t")[2] === "check-dup");
}

console.log("S4 mis-paste: same order under a different number (P5)");
{
  sent.length = 0;
  const r = await runOnce(rootA, shotUpdate("082223334444"));
  const t = lastReply();
  checkExit(r);
  check("warns the order belongs to the right number", t.startsWith("⚠️ 6282223334444 — order #530 3300155108395520491 already recorded under 6281112223333"), t.split("\n")[0]);
  check("wrong number recorded nothing", (store(rootA)["6282223333444"]?.events.length ?? 0) === 0);
  check("TSV action = order-wrong-number", tsv(rootA).at(-1).split("\t")[2] === "order-wrong-number");
}

console.log("S5 commands still work");
{
  sent.length = 0;
  await runOnce(rootA, textUpdate("/who 081112223333"));
  check("/who = returning with history", lastReply().startsWith("✅ 6281112223333 — returning") && lastReply().includes("history:"));
  await runOnce(rootA, textUpdate("/start"));
  check("/start = model reminder", lastReply().includes("bare number = check"));
}

// ================= S6-S7: the Sheet is the remote control =================
console.log("S6 ban typed into the Sheet, number never seen by the bot (P4)");
{
  sent.length = 0;
  sheetRows = [{ phone: "081234567890", orders: 0, first: "", last: "", status: "banned", banReason: "fraud test" }];
  const r = await runOnce(rootA, textUpdate("081234567890"));
  const t = lastReply();
  checkExit(r);
  check("reply = banned with reason", t.startsWith("⛔ 6281234567890 — banned") && t.includes("reason: fraud test"), t.replace(/\n/g, " | "));
  check("record created from the cell", store(rootA)["6281234567890"]?.banned === true);
}

console.log("S7 unban typed into the Sheet");
{
  sent.length = 0;
  sheetRows = [{ phone: "081234567890", orders: 0, first: "", last: "", status: "not banned", banReason: "" }];
  await runOnce(rootA, textUpdate("081234567890"));
  check("normal verdict resumes", lastReply().startsWith("🆕 6281234567890 — new customer"), lastReply().split("\n")[0]);
  sheetRows = [];
}

// ================= S8: doorbell-mode safety rails =================
console.log("S8 stale paste (sitting in Telegram for hours) stays unanswered");
{
  sent.length = 0;
  const r = await runOnce(rootA, textUpdate("081112223333", { date: nowUnix() - 7200 }));
  check("exit 0 (acked)", r.code === 0);
  check("no reply sent", sent.length === 0);
  check("logged as stale", r.out.includes("stale update"));
}

console.log("S9 dropped send is retried, not lost (P8)");
{
  sent.length = 0; failSends = 1;
  const r = await runOnce(rootA, textUpdate("081112223333"));
  check("reply still arrived", sent.length === 1, lastReply().split("\n")[0]);
  check("retry was logged", r.out.includes("retry in"));
  failSends = 0;
}

console.log("S10 --once never touches the webhook or the update offset");
{
  check("no deleteWebhook call", !hits.some((h) => h.includes("deleteWebhook")));
  check("no getUpdates call", !hits.some((h) => h.includes("getUpdates")));
  check("no offset file written", !existsSync(join(rootA, "notebook", "offset.txt")));
  check("repeat update is acked, not re-answered", (await runOnce(rootA, { update_id: uid - 3, message: { date: nowUnix(), chat: { id: 555 }, text: "081112223333" } })).out.includes("already handled"));
}

// ================= S11: P10 log identity =================
console.log("S11 an event without a timestamp keeps one stable identity (P10)");
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

// ================= S12: the ear's exit contract =================
console.log("S12 broken input = non-zero exit, so Telegram is asked to retry");
{
  const r = await runRaw(sandbox("bad"), "{not json");
  check("exit 1 on bad stdin", r.code === 1);
  check("logged", r.out.includes("bad json"));
}

console.log("S13 screenshot with no number = saved and logged, silent");
{
  const root = sandbox("s13");
  sent.length = 0;
  await runOnce(root, shotUpdate(""));
  check("no reply", sent.length === 0);
  check("TSV action = SCREENSHOT-ONLY", tsv(root).at(-1).split("\t")[2] === "SCREENSHOT-ONLY");
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
