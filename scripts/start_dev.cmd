@echo off
setlocal
for %%I in ("%~dp0..") do set "PROJECT_ROOT=%%~fI"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\assert_ports_available.ps1" -Ports "18085,5173"
if errorlevel 1 exit /b 1

start "Tiger Web Sheets API" /D "%PROJECT_ROOT%\backend" cmd.exe /d /c call "%PROJECT_ROOT%\scripts\start_backend.cmd"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\verify_manual_runtime.ps1" -WaitSeconds 20
if errorlevel 1 (
  echo Backend startup verification failed. Close the Tiger Web Sheets API window after reviewing its error.
  exit /b 1
)
start "Tiger Web Sheets UI" /D "%PROJECT_ROOT%\frontend" cmd.exe /d /c call "%PROJECT_ROOT%\scripts\start_frontend.cmd"

echo Tiger Web Sheets startup requested.
echo Backend: http://127.0.0.1:18085/api/health
echo Frontend: http://127.0.0.1:5173/
