// probe-start — recovery probe for the VM before re-deploy.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.FREESTYLE_API_KEY = readFileSync(join(__dirname, "..", "VPS-KEY.txt"), "utf8").split(/\r?\n/)[0].trim();
const { Freestyle } = await import("freestyle");
const vm = new Freestyle().vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");

const d = await vm.data().catch((e) => ({ err: String(e.message || e) }));
console.log("DATA:", JSON.stringify(d));

try {
  const r = await vm.start({ timeoutMs: 90000 });
  console.log("START_OK", JSON.stringify(r));
} catch (e) {
  console.log("START_FAIL", String(e.message || e));
}

try {
  const r = await vm.exec({ command: "echo VM-AWAKE", timeoutMs: 30000 });
  console.log("EXEC", r.statusCode, (r.stdout || "").trim());
} catch (e) {
  console.log("EXEC_FAIL", String(e.message || e));
}
