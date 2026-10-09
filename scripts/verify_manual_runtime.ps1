param(
    [ValidateRange(0, 60)]
    [int] $WaitSeconds = 0
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$expectedDatabase = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'data\tiger_web_sheets.db'))
$expectedWorkbooks = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'workbooks'))
$expectedHistory = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'history'))
$expectedVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'VERSION') -Raw).Trim()
$healthUrl = 'http://127.0.0.1:18085/api/health'
$deadline = (Get-Date).AddSeconds($WaitSeconds)

do {
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        break
    } catch {
        if ((Get-Date) -ge $deadline) {
            throw "Tiger Web Sheets backend is unavailable at $healthUrl. Start scripts\start_backend.cmd first."
        }
        Start-Sleep -Milliseconds 250
    }
} while ($true)

if (
    $health.status -ne 'ok' -or
    $health.product_version -ne $expectedVersion -or
    $health.runtime_mode -ne 'manual' -or
    $health.instance_nonce -ne 'manual' -or
    -not ([System.IO.Path]::GetFullPath([string] $health.database_path)).Equals($expectedDatabase, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not ([System.IO.Path]::GetFullPath([string] $health.workbook_root)).Equals($expectedWorkbooks, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not ([System.IO.Path]::GetFullPath([string] $health.history_root)).Equals($expectedHistory, [System.StringComparison]::OrdinalIgnoreCase)
) {
    throw 'Backend identity mismatch. Refusing to start the manual frontend against an unexpected database or storage root.'
}

Write-Output "Verified Tiger Web Sheets $($health.product_version) manual runtime identity."
