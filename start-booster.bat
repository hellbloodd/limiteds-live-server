@echo off
title Agony Values booster
cd /d "%~dp0"
rem The owner key is asked once and kept in booster-key.txt (not uploaded anywhere but the site).
if not exist booster-key.txt (
  echo Enter your OWNER_KEY ^(the same one set on Render^):
  set /p KEYIN=
  call echo %%KEYIN%%> booster-key.txt
)
set /p OWNER_KEY=<booster-key.txt
node booster.mjs
pause
