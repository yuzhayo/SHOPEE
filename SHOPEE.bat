@echo off
setlocal
rem Open the current LTX-QUASAR OpenCode chat session from the winoc2api folder.
rem If this session id stops matching, run: opencode session list
rem Session updated 2026-10-12: ShopeeFood tracker discussion (see NOTE.md).
set "PROJECT=C:\VSCODE\LTX-QUASAR"
set "SESSION_ID=ses_ed176b863ffeU62vPHKXKLdVJP"
cd /d "%PROJECT%"
opencode --session "%SESSION_ID%"
exit /b %ERRORLEVEL%
