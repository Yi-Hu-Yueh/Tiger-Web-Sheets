@echo off
setlocal
for %%I in ("%~dp0..") do set "PROJECT_ROOT=%%~fI"
set "NODE_DIR=%PROJECT_ROOT%\.tools\node-v24.19.0-win-x64"

if not exist "%NODE_DIR%\npm.cmd" (
  echo Portable npm was not found at "%NODE_DIR%\npm.cmd".
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\assert_ports_available.ps1" -Ports 5173
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\verify_manual_runtime.ps1"
if errorlevel 1 exit /b 1

set "PATH=%NODE_DIR%;%PATH%"
set "TIGER_WEB_SHEETS_API_TARGET=http://127.0.0.1:18085"
set "VITE_TIGER_RUNTIME_MODE=manual"
set "VITE_TIGER_DATABASE_PATH=%PROJECT_ROOT%\data\tiger_web_sheets.db"
set "VITE_TIGER_WORKBOOK_ROOT=%PROJECT_ROOT%\workbooks"
set "VITE_TIGER_HISTORY_ROOT=%PROJECT_ROOT%\history"
set "VITE_TIGER_INSTANCE_NONCE=manual"
cd /d "%PROJECT_ROOT%\frontend"
call "%NODE_DIR%\npm.cmd" run dev -- --host 127.0.0.1 --port 5173
