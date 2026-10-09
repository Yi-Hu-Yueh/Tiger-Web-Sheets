[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateRange(1024, 65535)]
    [int] $BackendPort,

    [Parameter(Mandatory)]
    [ValidateRange(1024, 65535)]
    [int] $FrontendPort,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string] $DatabasePath,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string] $WorkbookRoot,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string] $HistoryRoot,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string] $InstanceNonce
)

$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$backendDirectory = Join-Path $projectRoot 'backend'
$frontendDirectory = Join-Path $projectRoot 'frontend'
$pythonExecutable = 'D:\0TIGER\6months\PythonAPIDevelopment\venv_multi_query\Scripts\python.exe'
$nodeExecutable = Join-Path $projectRoot '.tools\node-v24.19.0-win-x64\node.exe'
$viteScript = Join-Path $frontendDirectory 'node_modules\vite\bin\vite.js'
$productVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'VERSION') -Raw).Trim()
$canonicalDatabase = [System.IO.Path]::GetFullPath(
    (Join-Path $projectRoot 'data\tiger_web_sheets.db')
)
$canonicalWorkbookRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $projectRoot 'workbooks')
)
$canonicalHistoryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $projectRoot 'history')
)
$isolatedRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.cache'))
$resolvedDatabase = if ([System.IO.Path]::IsPathRooted($DatabasePath)) {
    [System.IO.Path]::GetFullPath($DatabasePath)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $projectRoot $DatabasePath))
}
$resolvedWorkbookRoot = if ([System.IO.Path]::IsPathRooted($WorkbookRoot)) {
    [System.IO.Path]::GetFullPath($WorkbookRoot)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $projectRoot $WorkbookRoot))
}
$resolvedHistoryRoot = if ([System.IO.Path]::IsPathRooted($HistoryRoot)) {
    [System.IO.Path]::GetFullPath($HistoryRoot)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $projectRoot $HistoryRoot))
}

