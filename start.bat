@echo off
setlocal EnableDelayedExpansion

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 20 or newer, then run this script again.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required. Install npm, then run this script again.
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  for /f "tokens=*" %%v in ('node --version') do set NODE_VERSION=%%v
  echo Node.js 20 or newer is required. Current version: !NODE_VERSION!
  exit /b 1
)

echo Installing or updating dependencies...
call npm install --no-bin-links
if errorlevel 1 exit /b %errorlevel%

echo Building the dashboard...
node ".\node_modules\typescript\bin\tsc"
if errorlevel 1 exit /b %errorlevel%
node ".\node_modules\vite\bin\vite.js" build
if errorlevel 1 exit /b %errorlevel%

echo Starting Trading Halts Radar...
if not defined PORT set PORT=8787
echo Open http://localhost:%PORT%/ in your browser.
set NODE_ENV=production
node ".\server\index.js"
