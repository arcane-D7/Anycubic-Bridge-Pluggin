param()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$process = Get-Process -Name 'AnycubicSlicerNext' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $process) { '{"error":"not running"}'; exit }
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $process.Id)
$els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)

# List every named control (any name) with bounds — full inventory
$out = @()
foreach ($e in $els) {
    $n = $e.Current.Name
    if ($n -and $n.Length -gt 1) {
        $r = $e.Current.BoundingRectangle
        $out += [pscustomobject]@{ name = $n; type = $e.Current.ControlType.ProgrammaticName; id = $e.Current.AutomationId; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
    }
}
$out | ConvertTo-Json -Depth 3 -Compress
