param([int]$OffsetX = 316, [int]$OffsetY = 52)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class NavO {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, int e);
    [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
}
'@
$p = Get-Process orca-slicer | Select-Object -First 1
[NavO]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 600
$r = New-Object NavO+R
[NavO]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$x = $r.L + $OffsetX
$y = $r.T + $OffsetY
[NavO]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 200
[NavO]::mouse_event(2, 0, 0, 0, 0)
Start-Sleep -Milliseconds 60
[NavO]::mouse_event(4, 0, 0, 0, 0)
Start-Sleep -Seconds 4
"clicked at window offset $OffsetX,$OffsetY"
