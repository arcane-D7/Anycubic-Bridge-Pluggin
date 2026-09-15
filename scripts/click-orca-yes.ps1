# Find the Orca permission dialog and click Yes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ClickWin {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$proc = Get-Process orca-slicer -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*permission*" } | Select-Object -First 1
if (-not $proc) { Write-Output "no permission dialog found"; exit 1 }

$hwnd = $proc.MainWindowHandle
[ClickWin]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 500

$rect = New-Object ClickWin+RECT
[ClickWin]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
Write-Output "window: left=$($rect.Left) top=$($rect.Top) right=$($rect.Right) bottom=$($rect.Bottom)"

# Yes button center in absolute screen coords (dialog at 1492,566, size 440x198)
$clickX = $rect.Left + 305
$clickY = $rect.Top + 172
Write-Output "clicking at $clickX,$clickY"

[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($clickX, $clickY)
Start-Sleep -Milliseconds 200
[ClickWin]::mouse_event(2, 0, 0, 0, 0)
Start-Sleep -Milliseconds 80
[ClickWin]::mouse_event(4, 0, 0, 0, 0)
Write-Output "clicked"
