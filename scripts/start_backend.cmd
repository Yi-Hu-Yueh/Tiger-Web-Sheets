@echo off
setlocal
for %%I in ("%~dp0..") do set "PROJECT_ROOT=%%~fI"
set "PYTHON_EXE=D:\0TIGER\6months\PythonAPIDevelopment\venv_multi_query\Scripts\python.exe"

if not exist "%PYTHON_EXE%" (
  echo Python was not found at "%PYTHON_EXE%".
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\assert_ports_available.ps1" -Ports 18085
if errorlevel 1 exit /b 1

set "TIGER_WEB_SHEETS_RUNTIME=manual"
set "TIGER_WEB_SHEETS_DB=%PROJECT_ROOT%\data\tiger_web_sheets.db"
set "TIGER_WEB_SHEETS_WORKBOOK_ROOT=%PROJECT_ROOT%\workbooks"
set "TIGER_WEB_SHEETS_HISTORY_ROOT=%PROJECT_ROOT%\history"
set "TIGER_WEB_SHEETS_INSTANCE_NONCE=manual"

cd /d "%PROJECT_ROOT%\backend"
"%PYTHON_EXE%" -m uvicorn app.main:app --host 127.0.0.1 --port 18085
