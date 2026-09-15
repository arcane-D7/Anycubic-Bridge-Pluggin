# UIA: find the Device tab in the Orca main window using a shallow scope and
# cache-first tree walking (avoids the RPC_E_SERVERFAULT from a full Descendants walk).
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$p = Get-Process orca-slicer | Where-Object { $_.MainWindowTitle -like "*OrcaSlicer*" } | Select-Object -First 1
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$p.MainWindowHandle)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Output "window not found"; exit 1 }

function Walk($el, $depth) {
    if ($depth -gt 5) { return }
    try {
        $n = $el.Current.Name
        $t = $el.Current.ControlType.ProgrammaticName
        if ($n -eq "Device" -or $n -eq "Dispositivo") {
            $r = $el.Current.BoundingRectangle
            Write-Output ("FOUND: {0} | {1} | x={2} y={3} w={4} h={5} | handle={6}" -f $n, $t, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height, $el.Current.NativeWindowHandle)
        }
        $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($c in $children) { Walk $c ($depth + 1) }
    } catch { }
}
Walk $win 0
Write-Output "walk done"
