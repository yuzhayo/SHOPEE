// ============================================================================
// SHOPEE TRACKER — Sheet receiver script v3 (READY TO PASTE, token inside)
//
// Tabs:
//   customers : one row per customer — status + ban_reason = YOUR cells
//               (type "banned" = ban, anything else = unbanned)
//   orders    : THE LOG — every order = one new row, never overwritten
//
// HOW TO USE:
//   1. Open your SHOPEE_CUSTOMER Google Sheet
//   2. Extensions -> Apps Script
//   3. Ctrl+A, Delete, then paste this whole file (open it, Ctrl+A, Ctrl+C)
//   4. Ctrl+S to save
//   5. Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy
//
// KEEP THIS FILE SECRET - it contains the sync token.
// ============================================================================

const TOKEN = "dd273fa37cef0ed442e295645fdd45f8e3c0ec7edb697f12";

const CUST_NAME = "customers";
const CUST_HEAD = ["phone", "orders", "first_seen", "last_order", "status", "ban_reason"];
const LOG_NAME = "orders";
const LOG_HEAD = ["time", "phone", "verdict", "order number", "order id", "screenshot", "chat"];

function custSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CUST_NAME) || ss.insertSheet(CUST_NAME);
  const cur = sh.getLastColumn() > 0 ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
  if (cur.join("|") !== CUST_HEAD.join("|")) {
    sh.getRange(1, 1, 1, CUST_HEAD.length).setValues([CUST_HEAD]);
    if (sh.getLastColumn() > CUST_HEAD.length) {
      sh.getRange(1, CUST_HEAD.length + 1, sh.getLastRow(), sh.getLastColumn() - CUST_HEAD.length).clearContent();
    }
  }
  sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat("@"); // phone as text
  return sh;
}

function logSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(LOG_NAME);
  if (!sh) {
    sh = ss.insertSheet(LOG_NAME);
    sh.appendRow(LOG_HEAD);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(LOG_HEAD);
  }
  // phone + time + order id = TEXT columns (19-digit ids must never be numbers)
  sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat("@");
  sh.getRange(1, 2, sh.getMaxRows(), 1).setNumberFormat("@");
  sh.getRange(1, 5, sh.getMaxRows(), 1).setNumberFormat("@");
  return sh;
}

function norm_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(
      v,
      SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(),
      "yyyy-MM-dd HH:mm"
    );
  }
  return String(v === null || v === undefined ? "" : v).trim();
}

// log row identity: one order from one phone at one minute = one row
function lkey_(phone, no, time) {
  return `${norm_(phone)}|${norm_(no)}|${norm_(time)}`;
}

function readRows_() {
  const data = custSheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    out.push({
      phone: String(data[i][0]),
      orders: data[i][1],
      first: String(data[i][2]),
      last: String(data[i][3]),
      status: String(data[i][4]),
      banReason: String(data[i][5]),
    });
  }
  return out;
}

function doGet(e) {
  const tok = (e && e.parameter && e.parameter.token) || "";
  if (tok !== TOKEN) return ContentService.createTextOutput("denied");
  return ContentService.createTextOutput(JSON.stringify({ rows: readRows_() }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.token !== TOKEN) return ContentService.createTextOutput("denied");

  // customers: upsert by phone
  const sh = custSheet_();
  const data = sh.getDataRange().getValues();
  const existing = {};
  for (let i = 1; i < data.length; i++) if (data[i][0]) existing[String(data[i][0])] = i + 1;
  for (const r of body.rows || []) {
    const row = [r.phone, r.orders, r.first, r.last, r.status, r.banReason];
    if (existing[r.phone]) sh.getRange(existing[r.phone], 1, 1, CUST_HEAD.length).setValues([row]);
    else sh.appendRow(row);
  }

  // orders: append-only log — one row per order; existing rows self-heal (wrong id fixed,
  // never duplicated): identity = phone|order number|time
  const lsh = logSheet_();
  const ldata = lsh.getDataRange().getValues();
  const rowOf = {};
  for (let i = 1; i < ldata.length; i++) {
    if (!ldata[i][1]) continue;
    const k = lkey_(ldata[i][1], ldata[i][3], ldata[i][0]);
    if (!(k in rowOf)) rowOf[k] = i + 1;
  }
  for (const r of body.log || []) {
    const row = [r.time, r.phone, r.verdict, r.no, r.id, r.shot, r.chat];
    const k = lkey_(r.phone, r.no, r.time);
    if (rowOf[k]) {
      const cur = lsh.getRange(rowOf[k], 1, 1, LOG_HEAD.length).getValues()[0];
      if (norm_(cur[4]) !== norm_(r.id) || norm_(cur[5]) !== norm_(r.shot) || norm_(cur[2]) !== norm_(r.verdict)) {
        lsh.getRange(rowOf[k], 1, 1, LOG_HEAD.length).setValues([row]);
      }
      continue;
    }
    lsh.appendRow(row);
    rowOf[k] = lsh.getLastRow();
  }

  return ContentService.createTextOutput("ok");
}
