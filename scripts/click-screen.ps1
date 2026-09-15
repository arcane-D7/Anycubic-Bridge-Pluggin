Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CC {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, int e);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
    [StructLayout(LayoutKind.Sequential)] public struct P { public int x, y; }
}
'@
[CC]::SetCursorPos(316, 52) | Out-Null
Start-Sleep -Milliseconds 300
$p = New-Object CC+P
[CC]::GetCursorPos([ref]$p) | Out-Null
Write-Host "cursor at $($p.x),$($p.y)"
$h = [CC]::WindowFromPoint($p)
$sb = New-Object System.Text.StringBuilder 256
[CC]::GetWindowText($h, $sb, 256) | Out-Null
Write-Host "window under cursor: $($sb.ToString())"
# Click it
[CC]::mouse_event(2, 0, 0, 0, 0)
Start-Sleep -Milliseconds 70
[CC]::mouse_event(4, 0, 0, 0, 0)
Write-Host "clicked"
