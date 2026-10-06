$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeDirectory = Join-Path $projectRoot '.tools\node-v24.19.0-win-x64'
$npmExecutable = Join-Path $nodeDirectory 'npm.cmd'
$frontendDirectory = Join-Path $projectRoot 'frontend'

if (-not (Test-Path -LiteralPath $npmExecutable)) {
    throw "Portable npm was not found at $npmExecutable"
}

$env:Path = "$nodeDirectory;$env:Path"
Set-Location -LiteralPath $frontendDirectory
& $npmExecutable run dev -- --host 127.0.0.1 --port 5173 @args
exit $LASTEXITCODE

