# NOTE — SHOPEE.bat Session

Updated: 2026-10-12

## Session
- SESSION_ID: `ses_ed176b863ffeU62vPHKXKLdVJP`
- Title: Friendly greeting
- Working dir of that session: C:\VSCODE

## What this session is about
ShopeeFood order tracker — design discussion (discussion mode, no build yet).

## Locked design (short)
- Runs on Jack's free Freestyle VPS (Ubuntu 24.04, always on).
- Flow: Jack pastes screenshot + customer number into the "SHOPEE" Telegram group → bot replies 🆕 new / ✅ returning / ⛔ banned → Jack cancels manually.
- Memory: phone number → order history, ban flags + reasons.
- Bot: create later via @BotFather (Jack has none yet).
- v1 scope: number + date + stored screenshot + verdict. Item history = phase 2.
- Outbound polling only — no ports, no domain, no TLS.

## Full running notes
- See `discussion-notes.md` (same folder — updated every turn).
- Rule (Jack, 2026-10-12): ALL files for this topic stay inside `C:\VSCODE\LTX-QUASAR\SHOPEE\` — no scattering, temp files included.

## If session id stops matching
Run: `opencode session list`
