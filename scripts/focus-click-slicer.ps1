param(
    [int]$X = 3082,
    [int]$Y = 49,
    [int]$ProcessId = 33172,
    [string]$Mode = "click"
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FCS {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$h = (Get-Process -Id $ProcessId).MainWindowHandle
Write-Host "main handle: $h"
[FCS]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
[FCS]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 600
$fg = [FCS]::GetForegroundWindow()
Write-Host "foreground now: $fg (target $h)"
$r = New-Object FCS+RECT
[FCS]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Host "window rect: L=$($r.Left) T=$($r.Top) R=$($r.Right) B=$($r.Bottom)"

if ($Mode -eq "click") {
    # absolute screen coords
    [FCS]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 400
    [FCS]::mouse_event(2, 0, 0, 0, 0)  # LEFTDOWN
    Start-Sleep -Milliseconds 90
    [FCS]::mouse_event(4, 0, 0, 0, 0)  # LEFTUP
    Write-Host "clicked at $X,$Y"
} elseif ($Mode -eq "rel") {
    # relative to window client origin (window rect top-left)
    $ax = $r.Left + $X
    $ay = $r.Top + $Y
    [FCS]::SetCursorPos($ax, $ay) | Out-Null
    Start-Sleep -Milliseconds 400
    [FCS]::mouse_event(2, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 90
    [FCS]::mouse_event(4, 0, 0, 0, 0)
    Write-Host "clicked at abs ${ax},${ay}"
}
