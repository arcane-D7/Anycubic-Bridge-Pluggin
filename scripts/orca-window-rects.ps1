Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WR2 {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
    [StructLayout(LayoutKind.Sequential)] public struct R { public int L; public int T; public int Rt; public int B; }
}
'@
Get-Process orca-slicer | ForEach-Object {
    $h = $_.MainWindowHandle
    $r = New-Object WR2+R
    [WR2]::GetWindowRect($h, [ref]$r) | Out-Null
    Write-Host "$($_.Id) [$($_.MainWindowTitle)] @ $($r.L),$($r.T) size $($r.Rt - $r.L)x$($r.B - $r.T)"
}
