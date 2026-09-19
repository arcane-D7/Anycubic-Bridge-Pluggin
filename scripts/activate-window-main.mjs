// Activate a slicer window by title, then optionally click a control by name in that window (PID-scoped).
// Usage: node specific-window.mjs <title-substring> [click-name]
import { execFileSync } from "node:child_process";

const target = process.argv[2];
const clickName = process.argv[3] || "";

const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class W32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@
$procs = @(Get-Process -Name 'AnycubicSlicerNext' -ErrorAction SilentlyContinue)
$match = $procs | Where-Object { $_.MainWindowTitle -like '*$target*' } | Select-Object -First 1
if (-not $match) { 'NO_WINDOW_MATCH'; exit 1 }
[W32]::ShowWindowAsync($match.MainWindowHandle, 9) | Out-Null
[W32]::SetForegroundWindow($match.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 700
'ACTIVATED pid=' + $match.Id + ' title=' + $match.MainWindowTitle
if ('$clickName') {
  $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $match.Id)
  $els = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $btn = $null
  foreach ($e in $els) { if ($e.Current.Name -eq '$clickName' -and $e.Current.IsEnabled) { $btn = $e; break } }
  if (-not $btn) { 'NO_ENABLED_BTN ' + '$clickName' + ' in pid ' + $match.Id; exit 2 }
  $rect = $btn.Current.BoundingRectangle
  # invoke via the Invoke pattern if available
  $invoke = $false
  try { $pattern = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $pattern.Invoke(); $invoke = $true } catch {}
  'CLICKED btn=' + '$clickName' + ' pid=' + $match.Id + ' invoke=' + $invoke
}
`;

try {
  const out = execFileSync("powershell", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", ps,
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  console.log(out.trim());
} catch (e) {
  console.error(e.stdout?.toString() || e.message);
  process.exit(1);
}
