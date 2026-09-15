# Click the Device tab via its UIA bounding rect (screen coordinates), then
# capture the main window to see the result.
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ClickDev {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, int e);
}
'@
$p = Get-Process orca-slicer | Where-Object { $_.MainWindowTitle -like "*OrcaSlicer*" } | Select-Object -First 1
[ClickDev]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 600
# Device tab rect from UIA (physical px): x=319 y=35 w=136 h=36 -> center (387, 53)
[ClickDev]::SetCursorPos(387, 53) | Out-Null
Start-Sleep -Milliseconds 250
[ClickDev]::mouse_event(2, 0, 0, 0, 0)
Start-Sleep -Milliseconds 80
[ClickDev]::mouse_event(4, 0, 0, 0, 0)
Start-Sleep -Seconds 6

$r = New-Object System.Drawing.Rectangle(0, 0, 3433, 1385)
$b = New-Object System.Drawing.Bitmap($r.Width, $r.Height)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen(0, 0, 0, 0, $b.Size)
$b.Save((Join-Path $PSScriptRoot "..\.orca-main.png"))
Write-Output "clicked Device tab at 387,53 + captured"
