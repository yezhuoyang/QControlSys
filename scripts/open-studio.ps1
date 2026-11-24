[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 7432,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port/machines"

function Test-StudioReady {
    try {
        $page = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -MaximumRedirection 0
        return $page.StatusCode -eq 200 -and $page.Content.Contains('<title>Machine workbench')
    } catch {
        return $false
    }
}

try {
    if (-not (Test-StudioReady)) {
        $node = Get-Command node.exe -CommandType Application | Select-Object -First 1 -ExpandProperty Source
        $entry = Join-Path $project 'server.mjs'
        $env:QCONTROL_PORT = [string]$Port
        $server = Start-Process -FilePath $node -ArgumentList ('"{0}"' -f $entry) -WorkingDirectory $project -WindowStyle Hidden -PassThru

        $timeout = [Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-StudioReady)) {
            if ($server.HasExited) {
                throw "Studio could not start on port $Port. Check whether another application is using that port."
            }
            if ($timeout.Elapsed.TotalSeconds -ge 20) {
                throw "Studio did not respond at $url within 20 seconds."
            }
            Start-Sleep -Milliseconds 200
        }
    }

    if ($NoBrowser) { Write-Output $url } else { Start-Process -FilePath $url }
} catch {
    if ($NoBrowser) { throw }
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'QuantumOS')
    exit 1
}
