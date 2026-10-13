# RUNBOOK — ShopeeFood order tracker

Jack's tool: paste an order into Telegram → bot answers 🆕 new / ✅ returning / ⛔ banned.
The Google Sheet is the visible record. Cost: Rp 0 (free-tier pieces only).

---

## 1. The moving parts

| Piece | What it is | Where |
|---|---|---|
| **Bot** | reads your messages, decides the verdict, replies, writes the Sheet | the VM: `/home/ubuntu/shopeefood-tracker/bot/bot.mjs` |
| **VM** | the rented room the bot lives in | Freestyle, id `vm-4e5fb8f51dbc4dd3a43b2cc2f23c7309`, slug `shopee` |
| **Sheet** | your ledger: tabs `customers` + `orders` | Google Sheet `SHOPEE_CUSTOMER`, script `SHEET-SCRIPT.js` |
| **Ear** | the doorbell: wakes the VM per message | Netlify function at `https://shopeefood-ear.netlify.app/.netlify/functions/ear` (**live**) |
| **Supervisor** | restarts the brain after a crash or reboot | systemd unit `shopee-brain` on the VM — **parked** while the ear runs (`switch` disables it; `rollback` brings it back) |
| **Auto-deploy** | pushes to GitHub redeploy the ear | GitHub Actions workflow `.github/workflows/deploy-ear.yml` |
| **Local project** | source of truth for code + docs | `C:\VSCODE\LTX-QUASAR\SHOPEE\` |

Secrets (files only, never typed into chat): `VPS-KEY.txt` (VM API key),
`BOT-KEY.txt` (Telegram bot token), `SHEET-TOKEN.txt`, `SHEET-URL.txt`,
`WEBHOOK-SECRET.txt` (Telegram↔Netlify shared secret), `NETLIFY_PERSONAL_ACCESS_TOKEN.txt`,
`GITHUB-PAT.txt`.

---

## 2. Daily use (Jack)

- **Check a number**: type `0857xxxx` → get 🆕 / ✅ / ⛔.
- **Log an order**: send a **screenshot + the number** → recorded once, replied once.
- **Ban someone**: `/ban 0857xxxx reason` — or type `banned` in that row's **status** cell in the Sheet; the bot picks it up on the next paste.
- **Unban**: `/unban 0857xxxx` or set the cell back to `not banned`.
- **Complete blank cells**: re-paste an order's screenshot + number — empty driver/customer cells fill in by themselves (reply stays CHECKING).
- **Fix a wrong name**: `/update 33013...0713 driver RAHMAT FADLI` — or `/update 0857xxxx #531 customer Siti`. Only driver/customer can be corrected (counts, dates and verdicts stay computed).
- **Remove an order**: `/delete 33013...0713` — or `/delete 0857xxxx #531`. Gone locally and off the Sheet.
- **Remove a customer**: `/delete 0857xxxx` — number and all its orders, both places.
- If the bot ever seems quiet: send `/status` (polling mode) or just paste again (ear mode).

---

## 3. Health check (one command, from `C:\VSCODE\LTX-QUASAR\SHOPEE\spike`)

