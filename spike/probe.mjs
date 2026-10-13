// Phase 3 prep probe: inspect VM runtime + create project folder shape.
// Reads Freestyle key from ../VPS-KEY.txt line 1. Never prints keys.
import { readFileSync } from "node:fs";

const key = readFileSync(new URL("../VPS-KEY.txt", import.meta.url), "utf8")
  .split(/\r?\n/)[0].trim();
if (!key) {
  console.log("FAIL: no freestyle key");
  process.exit(1);
}
process.env.FREESTYLE_API_KEY = key;

const { Freestyle } = await import("freestyle");
const f = new Freestyle();
const vm = f.vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");

const cmd = [
  "node --version 2>/dev/null || echo NO-NODE",
  "python3 --version 2>/dev/null || echo NO-PYTHON",
  "mkdir -p /home/ubuntu/shopeefood-tracker/{bot,brain,notebook,config,logs} && echo DIRS-OK",
  "ls -la /home/ubuntu/shopeefood-tracker",
  "df -h / | tail -1",
].join("; ");

const r = await vm.exec({ command: cmd, timeoutMs: 30000 });
console.log("statusCode:", r.statusCode);
console.log(r.stdout);
if (r.stderr) console.log("stderr:", r.stderr);
