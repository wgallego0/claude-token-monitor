@echo off
REM Roda o servidor HTTP do claude-token-monitor em background.
REM Para iniciar com o Windows: copie este atalho para shell:startup.

set SCRIPT=%~dp0usage.js
set PORT=9876

echo Starting claude-token-monitor on port %PORT%...
echo Logs: %TEMP%\claude-token-monitor.log
start /B "" node "%SCRIPT%" --serve %PORT% > "%TEMP%\claude-token-monitor.log" 2>&1
echo Server PID: %ERRORLEVEL%
echo URL: http://localhost:%PORT%/usage
