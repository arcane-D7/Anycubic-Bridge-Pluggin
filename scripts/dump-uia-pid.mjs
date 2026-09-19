// Dump UIA element names + control types in a slicer window by PID (read-only)
// Usage: node dump-uia-pid.mjs <pid> [substr]
import { execFileSync } from "node:child_process";
const pid = process.argv[2];
const substr = process.argv[3] || "";

const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$rootEl = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})
$els = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
foreach ($e in $els) {
  $n = $e.Current.Name
  $t = $e.Current.ControlType.ProgrammaticName
  if ('${substr}' -and $n -notlike '*${substr}*') { continue }
  $rect = $e.Current.BoundingRectangle
  '{0,-28} | {1,-14} | enabled={2} | offscreen={3} | x={4} y={5} w={6} h={7}' -f $n, $t, $e.Current.IsEnabled, $e.Current.IsOffscreen, [int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height
}
`;

try {
  const out = execFileSync("powershell", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", ps,
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  console.log(out.trim() || "(no elements matched)");
} catch (e) {
  console.error((e.stdout && e.stdout.toString()) || e.message);
  process.exit(1);
}
