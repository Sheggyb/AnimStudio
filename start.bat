@echo off
title AnimStudio
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
if not exist "node_modules\three\package.json" (
  echo Installing three.js...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
node server.cjs
pause