if ($BackendPort -in @(18085, 5173) -or $FrontendPort -in @(18085, 5173)) {
    throw 'Isolated tests refuse the manual backend/frontend ports 18085 and 5173.'
}
if ($BackendPort -eq $FrontendPort) {
    throw 'BackendPort and FrontendPort must be different.'
}
if ($resolvedDatabase.Equals($canonicalDatabase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Isolated tests refuse data\tiger_web_sheets.db.'
}
if ($resolvedWorkbookRoot.Equals(
    $canonicalWorkbookRoot,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'Isolated tests refuse the manual workbooks directory.'
}
if ($resolvedHistoryRoot.Equals(
    $canonicalHistoryRoot,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'Isolated tests refuse the manual history directory.'
}
$isolatedPrefix = $isolatedRoot.TrimEnd('\') + '\'
if (-not $resolvedDatabase.StartsWith(
    $isolatedPrefix,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'The isolated test database must be located under the project .cache directory.'
}
if (-not $resolvedWorkbookRoot.StartsWith(
    $isolatedPrefix,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'The isolated workbook root must be located under the project .cache directory.'
}
if (-not $resolvedHistoryRoot.StartsWith(
    $isolatedPrefix,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'The isolated history root must be located under the project .cache directory.'
}
if (-not (Test-Path -LiteralPath $pythonExecutable -PathType Leaf)) {
    throw "Python was not found at $pythonExecutable"
}
if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
    throw "Portable Node.js was not found at $nodeExecutable"
}
if (-not (Test-Path -LiteralPath $viteScript -PathType Leaf)) {
    throw "Vite was not found at $viteScript"
}

function Assert-PortAvailable([int] $Port) {
    $listener = [System.Net.Sockets.TcpListener]::new(
        [System.Net.IPAddress]::Loopback,
        $Port
    )
    try {
        $listener.Start()
    } catch {
        throw "Required isolated-test port $Port is already occupied."
    } finally {
        $listener.Stop()
    }
}

Assert-PortAvailable $BackendPort
Assert-PortAvailable $FrontendPort

$runtimeDirectory = Join-Path $projectRoot ".cache\isolated-runtimes\$InstanceNonce"
$databaseDirectory = Split-Path -Parent $resolvedDatabase
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $databaseDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $resolvedWorkbookRoot -Force | Out-Null
New-Item -ItemType Directory -Path $resolvedHistoryRoot -Force | Out-Null

$backendOut = Join-Path $runtimeDirectory 'backend.out.log'
$backendErr = Join-Path $runtimeDirectory 'backend.err.log'
$frontendOut = Join-Path $runtimeDirectory 'frontend.out.log'
$frontendErr = Join-Path $runtimeDirectory 'frontend.err.log'
$backendUrl = "http://127.0.0.1:$BackendPort"
$frontendUrl = "http://127.0.0.1:$FrontendPort"
$backendProcess = $null
$frontendProcess = $null

try {
    $backendStartParameters = @{
        FilePath = $pythonExecutable
        ArgumentList = @(
            '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1',
            '--port', $BackendPort
        )
        WorkingDirectory = $backendDirectory
        WindowStyle = 'Hidden'
        RedirectStandardOutput = $backendOut
        RedirectStandardError = $backendErr
        Environment = @{
            TIGER_WEB_SHEETS_DB = $resolvedDatabase
            TIGER_WEB_SHEETS_RUNTIME = 'isolated-test'
            TIGER_WEB_SHEETS_WORKBOOK_ROOT = $resolvedWorkbookRoot
            TIGER_WEB_SHEETS_HISTORY_ROOT = $resolvedHistoryRoot
            TIGER_WEB_SHEETS_INSTANCE_NONCE = $InstanceNonce
        }
        PassThru = $true
    }
    $backendProcess = Start-Process @backendStartParameters

    $health = $null
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        if ($backendProcess.HasExited) {
            throw "The isolated backend exited before becoming healthy. See $backendErr"
        }
        try {
            $health = Invoke-RestMethod -Uri "$backendUrl/api/health" -TimeoutSec 1
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if ($null -eq $health) {
        throw 'The isolated backend did not become healthy.'
    }
    if (
        $health.status -ne 'ok' -or
        $health.product_version -ne $productVersion -or
        $health.runtime_mode -ne 'isolated-test' -or
        $health.instance_nonce -ne $InstanceNonce -or
        -not $health.database_path.Equals(
            $resolvedDatabase,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        -not $health.workbook_root.Equals(
            $resolvedWorkbookRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        -not $health.history_root.Equals(
            $resolvedHistoryRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw 'The isolated backend identity did not match the requested database, workbook root, and nonce.'
    }

    $frontendStartParameters = @{
        FilePath = $nodeExecutable
        ArgumentList = @(
            $viteScript, '--host', '127.0.0.1', '--port', $FrontendPort,
            '--strictPort'
        )
        WorkingDirectory = $frontendDirectory
        WindowStyle = 'Hidden'
        RedirectStandardOutput = $frontendOut
        RedirectStandardError = $frontendErr
        Environment = @{
            TIGER_WEB_SHEETS_API_TARGET = $backendUrl
            VITE_TIGER_RUNTIME_MODE = 'isolated-test'
            VITE_TIGER_DATABASE_PATH = $resolvedDatabase
            VITE_TIGER_WORKBOOK_ROOT = $resolvedWorkbookRoot
            VITE_TIGER_HISTORY_ROOT = $resolvedHistoryRoot
            VITE_TIGER_INSTANCE_NONCE = $InstanceNonce
        }
        PassThru = $true
    }
    $frontendProcess = Start-Process @frontendStartParameters

    $frontendReady = $false
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
        if ($frontendProcess.HasExited) {
            throw "The isolated frontend exited before becoming ready. See $frontendErr"
        }
        try {
            $response = Invoke-WebRequest -Uri $frontendUrl -TimeoutSec 1
            if ($response.StatusCode -eq 200) {
                $frontendReady = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $frontendReady) {
        throw 'The isolated frontend did not become ready.'
    }

    [pscustomobject]@{
        runtime_mode = 'isolated-test'
        instance_nonce = $InstanceNonce
        database_path = $resolvedDatabase
        workbook_root = $resolvedWorkbookRoot
        history_root = $resolvedHistoryRoot
        backend_port = $BackendPort
        backend_pid = $backendProcess.Id
        backend_url = $backendUrl
        frontend_port = $FrontendPort
        frontend_pid = $frontendProcess.Id
        frontend_url = $frontendUrl
        log_directory = $runtimeDirectory
    } | ConvertTo-Json
} catch {
    if ($null -ne $frontendProcess -and -not $frontendProcess.HasExited) {
        Stop-Process -Id $frontendProcess.Id -ErrorAction SilentlyContinue
    }
    if ($null -ne $backendProcess -and -not $backendProcess.HasExited) {
        Stop-Process -Id $backendProcess.Id -ErrorAction SilentlyContinue
    }
    throw
}
