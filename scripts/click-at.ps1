param([int]$X = 2297, [int]$Y = 68)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win32Click {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
}
'@
[Win32Click]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 250
[Win32Click]::mouse_event(2, 0, 0, 0, 0)
Start-Sleep -Milliseconds 70
[Win32Click]::mouse_event(4, 0, 0, 0, 0)
"clicked at $X,$Y"
