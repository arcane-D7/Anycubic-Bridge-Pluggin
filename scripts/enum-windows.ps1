Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum2 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$targetPids = @(33172, 60708, 93004)
$results = New-Object System.Collections.ArrayList
$cb = [WinEnum2+EnumWindowsProc]{ param($h, $l)
    $sbT = New-Object System.Text.StringBuilder 512
    $sbC = New-Object System.Text.StringBuilder 256
    [WinEnum2]::GetWindowText($h, $sbT, 512) | Out-Null
    [WinEnum2]::GetClassName($h, $sbC, 256) | Out-Null
    $pidOut = 0
    [WinEnum2]::GetWindowThreadProcessId($h, [ref]$pidOut) | Out-Null
    if ($targetPids -contains $pidOut) {
        $vis = [WinEnum2]::IsWindowVisible($h)
        $r = New-Object WinEnum2+RECT
        [WinEnum2]::GetWindowRect($h, [ref]$r) | Out-Null
        [void]$results.Add("pid=$pidOut hwnd=$h vis=$vis rect=$($r.Left),$($r.Top),$($r.Right),$($r.Bottom) title='$($sbT.ToString())' class=$($sbC.ToString())")
    }
    return $true
}
[WinEnum2]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$results | ForEach-Object { Write-Host $_ }
