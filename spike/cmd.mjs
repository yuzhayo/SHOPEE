// cmd — run one command on the tracker VM and print stdout/stderr.
// Usage: node cmd.mjs <command...>  e.g. node cmd.mjs tail -5 logs/bot.log
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.FREESTYLE_API_KEY = readFileSync(join(__dirname, "..", "VPS-KEY.txt"), "utf8").split(/\r?\n/)[0].trim();
const { Freestyle } = await import("freestyle");
const vm = new Freestyle().vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");
const command = process.argv.slice(2).join(" ");
if (!command) { console.log("usage: node cmd.mjs <command>"); process.exit(1); }
const r = await vm.exec({ command, timeoutMs: 30000 });
console.log((r.stdout || "").trimEnd());
if (r.stderr) console.log(`[stderr] ${r.stderr.trim()}`);
if (r.statusCode !== 0) console.log(`[exit ${r.statusCode}]`);