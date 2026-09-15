# Start the OrcaSlicer <-> Anycubic bridge in the background (persistent).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/start-bridge.ps1
$projectDir = Join-Path $PSScriptRoot ".."
$port = 37645

# Already running?
$c = New-Object Net.Sockets.TcpClient
$ok = $c.ConnectAsync("127.0.0.1", $port).Wait(600)
$c.Close()
if ($ok) {
    Write-Output "Bridge already active on $port"
    exit 0
}

$env:NODE_OPTIONS = "--tls-cipher-list=DEFAULT:@SECLEVEL=0 --openssl-legacy-provider"
$proc = Start-Process node -ArgumentList "`"$projectDir\dist\bridge-server.mjs`" --port=$port" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3

$c = New-Object Net.Sockets.TcpClient
$ok = $c.ConnectAsync("127.0.0.1", $port).Wait(1500)
$c.Close()
if ($ok) {
    Write-Output "Bridge started (PID $($proc.Id)) on $port"
} else {
    Write-Output "Bridge failed to start"
    exit 1
}
