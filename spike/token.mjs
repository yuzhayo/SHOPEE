// One-off: generate Sheet sync token → local file + VM config (mode 600).
// NEVER prints the token — only byte counts.
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";

const token = randomBytes(24).toString("hex");
writeFileSync("../SHEET-TOKEN.txt", token);
console.log(`local SHEET-TOKEN.txt written (${token.length} chars)`);

process.env.FREESTYLE_API_KEY = readFileSync("../VPS-KEY.txt", "utf8").split(/\r?\n/)[0].trim();

async function main() {
  const { Freestyle } = await import("freestyle");
  const f = new Freestyle();
  const vm = f.vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");
  const b64 = Buffer.from(token, "utf8").toString("base64");
  for (let i = 0; i < 3; i++) {
    try {
      const r = await vm.exec({
        command: `echo '${b64}' | base64 -d > /home/ubuntu/shopeefood-tracker/config/sheet-token.txt && chmod 600 /home/ubuntu/shopeefood-tracker/config/sheet-token.txt && wc -c /home/ubuntu/shopeefood-tracker/config/sheet-token.txt`,
        timeoutMs: 30000,
      });
      if (r.statusCode === 0) {
        console.log(`vm: ${r.stdout.trim()} (mode 600)`);
        console.log("TOKEN-DEPLOY-DONE");
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("token push failed after 3 tries");
}
main();
