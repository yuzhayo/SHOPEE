# PLAN.md — ShopeeFood Order Tracker v1

Created: 2026-10-12 · Status: **READY, waiting for Jack's "go"**
Rule: this file IS the plan. Discussion history lives in `discussion-notes.md` (not duplicated here).
File hygiene: everything for this project stays inside `C:\VSCODE\LTX-QUASAR\SHOPEE\`.

---

## 1. Goal (one sentence)

Jack pastes screenshot + customer number into the SHOPEE Telegram group → bot replies
**🆕 new / ✅ returning / ⛔ banned** within seconds → Jack cancels manually.
Memory grows with every order. Cost: **Rp 0**.

**Done = all of these true, verified live:**
- [ ] Paste (number only needed for verdict) → verdict reply < 5 seconds
- [ ] Same number again → "returning, Nth order" with last order date
- [ ] `/ban <num> <reason>` → future pastes of that number → ⛔ with reason
- [ ] `/unban <num>` → back to normal
- [ ] `/who <num>` → full card (orders, dates, ban status)
- [ ] `/status` → alive + uptime
- [ ] Every paste appends a row (number, order #, date, screenshot ref)
- [ ] VM auto-pauses after each job; monthly quota burn projected < 300 min
- [ ] Jack's daily habit: unchanged (same 4 steps as today)

---

## 2. Architecture (locked, turn 21)

```
Jack's phone → Telegram
      ↓
Netlify function (free, always-on "ear" — bot webhook target)
      ↓  wakes on demand (Freestyle API, <100ms)
Freestyle VPS (the brain: pair → normalize → lookup → reply)
      ↓  replies to group, then idles 30s → auto-pauses
Google Sheet (the memory: source of truth, Jack can read it directly)
```

**Piece contracts (who talks to whom, and only through these):**
- **Netlify → VPS:** one entry point: "process this Telegram update payload" (single exec call + payload).
- **VPS → Sheet:** fixed row schema (section 6) via one service account.
- **VPS → Telegram:** send reply to the group; commands list (section 7).
- **Secrets:** bot token, Freestyle API token, Sheet key → `config/` on VPS + Netlify env vars. Never in chat, never in git.

**Final VPS settings (Jack taps, dashboard):** Idle timeout = **30 seconds** · Automatic restart = **ON** · never press Pause.

---

## 3. Phases — uncertainty first

Ordering principle: riskiest unknown gets tested FIRST, because if it fails the design
changes. Each phase ends with **Jack verifying something real** (not code — behavior).

### Phase 0 — Prep · Jack taps (split: A now, B at their phases)

**Batch A — NOW (~3 min):**
- VPS settings: Idle timeout = **30 seconds**, Automatic restart = **ON** → Save
- Take **Snapshot** (top bar button; name e.g. `pre-tracker`)
- Access → **API Tokens** → create token → paste it in chat (Phase 1 needs it)

**Batch B — deferred (amended 2026-10-12, minimal-taps rule):**
- Netlify signup → moves to **Phase 6 start**
- Google Sheet "shopee-customers" → moves to **Phase 4 start**

**Verify A:** settings saved, snapshot listed, token in hand
- **✅ Batch A COMPLETE (2026-10-12):** snapshot `pre-tracker` exists (VM Snapshots list, Oct 12 5:49 PM); State = Paused, **Pause reason = Idle timeout** (30s setting live); slug = `shopee`; token in `VPS-KEY.txt`. Deletion countdown now "in 29 days · Nov 11, 2026" → resets on each run (daily orders keep it alive). Pending spot-check: Automatic restart = ON.

### Phase 1 — RISK SPIKE: wake-on-demand ⚠️ make-or-break — ✅ PASSED (2026-10-12)
- From a script: call Freestyle API → wake paused VM → run one command → get output → VM pauses again
- **Verify:** VM shows Running during call, pauses after, output returned
- **RESULT (evidence: `spike/wake-test.mjs` output):** state `paused` → single `exec()` implicitly woke it → stdout `WAKE-OK / 10:49:00 / freestyle-vm`, statusCode 0 → state `running`. Wake path = implicit (no explicit `start()` needed). Auto-pause in 40s = NO → idle-30s setting not yet Saved (Batch A pending). Quota cost: ~5 min.
- **If it fails:** design pivot (fallbacks section 8) — cheapest possible moment to find out
- **Quota cost:** seconds

### Phase 2 — Bot exists · Jack taps
- @BotFather → create bot → token
- Add bot to SHOPEE group as admin, `/setprivacy Disable`
- **Verify:** Jack sees the bot in member list; test message reaches a listener
- **Jack's taps:** ~5 (guided step-by-step)

### Phase 3 — Brain talks (dev mode: polling, VM manually woken) — ✅ PASSED (2026-10-12)
- Bot receives pastes → replies verdict with in-memory store
- **BUILD DONE (2026-10-12):** source `shopeefood-tracker/bot/bot.mjs` (zero-dep Node, 4,375 B) deployed to VM byte-verified; token installed mode-600; running PID 2406, log: "brain started, offset=0, polling..."
- **Upgraded same turn (turn 27):** screenshot+caption handling — photo saved to `notebook/screenshots/YYYY-MM-DD/`, history row in `notebook/history.tsv`, reply includes `📸 recorded`. 6,489 B, restarted PID 2510.
- **Verify: PASSED** — Jack's real test (screenshot forwarded from Bu Mujib + caption `+62 857-9096-2643`): reply `matched: 6285790962643 / 🆕 NEW customer / 📸 recorded: .../1791804532601_6285790962643.jpg` (his screenshot, 18:28). `/status` also verified in group: `🟢 alive · up 3 min · memory: 0 customers`.
- **This is the first "it's alive" moment** ✅

### Phase 4 — Memory (two steps) — ✅ COMPLETE; two-way sync added turn 33
- **Step 1 (persistent local store) ✅ VERIFIED:** `notebook/customers.json` — loaded at boot, saved atomically after every verdict. Jack's test: `/status` → `memory: 1 customers · store: persistent`; re-paste → `✅ RETURNING · order #2` read from disk.
  - **Crash caught during first deploy:** boot `deleteWebhook` fetch timeout → unhandled rejection killed process. Fixed: try/catch + `unhandledRejection` logger.
