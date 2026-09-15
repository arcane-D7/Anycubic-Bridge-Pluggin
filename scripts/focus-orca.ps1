Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win32FW {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr h);
}
'@
$p = Get-Process orca-slicer -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p -and $p.MainWindowHandle -ne 0) {
    [Win32FW]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    "foreground: $($p.MainWindowTitle)"
} else {
    "no window"
}
