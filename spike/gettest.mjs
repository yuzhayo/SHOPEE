// Probe new doGet: GET with token → expect JSON rows (not the old "ready" text).
import { readFileSync } from "node:fs";

const token = readFileSync("../SHEET-TOKEN.txt", "utf8").split(/\r?\n/)[0].trim();
const url = readFileSync("../SHEET-URL.txt", "utf8").trim();

const res = await fetch(`${url}?token=${encodeURIComponent(token)}`);
const txt = await res.text();
console.log(`status: ${res.status}`);
console.log(`body: ${txt.trim().slice(0, 600)}`);
console.log(txt.trim().startsWith("{") ? "GET-JSON-OK" : "GET-NOT-JSON");
