// Phase 1 risk spike: wake-on-demand test against the Freestyle VM.
// Reads API key from ../VPS-KEY.txt (first line). Never prints the key.
import { readFileSync } from "node:fs";

const KEY_PATH = new URL("../VPS-KEY.txt", import.meta.url);
const VM_ID = "vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309";

const key = readFileSync(KEY_PATH, "utf8").split(/\r?\n/)[0].trim();
if (!key) {
  console.log("FAIL: no key found in VPS-KEY.txt");
  process.exit(1);
}
process.env.FREESTYLE_API_KEY = key;

const { Freestyle } = await import("freestyle");
const f = new Freestyle();
const vm = f.vms.ref(VM_ID);

const state = async (label) => {
  try {
    const d = await vm.data();
    console.log(`[${label}] state=${d.state ?? JSON.stringify(d)}`);
    return d.state;
  } catch (e) {
    console.log(`[${label}] data() error: ${e.message}`);
    return null;
  }
};

console.log("=== PHASE 1 WAKE SPIKE ===");
const s1 = await state("before");

let execResult = null;
let wakePath = "";
try {
  execResult = await vm.exec({ command: "echo WAKE-OK; date -u +%H:%M:%S; hostname", timeoutMs: 30000 });
  wakePath = "implicit-wake (exec alone)";
} catch (e) {
  console.log(`exec without start failed: ${e.message}`);
  console.log("trying explicit start()...");
  try {
    await vm.start();
    wakePath = "explicit start() + exec";
    execResult = await vm.exec({ command: "echo WAKE-OK; date -u +%H:%M:%S; hostname", timeoutMs: 30000 });
  } catch (e2) {
    console.log(`explicit start+exec also failed: ${e2.message}`);
    console.log("RESULT: WAKE-BROKEN");
    process.exit(2);
  }
}

console.log(`wake path used: ${wakePath}`);
console.log(`exec statusCode: ${execResult.statusCode}`);
console.log(`exec stdout: ${JSON.stringify(execResult.stdout)}`);
if (execResult.stderr) console.log(`exec stderr: ${JSON.stringify(execResult.stderr)}`);
const wokeOk = String(execResult.stdout ?? "").includes("WAKE-OK");
console.log(`woke and ran command: ${wokeOk ? "YES" : "NO"}`);

const s2 = await state("after exec");
console.log("waiting 40s to observe idle auto-pause (setting: 30s if saved, 5min if not)...");
await new Promise((r) => setTimeout(r, 40000));
const s3 = await state("after 40s idle");

console.log("=== RESULT ===");
console.log(`exec works from any state: ${wokeOk ? "YES" : "NO"}`);
console.log(`auto-paused within 40s: ${s3 === "paused" ? "YES (30s setting is SAVED)" : `NO (state=${s3}) — idle setting likely still 5min, Save may be pending`}`);
