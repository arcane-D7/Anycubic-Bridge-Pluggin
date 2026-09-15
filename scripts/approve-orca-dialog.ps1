Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FW2 { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
'@
$p = Get-Process orca-slicer | Where-Object { $_.MainWindowTitle -like "*permission*" } | Select-Object -First 1
if (-not $p) { "no dialog"; exit 0 }
[FW2]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
"ENTER sent"
Start-Sleep -Seconds 2
$check = Get-Process orca-slicer -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*permission*" }
if ($check) { "dialog STILL open" } else { "dialog CLOSED - approved" }
