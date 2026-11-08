@echo off
REM ------------------------------------------------------------------
REM  OrderVoice: put the app online from this laptop (free, no account)
REM  Double-click this file, or run:  start-online.bat
REM  Gives a public https://....trycloudflare.com link that works on
REM  any phone (Wi-Fi or mobile data) while this window stays open.
REM ------------------------------------------------------------------
setlocal
cd /d "%~dp0"
title OrderVoice online

where node >nul 2>nul || (echo Node.js is not installed. & pause & exit /b 1)

if not exist server\node_modules (
  echo Installing packages for the first time...
  call npm run setup || (pause & exit /b 1)
)
if not exist server\.env copy server\.env.example server\.env >nul

REM --- 1. cloudflared (downloaded once into tools\) ------------------
set CF=cloudflared
where cloudflared >nul 2>nul
if errorlevel 1 (
  set CF=%~dp0tools\cloudflared.exe
  if not exist "%~dp0tools\cloudflared.exe" (
    echo Downloading cloudflared...
    if not exist tools mkdir tools
    curl.exe -L --fail -o "%~dp0tools\cloudflared.exe" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe || (echo Download failed. Check your internet. & pause & exit /b 1)
  )
)

REM --- 2. build the app -----------------------------------------------
echo.
echo Building the app...
call npm run build || (pause & exit /b 1)

REM --- 3. start the server in its own window --------------------------
curl.exe -s -o nul http://localhost:4000/api/health
if errorlevel 1 (
  start "OrderVoice server (keep open)" cmd /k "npm start"
) else (
  echo Server already running on port 4000.
)
echo Waiting for the server...
:wait
timeout /t 2 /nobreak >nul
curl.exe -s -o nul http://localhost:4000/api/health || goto wait

REM --- 4. open the public link ----------------------------------------
echo.
echo ==================================================================
echo  In a few seconds a line like this appears below:
echo      https://something-random-words.trycloudflare.com
echo  Open that link on both phones. Keep BOTH windows open.
echo  Press Ctrl+C here to go offline.
echo ==================================================================
echo.
"%CF%" tunnel --no-autoupdate --protocol http2 --url http://localhost:4000
pause
