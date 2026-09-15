Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum3 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$targetPids = @(33172, 60708, 93004)
$fg = [WinEnum3]::GetForegroundWindow()
$cb = [WinEnum3+EnumWindowsProc]{ param($h, $l)
    if (-not [WinEnum3]::IsWindowVisible($h)) { return $true }
    $sbT = New-Object System.Text.StringBuilder 512
    [WinEnum3]::GetWindowText($h, $sbT, 512) | Out-Null
    $pidOut = 0
    [WinEnum3]::GetWindowThreadProcessId($h, [ref]$pidOut) | Out-Null
    if ($targetPids -contains $pidOut) {
        $r = New-Object WinEnum3+RECT
        [WinEnum3]::GetWindowRect($h, [ref]$r) | Out-Null
        $fgMark = if ($h -eq $fg) { " <== FOREGROUND" } else { "" }
        Write-Host ("pid=$pidOut hwnd=$h rect=$($r.Left),$($r.Top),$($r.Right),$($r.Bottom) title='$($sbT.ToString())'$fgMark")
    }
    return $true
}
[WinEnum3]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
Write-Host "foreground hwnd: $fg"
