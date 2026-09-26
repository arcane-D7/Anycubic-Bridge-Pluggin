param(
    [Parameter(Mandatory=$true)][int]$ProcessId,
    [Parameter(Mandatory=$true)][int]$X,
    [Parameter(Mandatory=$true)][int]$Y,
    [Parameter(Mandatory=$true)][string]$Value
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LiveFieldInput {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
}
'@

$p = Get-Process -Id $ProcessId -ErrorAction Stop
[LiveFieldInput]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null
[LiveFieldInput]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 250
[LiveFieldInput]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 100
[LiveFieldInput]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
[LiveFieldInput]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('^a')
[System.Windows.Forms.SendKeys]::SendWait($Value)
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait('^s')
[pscustomobject]@{ ok = $true; process_id = $ProcessId; x = $X; y = $Y; value = $Value; saved = $true } | ConvertTo-Json -Compress