**Ear mode (current):**
```
node cmd.mjs tail -5 /home/ubuntu/shopeefood-tracker/logs/bot.log
```
Expected: a recent `reply ...` line after each paste. The unit *should* read `inactive` /
`disabled` — in ear mode the brain only exists while a message wakes it.
Webhook health (from `SHOPEE\`): `getWebhookInfo` must show `pending: 0` and `last_error: none`.

**Polling mode (only after `rollback`):**
```
node cmd.mjs systemctl is-active shopee-brain
node peek.mjs
```
Expected: `active`, a recent `brain started` or `reply ...` line, and the process
shown in `ps` with parent PID 1 (systemd owns it).

---

## 4. Recipes

**Restart the brain** (safe, idempotent):
```
node cmd.mjs sudo systemctl restart shopee-brain
```

**Stop it** (bot goes quiet, VM can idle and pause):
```
node cmd.mjs sudo systemctl disable --now shopee-brain
```

**Deploy a new bot version** (no PC in the loop — GitHub does it):
push `shopeefood-tracker/bot/bot.mjs` to `main` → workflow `deploy-bot.yml`
makes the VM pull the file from the repo, syntax-checks it, swaps it in, and
restarts the poller only if polling is on (in ear mode nothing runs to restart).
Local byte-verified deploy still exists for emergencies:
```
cd C:\VSCODE\LTX-QUASAR\SHOPEE\spike
node deploy-v39.mjs
```

**Run the test harness** (no VM, no quota, no Telegram — proves the bot before deploying):
```
cd C:\VSCODE\LTX-QUASAR\SHOPEE\shopeefood-tracker
node tests\bot.test.mjs
```
41 checks, exit 0 = all green. The same file also runs on the VM.

**Watch it live**:
```
node peek.mjs            # log tail + store tail
node cmd.mjs tail -f /home/ubuntu/shopeefood-tracker/logs/bot.log
```

---

## 5. The two modes

**Ear / doorbell (current):** the VM sleeps; your message rings the ear
on Netlify, which wakes the VM, hands over the message, and the bot answers.
A message costs a few seconds of VM time instead of an hour of idling.
**Live since Oct 13 (turn 40):** webhook → ear, unit disabled, quota stopped bleeding.

**Polling (rollback only):** the brain sits waiting, asking Telegram every 30 s.
Simple, but it burns the free quota (~4 vCPU-h per hour it runs) and can go silent.

Switch (already done — here for the record):
```
cd C:\VSCODE\LTX-QUASAR\SHOPEE\spike
node netlify-ear.mjs env <site-url>      # put the secrets on the Netlify site
node netlify-ear.mjs switch <site-url>   # point Telegram at the ear, stop polling
```
Verify with one real paste. Rollback any time:
```
node netlify-ear.mjs rollback            # back to polling
```

Rules when switching:
- **Never run both.** Two listeners = duplicate replies. `switch` stops the unit first.
- The bot in `--once` mode never touches `getUpdates` or the webhook — the webhook *is* the queue.
- Telegram retries a failed delivery for up to 24 h; the bot marks each update id as
  handled only after success, so a retry never double-books an order.

**Updating the ear:** change files under `netlify-ear\`, push to `main` → GitHub Actions
deploys automatically (~40 s, workflow `deploy-ear.yml`). The Netlify site env vars
(`FREESTYLE_API_KEY`, `TELEGRAM_SECRET`) live on the site itself — pushes never touch them.

**Updating the bot:** push `shopeefood-tracker/bot/bot.mjs` to `main` → workflow
`deploy-bot.yml` makes the VM download that exact file from the repo, `node --check`
it, and swap it in (a broken file never replaces a working one). No PC, no cables:
even an edit made on github.com from your phone ships by itself.

| Piece | Source file | Ships via | Needs |
|---|---|---|---|
| Ear | `netlify-ear/**` | `deploy-ear.yml` | repo secret `NETLIFY_AUTH_TOKEN` |
| Bot | `bot/bot.mjs` | `deploy-bot.yml` | repo secret `FREESTYLE_API_KEY`, var `VM_ID` |
| Sheet script | `SHEET-SCRIPT.js` | **your one tap**: paste into Extensions → Apps Script → New version → Deploy | browser |

**Sheet script v3.2 (one repaste, replaces v3):** the `orders` tab gains `driver` +
`customer name` columns. The script rewrites the header itself AND shifts your
existing rows right so old screenshots/chats stay under the right headings.

---

## 6. What has actually broken (and the cure in place)

| Failure | Evidence | Cure |
|---|---|---|
| VM paused mid-poll, brain frozen **10 h 50 m**, bot deaf the whole time | Oct 12 15:58Z → Oct 13 02:48Z; the poll timeout fired the instant the VM was touched | the ear: every message is an external wake, so a freeze cannot stay hidden |
| VM rebooted on its own; brain died, nothing restarted it | Oct 13 ~04:07Z (`uptime: up 0 min`), 17 min of silence | systemd `shopee-brain` with `Restart=always` — killed it on purpose, came back in ~5 s |
| Reply dropped on a transient error | audit case P8 | one retry with backoff inside `send()` |
| Wrong number on an already-logged order created a phantom order | audit case P5 | global order-id check → `⚠️ ... already recorded under <number>` |
| Ban typed into the Sheet for a number the bot never saw was ignored | audit case P4 | a `banned` cell now creates the record |

---

## 7. Layout of the local project

```
SHOPEE\
  PLAN.md                    the plan (single source of truth)
  discussion-notes.md        every turn, with evidence
  RUNBOOK.md                 this file
  SHEET-SCRIPT.js            what you paste into the Sheet (Apps Script)
  .github\workflows\
    deploy-ear.yml           push to main → deploys the ear to Netlify (~40 s)
    deploy-bot.yml           push to main → the VM pulls bot.mjs from the repo (~1 min)
  shopeefood-tracker\
    bot\bot.mjs              the bot (deployed to the VM)
    tests\bot.test.mjs       the local test harness
  netlify-ear\               the doorbell site (deployed by GitHub Actions on push)
    index.html
    netlify\functions\ear.mjs
  spike\                     operator tools
    cmd.mjs                  run one command on the VM
    peek.mjs                 log + store tailer
    deploy-v39.mjs           byte-verified deploy
    supervise.mjs            install/repair the systemd unit
    netlify-ear.mjs          env / switch / rollback for the ear
    audit.mjs                full read-only VM audit
    pause-test.mjs           does polling hold the VM awake?
  {VPS-KEY,BOT-KEY,SHEET-TOKEN,SHEET-URL,WEBHOOK-SECRET,NETLIFY_PERSONAL_ACCESS_TOKEN,GITHUB-PAT}.txt
  .netlify-site-id.txt       the Netlify site id (used by the deploy tooling)
```

---

## 8. Ground rules

- Secrets live in files. Never paste them into chat, and never echo them in reports.
- Stop the brain with an **exact PID** (`ps` → `kill <pid>`) or `systemctl stop` —
  never `pkill -f bot.mjs` from a shell where the pattern matches itself.
- Anything new gets a harness test first; a deploy is only as good as its last green run.
- v1 stays frozen: no auto-cancel, no rating ingest, no website, no ShopeeFood write access.
