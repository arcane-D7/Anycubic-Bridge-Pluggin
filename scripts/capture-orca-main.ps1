# Minimize the plugin panel window (Anycubic Cloud & Kobra S1) so the main
# OrcaSlicer window is reachable; then capture the MAIN window.
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinMain {
    public delegate bool P(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(P c, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$target = (Get-Process orca-slicer).Id
$main = [IntPtr]::Zero
$cb = [WinMain+P]{ param($h, $l)
    $wpid = 0
    [WinMain]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
    if ([int]$wpid -eq $target -and [WinMain]::IsWindowVisible($h)) {
        $sb = New-Object System.Text.StringBuilder 256
        [WinMain]::GetWindowText($h, $sb, 256) | Out-Null
        $t = $sb.ToString()
        Write-Host "${h} : $t"
        if ($t -like "Anycubic Cloud*") {
            [WinMain]::ShowWindowAsync($h, 6) | Out-Null
        } elseif ($t) {
            $r0 = New-Object WinMain+RECT
            [WinMain]::GetWindowRect($h, [ref]$r0) | Out-Null
            $area0 = ($r0.Right - $r0.Left) * ($r0.Bottom - $r0.Top)
            if ($area0 -gt 400000) { $script:main = $h }
        }
    }
    return $true
}
[WinMain]::EnumWindows($cb, [IntPtr]::Zero)

if ($main -ne [IntPtr]::Zero) {
    [WinMain]::SetForegroundWindow($main) | Out-Null
    Start-Sleep -Milliseconds 700
    $r = New-Object WinMain+RECT
    [WinMain]::GetWindowRect($main, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $h2 = $r.Bottom - $r.Top
    $b = New-Object System.Drawing.Bitmap($w, $h2)
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $b.Size)
    $b.Save((Join-Path $PSScriptRoot "..\.orca-main.png"))
    Write-Output "main captured ${w}x${h2} (panel minimized)"
} else {
    Write-Output "main window not found"
}
