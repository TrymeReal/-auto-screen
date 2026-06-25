@echo off
title Auto Screen Dashboard
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   AUTO SCREEN DASHBOARD — STARTING      ║
echo  ╚══════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: Set GH_TOKEN dari environment atau .env
if "%GH_TOKEN%"=="" (
  if exist "%~dp0.env" (
    for /f "tokens=1,2 delims==" %%a in ('findstr /i "GH_TOKEN" "%~dp0.env"') do set %%a=%%b
  )
)

if "%GH_TOKEN%"=="" (
  echo  [!] GH_TOKEN belum di-set!
  echo      Set dulu dengan: set GH_TOKEN=ghp_xxxxx
  echo      Atau buat file .env dengan isi: GH_TOKEN=ghp_xxxxx
  echo.
  pause
  exit /b 1
)

echo  GH_TOKEN: terdeteksi
echo  Mode: Server lokal ^(data dari GitHub private repo^)
echo.
echo  Menjalankan server di http://localhost:3131 ...
echo  Tekan Ctrl+C untuk stop
echo.

node server.js
