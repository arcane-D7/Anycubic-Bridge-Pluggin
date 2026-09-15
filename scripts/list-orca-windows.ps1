Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WE2 {
    public delegate bool P(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(P c, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
}
'@
$target = (Get-Process orca-slicer).Id
$cb = [WE2+P]{ param($h, $l)
    $wpid = 0
    [WE2]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
    if ([int]$wpid -eq $target -and [WE2]::IsWindowVisible($h)) {
        $sb = New-Object System.Text.StringBuilder 256
        [WE2]::GetWindowText($h, $sb, 256) | Out-Null
        $t = $sb.ToString()
        if ($t) { Write-Host "${h} : $t" }
    }
    return $true
}
[WE2]::EnumWindows($cb, [IntPtr]::Zero)