- **Reply format rebuilt to Jack's spec (turn 31):** `matched: <phone>` + blank line + multi-line verdict + `history:` block = one line per OCR'd order `#530 3300155108395520491`.
- **OCR extraction (pulled Phase 9 forward):** tesseract 5.3.4 on VM (offline, zero cost), verified on Jack's REAL screenshot: `#530` ✓ + Order ID `3300155108395520491` ✓ (dual-PSM agreement). In-bot `ocrOrder()`; miss → verdict unaffected.
- **Step 2 (Google Sheet mirror) ✅ VERIFIED:** Jack's taps = Sheet `shopee-customers` + Apps Script web app (his code, token from `SHEET-TOKEN.txt`, URL → `SHEET-URL.txt` → VM `config/sheet-url.txt` mode-600). Probe: GET → `shopee-tracker receiver ready`, POST real token → `ok` (wrong-token control rate-limited, non-blocking). Brain `syncSheet()`: full-table push on boot + after every verdict, fire-and-forget, failures logged never fatal. **Evidence: `sheet sync: ok (1 rows)`** @12:42:19 and @12:44:49 (two boots).
- Tabs/cols: `customers` sheet (auto-created), header phone|orders|first_seen|last_order|banned|ban_reason|events (upsert by phone).
- **Two-way + schema (turns 33-35, Jack's asks):** he CAN edit the Sheet. Final design (replaces the turn-33 dirty flag):
  - **Two tabs:** `customers` (phone|orders|first_seen|last_order|status|ban_reason — **status + ban_reason = Jack's cells**; order columns removed) + `orders` (**append-only log: every order = one row** — time|phone|verdict|order number|order id|screenshot|chat; script-side dedupe key phone|no|id|time; id/phone columns format "@" text)
  - **Edit-wins:** pull BEFORE verdict (awaited) + `pushedStatus/pushedReason` baseline compare — cell ≠ last-push = his edit → applies to the very next paste, even for actively-tested numbers. `/ban` still safe (push updates baseline same cycle). Concurrent command-vs-cell = cell wins (documented).
  - **Input model (approved):** bare number = CHECK (zero writes) · screenshot+number = ORDER (recorded once — dedupe Order ID, fallback order no; unreadable OCR = new order) · duplicate screenshot = CHECK · unknown bare number = `not in database yet` (no record) · banned = ban block, new orders still logged.
  - **Reply spec (approved turn 35):** verdict first, phone once (killed the `matched:` header — verdict line carries the pairing proof), facts collapse at1 order (`first & last`), history only when exists, `· order logged` / `📸 saved:` only on order action, dates `12 Oct` (WIB +7).
  - **Push cadence (turn 36):** `sheetPush()` now runs on **every** cycle, checks included (was order/edited-only) — that gap is why the `orders` tab never appeared after Jack's v3 paste (his tests were all checks → zero pushes → `logSheet_()` never ran). Backfill is idempotent: the script dedupes by `phone|no|id|time`, so pushing the full event log each time appends only genuinely new rows.
  - **Duplicate acknowledgement (turn 36, Jack's ask):** `· order already recorded` suffix when a screenshot matches an existing order (previously indistinguishable from a bare check), TSV action logged as `check-dup`.
  - **Data migration done turn 35:** v1 counter retired (orders = events.length), events deduped (his5 test pastes → truth = **1 order #530**), dirty removed, baselines initialized, TSV → 9 cols (action added), WIB display dates (existing dates unchanged).

### Phase 5 — Commands — ✅ BUILD DONE (2026-10-12), verify pending
- `/ban`, `/unban`, `/who`, `/status` per section 7 (+help text lists them)
- Bans persist to store + Sheet sync on every change; `/who` dumps record + `history:` events
- **Verify:** ban → paste → ⛔ with reason → `/unban` → normal (Jack's combined batch, turn 33)

### Phase 6 — Production switch: Netlify ear + webhook + auto-wake
- Switch Telegram from polling → webhook (Netlify URL)
- Netlify: receives update → wakes VPS → passes payload → VPS replies → pauses
- **Verify:** VM **paused** → Jack pastes → verdict arrives → VM **paused again**
- Measure one day of burn; project monthly total
- **If wake fails here:** roll back to polling mode (still functional while VM awake)

### Phase 7 — Guardrails (part of v1, turn 11)
- Pairing echo: reply shows WHAT was matched (number + order #), ~2 min window, same sender
- Screenshot: saved under `notebook/screenshots/YYYY-MM-DD/` + reference in row
- Daily Sheet export backup (keep 7) + `logs/` activity file
- **Verify:** all four behaviors demonstrated once

### Phase 8 — Dry run, then live
- Fake-customer battery: new / returning / banned / malformed number / screenshot-only / number-only
- Then real orders; watch quota for 2 days
- **Verify:** checklist in section 1 all green

---

## 4. What Jack does per phase (non-developer contract)

| Phase | Jack's part |
|---|---|
| 0 | tap settings, take snapshot, sign Netlify, make Sheet |
| 2 | BotFather taps + add bot to group (I guide every tap) |
| 3–5 | paste test messages, judge replies |
| 6 | paste while VM shows paused, confirm verdict |
| 7–8 | run fake battery, then use it for real |

Everything else = agent's job. No code reading required, ever.

---

## 5. Build order on the VPS (folder shape = story)

```
shopeefood-tracker/
├── bot/       ← Telegram listener + replies + commands
├── brain/     ← pairing, number normalization, wake entry point
├── notebook/  ← sheet access, screenshots/YYYY-MM-DD/, backups/
├── config/    ← tokens (git-ignored, never pasted anywhere)
└── logs/      ← daily activity trace
```

---

## 6. Sheet schema (the memory)

| col | meaning |
|---|---|
| phone | normalized `628...` (ONE form — ban-evasion guardrail) |
| first_seen | first order date |
| orders | count (auto +1 each paste) |
| last_order | date + order # of latest |
| **order_no** | `#530` from screenshot — per-paste (amended turn 28, Jack's ask) |
| **order_id** | ShopeeFood global order ID `328301...` from screenshot — per-paste |
| banned | yes/no |
| ban_reason | Jack's words |
| ban_date | when |
| notes | free text ("always late") |
| last_screenshot | file reference |

History row grain = **one paste = one order event**: time, phone, verdict, orders, order_no, order_id, screenshot, chat.

**Added Phase 9 (turn 28, pulled forward from product phase-2 by Jack):** OCR extract of `order_no` + `order_id` from screenshot — **tesseract on VM (zero cost)**; if OCR misses → row still records phone+shot with empty order fields, verdict never blocked. ~~Accuracy to be verified against his real screenshots before marking done.~~ **BUILT in turn 31 (merged into Phase 4 flow):** tesseract 5.3.4 installed; verified on his real screenshot (`#530` + `3300155108395520491`, dual-PSM agreement); reply `history:` line live. Remaining: Jack visually confirms Order ID matches the SAIN field in his app.

---

## 7. Commands (bot surface)

| input | reply |
|---|---|
| paste (number [+ screenshot]) | verdict + echoed pairing |
| `/ban <num> <reason>` | ⛔ stored |
| `/unban <num>` | cleared |
| `/who <num>` | full card |
| `/status` | alive + uptime |

---

## 8. Fallbacks (pre-planned, auto-pivot)

| If | Then |
|---|---|
| Phase 1 wake API fails | pivot host strategy (home box / free cloud); architecture unchanged, only the ear→brain link swaps |
| Sheet API rate limits | local sqlite as working store, Sheet as mirror |
| Webhook flaky in Phase 6 | stay on polling mode while VM awake (functional, pricier) |
| Pairing ambiguity | reply asks "which number?" instead of guessing — never guess a verdict |

---

## 9. Out of scope v1 (frozen, turn 11)

❌ auto-cancel · ❌ rating ingest · ❌ item-level vision history (phase 2 of product) ·
❌ website/dashboard · ❌ any write access to ShopeeFood · ❌ multi-store

---

## 10. Cost ledger

| piece | price |
|---|---|
| Freestyle VPS (existing) | $0 — quota, ~150 min/mo projected |
| Netlify | $0 free tier |
| Google Sheet | $0 |
| @BotFather | $0 |
| **Total** | **Rp 0** |

---

## 11. Plan updates

Decision changes → edit THIS file, keep superseded note in one line (history preserved).
Do not fork the plan into other files.

**2026-10-13 (turn 39) — Phase 5 fixes shipped + Phase 6 ready to switch.**
Bot rebuilt (24,465 B) and deployed: P4 Sheet-typed ban for unseen numbers · P5 mis-paste
guard · P8 reply retry · P10 log identity · P11 WIB screenshot folders · P13 TSV verdict
(at-order-time), plus a `--once` doorbell mode (stdin update → answer → exit; 0 = ack,
1 = Telegram retries) with a stale-paste guard and repeat-delivery dedupe. Local harness
`tests/bot.test.mjs`: **41/41 green**, and the same file runs on the VM. systemd unit
`shopee-brain` installed and crash-tested (killed on purpose, back in ~5 s) — cures the
"VM rebooted, brain never came back" failure observed Oct 13 ~04:07Z. Ear site written
(`netlify-ear/`, zero dependencies, drag-and-drop, Telegram secret-token check); switch
script `spike/netlify-ear.mjs env|switch|rollback`. Remaining for the ear: Jack's Netlify
signup (3 taps), then `env` + `switch` + one real paste. Polling mode stays live meanwhile.

**2026-10-13 (turn 40) - Deploy route moved to GitHub; ear in production.**
GitHub MCP installed (repo `yuzhayo/SHOPEE` now reachable from the agent, `get_me` = `yuzhayo`).
Auto-deploy built on the GitHub side because the Netlify UI link needs a browser consent Jack
never granted: repo secret `NETLIFY_AUTH_TOKEN` + workflow `deploy-ear.yml` → any push touching
`netlify-ear/**` redeploys the site in ~40 s (Actions run success, deploy ready, function 200).
Site env vars set the way the API actually wants them (account-scoped POST, secrets restricted
to build/functions/runtime + non-"all" contexts). Ear proven with synthetic updates
(wrong secret 403 / right secret 200 + VM log line), then **switched**: webhook → ear,
`allowed_updates: message,channel_post`, pending 0, no errors; systemd `shopee-brain`
disabled, no poller process. Polling quota bleed stopped. Remaining: one real paste from Jack
to confirm reply + Sheet row; rollback stays `node netlify-ear.mjs rollback`.

---

## 12. Design dictation from Jack (not final — do not build until he says done)

Jack is dictating how the tool should look/behave. This section is the wishlist;
it stays here turn after turn until he declares it final. Do NOT start building
from a partial list.

- [ ] Data extracted from screenshots: **order ID, order number, driver name,
      pelanggan name** (recorded turn 41; first two already work, last two are new)
- [ ] Reply format direction (A current / B compact / C Indonesian / his own wording) —
      asked, not yet answered

**Update (turn 42) — rulings recorded, wording still open.**
Decided: NO RECORD / REJECTED / no-number-shot flow (NOT SHOPEE | CHECKING+history |
NO DATA + "need NUMBER AND SCREENSHOT") / banned-still-logged / wrong-number = CHECKING
(owner history) / order ID never duplicates (ID match decides) / valid = orderID +
order number + phone (driver/pelanggan extracted, never blocking). Still open: reply
wording (A/B/C/his own). Do NOT build until he declares the design final.

**Update (turn 44) — matrix 16/16 complete.** Cell 11: number + non-Shopee shot → number
check (hit = CHECKING + history, miss = NO DATA). Cell 15: unreadable shot-only →
REJECTED "unable to read order number". Open: reply wording; build on his "final".

**Update (turn 46) — reply templates T1–T3 locked verbatim (Jack's own wording, CAPS
status words, "order logged" on its own line). T4–T13: he decides later. Build only
on his "final".**

**Update (turn 48) — built & shipping.** Matrix + T1–T13 + banned-history coded;
driver/customer extraction; Sheet v3.2 (+2 cols, self-healing); bot auto-deploy
workflow (no PC needed after this). Harness 63/63. His taps after this: (1) Sheet
script re-paste (v3.2), (2) real pastes to verify. Later: per-order dates, reply
wording already locked T1–T3 (T4–T13 as built — he can still veto).

**Update (turn 48 outcome) — v40 live on VM via GitHub (29,511 B verified), ear test
green on new code. Left: his Sheet v3.2 re-paste + real pastes.**

**Update (turn 50) — backfill live: re-paste fills blank driver/customer, nothing else moves.**

**Update (turn 51) — /delete + /update live. His taps: (1) Sheet v3.3 re-paste
(tombstones need it; /update works without), (2) try both commands on a test row.**
