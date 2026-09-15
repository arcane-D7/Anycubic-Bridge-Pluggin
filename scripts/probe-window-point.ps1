Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Probe {
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$pts = @(@(3089,56), @(3080,70), @(3100,40), @(3090,60), @(3050,72), @(1600,50))
foreach ($p in $pts) {
    $pt = New-Object Probe+POINT
    $pt.X = $p[0]; $pt.Y = $p[1]
    $h = [Probe]::WindowFromPoint($pt)
    $procId = 0
    [Probe]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $sb = New-Object System.Text.StringBuilder 256
    [Probe]::GetWindowText($h, $sb, 256) | Out-Null
    $r = New-Object Probe+RECT
    [Probe]::GetWindowRect($h, [ref]$r) | Out-Null
    $fg = [Probe]::GetForegroundWindow()
    Write-Host ("pt=$($p[0]),$($p[1]) -> hwnd=$h pid=$procId title='$($sb.ToString())' rect=$($r.Left),$($r.Top),$($r.Right),$($r.Bottom) isFg=$($fg -eq $h)")
}
Write-Host "foreground hwnd: $([Probe]::GetForegroundWindow())"
