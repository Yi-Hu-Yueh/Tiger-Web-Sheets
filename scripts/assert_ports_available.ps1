param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string] $Ports
)

$ErrorActionPreference = 'Stop'

foreach ($portText in ($Ports -split ',')) {
    $port = 0
    if (-not [int]::TryParse($portText.Trim(), [ref] $port) -or $port -lt 1 -or $port -gt 65535) {
        throw "Invalid TCP port: $portText"
    }
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($listener) {
        throw "TCP port $port is already occupied by process $($listener.OwningProcess). Tiger Web Sheets did not start and did not stop that process."
    }
}
