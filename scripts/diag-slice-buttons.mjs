// Find which AnycubicSlicerNext windows expose a Slice button and its enabled state
import { execFileSync } from "node:child_process";
const ps = `
Add-Type -AssemblyName UIAutomationClient;
$root = [System.Windows.Automation.AutomationElement]::RootElement;
$procs = Get-Process -Name 'AnycubicSlicerNext' -ErrorAction SilentlyContinue;
if (-not $procs) { 'no slicer process'; exit }
foreach ($p in $procs) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id);
  $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond);
  foreach ($e in $els) {
    if ($e.Current.Name -match 'Fatiar|Slice|Export|Exportar|Salvar') {
      'pid={0} | type={1} | name={2} | enabled={3} | offscreen={4}' -f $p.Id, $e.Current.ControlType.ProgrammaticName, $e.Current.Name, $e.Current.IsEnabled, $e.Current.IsOffscreen
    }
  }
}
`;
try {
  const out = execFileSync("powershell", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", ps,
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  console.log(out);
} catch (e) {
  console.error("ERR", e.message);
  process.exit(1);
}
