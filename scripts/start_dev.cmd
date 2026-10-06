@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."

start "Tiger Web Sheets API" /D "%PROJECT_ROOT%\backend" "%PROJECT_ROOT%\scripts\start_backend.cmd"
start "Tiger Web Sheets UI" /D "%PROJECT_ROOT%\frontend" "%PROJECT_ROOT%\scripts\start_frontend.cmd"

echo Tiger Web Sheets startup requested.
echo Backend: http://127.0.0.1:18085/api/health
echo Frontend: http://127.0.0.1:5173/
