@echo off
REM Publica o snapshot atual do Claude Code usage no branch `data` do GitHub.
REM Para rodar automaticamente: agende este .bat no Windows Task Scheduler
REM com gatilho "a cada 5 minutos" (ou frequência desejada).

cd /d "%~dp0\.."
node scripts/usage.js --publish > "%TEMP%\claude-token-publish.log" 2>&1
