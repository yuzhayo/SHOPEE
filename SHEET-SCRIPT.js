// ============================================================================
// SHOPEE TRACKER — Sheet receiver script v3.4 (PATCHED)
// v3.4: LockService + batched getValues() (no getValue() in loop) -> 6-min quota safe
// ============================================================================
const TOKEN = "dd273fa37cef0ed442e295645fdd45f8e3c0ec7edb697f12";

const CUST_NAME = "customers";
const CUST_HEAD = ["phone", "orders", "first_seen", "last_order", "status", "ban_reason"];
const LOG_NAME = "orders";
const LOG_HEAD = ["time", "phone", "verdict", "order number", "order id", "driver", "customer name", "screenshot", "chat"];

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
  sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat("@");
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
  } else {
    const cur = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    if (cur.join("|") !== LOG_HEAD.join("|")) {
      if (cur.length === 7 && sh.getLastRow() > 1) {
        const n = sh.getLastRow() - 1;
        const old67 = sh.getRange(2, 6, n, 2).getValues();
        sh.getRange(2, 8, n, 2).setValues(old67);
        sh.getRange(2, 6, n, 2).clearContent();
      }
      sh.getRange(1, 1, 1, LOG_HEAD.length).setValues([LOG_HEAD]);
      if (sh.getLastColumn() > LOG_HEAD.length) {
        sh.getRange(1, LOG_HEAD.length + 1, sh.getLastRow(), sh.getLastColumn() - LOG_HEAD.length).clearContent();
      }
    }
  }
  sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat("@");
  sh.getRange(1, 2, sh.getMaxRows(), 1).setNumberFormat("@");
  sh.getRange(1, 5, sh.getMaxRows(), 1).setNumberFormat("@");
  return sh;
}

function norm_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), "yyyy-MM-dd HH:mm");
  }
  return String(v === null || v === undefined ? "" : v).trim();
}
function lkey_(phone, no, time) { return `${norm_(phone)}|${norm_(no)}|${norm_(time)}`; }

function readRows_() {
  const data = custSheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    out.push({ phone: String(data[i][0]), orders: data[i][1], first: String(data[i][2]), last: String(data[i][3]), status: String(data[i][4]), banReason: String(data[i][5]) });
  }
  return out;
}

function doGet(e) {
  const tok = (e && e.parameter && e.parameter.token) || "";
  if (tok !== TOKEN) return ContentService.createTextOutput("denied");
  return ContentService.createTextOutput(JSON.stringify({ rows: readRows_() })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return ContentService.createTextOutput("busy");
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) return ContentService.createTextOutput("denied");

    const sh = custSheet_();
    const data = sh.getDataRange().getValues();
    const existing = {};
    for (let i = 1; i < data.length; i++) if (data[i][0]) existing[String(data[i][0])] = i + 1;
    for (const r of body.rows || []) {
      const row = [r.phone, r.orders, r.first, r.last, r.status, r.banReason];
      if (existing[r.phone]) sh.getRange(existing[r.phone], 1, 1, CUST_HEAD.length).setValues([row]);
      else sh.appendRow(row);
    }

    const lsh = logSheet_();
    const lastRow = lsh.getLastRow();
    const rowOf = {};
    if (lastRow > 1) {
      const ldata = lsh.getRange(2, 1, lastRow - 1, 5).getValues();
      for (let i = 0; i < ldata.length; i++) {
        if (!ldata[i][1]) continue;
        const k = lkey_(ldata[i][1], ldata[i][3], ldata[i][0]);
        if (!(k in rowOf)) rowOf[k] = i + 2;
      }
    }
    for (const r of body.log || []) {
      const row = [r.time, r.phone, r.verdict, r.no, r.id, r.driver || "", r.customer || "", r.shot, r.chat];
      const k = lkey_(r.phone, r.no, r.time);
      if (rowOf[k]) {
        const cur = lsh.getRange(rowOf[k], 1, 1, LOG_HEAD.length).getValues()[0];
        if (norm_(cur[4]) !== norm_(r.id) || norm_(cur[5]) !== norm_(r.driver || "") ||
            norm_(cur[6]) !== norm_(r.customer || "") || norm_(cur[7]) !== norm_(r.shot) ||
            norm_(cur[2]) !== norm_(r.verdict)) {
          lsh.getRange(rowOf[k], 1, 1, LOG_HEAD.length).setValues([row]);
        }
        continue;
      }
      lsh.appendRow(row);
      rowOf[k] = lsh.getLastRow();
    }

    let deleted = 0;
    const dels = body.delete || [];
    if (dels.length) {
      const custDels = dels.filter(d => d.customer && !d.no);
      if (custDels.length && sh.getLastRow() > 1) {
        const phones = new Set(custDels.map(d => String(d.phone)));
        const custPhones = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().flat().map(String);
        const toDelCust = [];
        for (let i = 0; i < custPhones.length; i++) if (phones.has(custPhones[i])) toDelCust.push(i + 2);
        toDelCust.sort((a,b) => b - a);
        for (const r of toDelCust) { sh.deleteRow(r); deleted++; }
      }
      const orderDels = dels.filter(d => !d.customer && d.no);
      if (orderDels.length && lsh.getLastRow() > 1) {
        const n = lsh.getLastRow() - 1;
        const vals = lsh.getRange(2, 1, n, 5).getValues();
        const keyToRows = {};
        for (let i = 0; i < vals.length; i++) {
          const k = lkey_(vals[i][1], vals[i][3], vals[i][0]);
          if (!keyToRows[k]) keyToRows[k] = [];
          keyToRows[k].push(i + 2);
        }
        const toDelOrd = [];
        for (const d of orderDels) {
          const k = lkey_(d.phone, d.no, d.time);
          if (keyToRows[k]) toDelOrd.push(...keyToRows[k]);
        }
        const uniq = [...new Set(toDelOrd)].sort((a,b) => b - a);
        for (const r of uniq) { lsh.deleteRow(r); deleted++; }
      }
    }
    return ContentService.createTextOutput(`ok deleted:${deleted}`);
  } finally {
    lock.releaseLock();
  }
}