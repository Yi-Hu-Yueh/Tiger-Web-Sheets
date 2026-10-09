$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeDirectory = Join-Path $projectRoot '.tools\node-v24.19.0-win-x64'
$npmExecutable = Join-Path $nodeDirectory 'npm.cmd'
$frontendDirectory = Join-Path $projectRoot 'frontend'
$databasePath = Join-Path $projectRoot 'data\tiger_web_sheets.db'
$workbookRoot = Join-Path $projectRoot 'workbooks'
$historyRoot = Join-Path $projectRoot 'history'

if (-not (Test-Path -LiteralPath $npmExecutable)) {
    throw "Portable npm was not found at $npmExecutable"
}

& (Join-Path $PSScriptRoot 'assert_ports_available.ps1') -Ports 5173
& (Join-Path $PSScriptRoot 'verify_manual_runtime.ps1')

$env:Path = "$nodeDirectory;$env:Path"
$env:TIGER_WEB_SHEETS_API_TARGET = 'http://127.0.0.1:18085'
$env:VITE_TIGER_RUNTIME_MODE = 'manual'
$env:VITE_TIGER_DATABASE_PATH = $databasePath
$env:VITE_TIGER_WORKBOOK_ROOT = $workbookRoot
$env:VITE_TIGER_HISTORY_ROOT = $historyRoot
$env:VITE_TIGER_INSTANCE_NONCE = 'manual'
Set-Location -LiteralPath $frontendDirectory
& $npmExecutable run dev -- --host 127.0.0.1 --port 5173 @args
exit $LASTEXITCODE

