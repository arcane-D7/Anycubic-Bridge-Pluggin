param([int]$X = 0, [int]$Y = 0)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CC3 {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, int e);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int m);
    [StructLayout(LayoutKind.Sequential)] public struct P { public int x, y; }
}
'@
[CC3]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 300
$p = New-Object CC3+P
[CC3]::GetCursorPos([ref]$p) | Out-Null
Write-Host "cursor at $($p.x),$($p.y)"
$h = [CC3]::WindowFromPoint($p)
$sb = New-Object System.Text.StringBuilder 256
[CC3]::GetWindowText($h, $sb, 256) | Out-Null
Write-Host "window under cursor: [$($sb.ToString())]"
if ($X -gt 0 -and $Y -gt 0) {
    [CC3]::mouse_event(2, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 70
    [CC3]::mouse_event(4, 0, 0, 0, 0)
    Write-Host "clicked"
}
