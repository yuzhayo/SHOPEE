import { readFileSync } from "node:fs";
process.env.FREESTYLE_API_KEY = readFileSync("../VPS-KEY.txt", "utf8").split(/\r?\n/)[0].trim();
const { Freestyle } = await import("freestyle");
const f = new Freestyle();
const vm = f.vms.ref("vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309");
const r = await vm.exec({
  command:
    "echo ---LOG---; tail -3 /home/ubuntu/shopeefood-tracker/logs/bot.log; " +
    "echo ---NOHUP---; cat /home/ubuntu/shopeefood-tracker/logs/nohup.out; " +
    "echo ---PS---; ps -eo pid,args | grep 'node bot/bot.mjs' | grep -v grep; " +
    "echo ---STORE---; cat /home/ubuntu/shopeefood-tracker/notebook/customers.json",
  timeoutMs: 30000,
});
console.log(r.stdout);
