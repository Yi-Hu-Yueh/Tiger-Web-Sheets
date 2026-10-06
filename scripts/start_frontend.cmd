@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
set "NODE_DIR=%PROJECT_ROOT%\.tools\node-v24.19.0-win-x64"

if not exist "%NODE_DIR%\npm.cmd" (
  echo Portable npm was not found at "%NODE_DIR%\npm.cmd".
  exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"
cd /d "%PROJECT_ROOT%\frontend"
call "%NODE_DIR%\npm.cmd" run dev -- --host 127.0.0.1 --port 5173
