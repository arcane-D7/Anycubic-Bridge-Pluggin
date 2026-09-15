# Close stray dialogs (Save file as / Troubleshoot Center) of the Orca process,
# then click the Device tab on the main window and capture it.
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WC4 {
    public delegate bool P(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(P c, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l2);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, int e);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@

$targets = (Get-Process orca-slicer).Id
$main = [IntPtr]::Zero
$mainArea = 0
$cb = [WC4+P]{ param($h, $l)
    $wpid = 0
    [WC4]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
    if ($targets -contains [int]$wpid) {
        $sb = New-Object System.Text.StringBuilder 256
        [WC4]::GetWindowText($h, $sb, 256) | Out-Null
        $t = $sb.ToString()
        if ($t -eq "Save file as" -or $t -eq "Troubleshoot Center") {
            [WC4]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
            Write-Host "closed: $t"
        } elseif ($t -like "*OrcaSlicer*") {
            $r = New-Object WC4+RECT
            [WC4]::GetWindowRect($h, [ref]$r) | Out-Null
            $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
            if ($area -gt $mainArea) { $mainArea = $area; $main = $h }
        }
    }
    return $true
}
[WC4]::EnumWindows($cb, [IntPtr]::Zero)

if ($main -eq [IntPtr]::Zero) { Write-Host "no main window"; exit 1 }
Start-Sleep -Milliseconds 600
[WC4]::SetForegroundWindow($main) | Out-Null
Start-Sleep -Milliseconds 700

$r = New-Object WC4+RECT
[WC4]::GetWindowRect($main, [ref]$r) | Out-Null
Write-Host "main at $($r.Left),$($r.Top) size $($r.Right - $r.Left)x$($r.Bottom - $r.Top)"

# Device tab: proportional position ~ (316/3454, 59/1406) of the window
$x = $r.Left + [int](($r.Right - $r.Left) * (316.0 / 3454.0))
$y = $r.Top + [int](($r.Bottom - $r.Top) * (59.0 / 1406.0))
Write-Host "clicking Device tab at $x,$y"
[WC4]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 250
[WC4]::mouse_event(2, 0, 0, 0, 0)
Start-Sleep -Milliseconds 70
[WC4]::mouse_event(4, 0, 0, 0, 0)
Start-Sleep -Seconds 5

# capture
$b = New-Object System.Drawing.Bitmap(($r.Right - $r.Left), ($r.Bottom - $r.Top))
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $b.Size)
$b.Save((Join-Path $PSScriptRoot "..\.orca-main.png"))
Write-Output "captured device tab state"
