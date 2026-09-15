param([string]$OutFile = (Join-Path $PSScriptRoot "..\.orca-window.png"))
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinCap2 {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$p = Get-Process orca-slicer | Select-Object -First 1
$r = New-Object WinCap2+RECT
[WinCap2]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h2 = $r.Bottom - $r.Top
$b = New-Object System.Drawing.Bitmap($w, $h2)
$g = [System.Drawing.Graphics]::FromImage($b)
$dc = $g.GetHdc()
# PW_RENDERFULLCONTENT = 2 (captures DirectX/webview content)
[WinCap2]::PrintWindow($p.MainWindowHandle, $dc, 2) | Out-Null
$g.ReleaseHdc($dc)
$b.Save($OutFile)
"saved ${w}x${h2} (PrintWindow)"
