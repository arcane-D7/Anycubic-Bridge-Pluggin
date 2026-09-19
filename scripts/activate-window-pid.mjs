// Activate a slicer window by PID, then optionally click a control by name in that window (PID-scoped).
// Usage: node activate-window-pid.mjs <pid> [click-name]
import { execFileSync } from "node:child_process";

const pid = process.argv[2];
const clickName = process.argv[3] || "";

const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class W32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
}
'@
$targetPid = __PID__
$p = Get-Process -Name 'AnycubicSlicerNext' -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq $targetPid } | Select-Object -First 1
if (-not $p) { 'NO_PROCESS ' + $targetPid; exit 1 }
[W32]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null
[W32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 700
'ACTIVATED pid=' + $p.Id + ' title=' + $p.MainWindowTitle
$targetName = __CLICKNAME__
if ($targetName -eq '') { exit 0 }
$rootEl = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
$els = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$btn = $null
foreach ($e in $els) { if ($e.Current.Name -like '*atiar*placa*' -and $e.Current.IsEnabled) { $btn = $e; break } }
if (-not $btn) { 'NO_ENABLED_BTN ' + $targetName + ' in pid ' + $p.Id; exit 2 }
$rect = $btn.Current.BoundingRectangle
$x = [int]($rect.X + $rect.Width / 2)
$y = [int]($rect.Y + $rect.Height / 2)
$cx = [System.Windows.Forms.Cursor]::Position.X
$cy = [System.Windows.Forms.Cursor]::Position.Y
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
Start-Sleep -Milliseconds 150
[W32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 60
[W32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 80
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($cx, $cy)
'CLICKED btn=' + $targetName + ' pid=' + $p.Id + ' method=mouse_event x=' + $x + ' y=' + $y
`;

const finalPs = ps
  .replaceAll("__PID__", JSON.stringify(pid))
  .replaceAll("__CLICKNAME__", JSON.stringify(clickName));

try {
  const out = execFileSync("powershell", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", finalPs,
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  console.log(out.trim());
} catch (e) {
  console.error((e.stdout && e.stdout.toString()) || e.message);
  process.exit(1);
}
