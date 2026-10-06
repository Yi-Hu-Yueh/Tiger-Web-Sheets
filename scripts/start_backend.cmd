@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
set "PYTHON_EXE=D:\0TIGER\6months\PythonAPIDevelopment\venv_multi_query\Scripts\python.exe"

if not exist "%PYTHON_EXE%" (
  echo Python was not found at "%PYTHON_EXE%".
  exit /b 1
)

cd /d "%PROJECT_ROOT%\backend"
"%PYTHON_EXE%" -m uvicorn app.main:app --host 127.0.0.1 --port 18085
