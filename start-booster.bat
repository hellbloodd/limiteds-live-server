@echo off
title Agony Values booster
cd /d "%~dp0"
rem The owner key is asked once and kept in booster-key.txt next to this file (never uploaded to GitHub).
if exist booster-key.txt goto run
echo.
set /p KEYIN=Enter your OWNER_KEY (the same one set on Render) and press Enter:
if "%KEYIN%"=="" goto :eof
>booster-key.txt echo %KEYIN%
echo Saved. The booster will start by itself from now on.
:run
set /p OWNER_KEY=<booster-key.txt
node booster.mjs
rem hidden mode (run-booster-hidden.vbs): restart after a crash instead of waiting for a key press
if /i "%~1"=="hidden" (timeout /t 30 /nobreak >nul & goto run)
pause
