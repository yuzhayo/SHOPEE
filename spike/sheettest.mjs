// Probe the Apps Script web app: GET (alive?) + POST with real token + POST with wrong token (control).
import { readFileSync } from "node:fs";

const token = readFileSync("../SHEET-TOKEN.txt", "utf8").split(/\r?\n/)[0].trim();
const raw = readFileSync("../SHEET-TOKEN.txt", "utf8");
const url = (raw.match(/https:\/\/script\.google\.com\/macros\/\S+\/exec/) || [])[0];
if (!url) throw new Error("no web app URL found in SHEET-TOKEN.txt");

console.log(`url: ${url.slice(0, 60)}... (${url.length} chars)`);

const get = await fetch(url);
console.log(`GET  -> ${get.status} | ${(await get.text()).slice(0, 80)}`);

const post = (tok) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ token: tok, rows: [] }),
  }).then((r) => r.text());

console.log(`POST real token    -> ${(await post(token)).slice(0, 80)}`);
console.log(`POST wrong token   -> ${(await post("wrong")).slice(0, 80)}`);
