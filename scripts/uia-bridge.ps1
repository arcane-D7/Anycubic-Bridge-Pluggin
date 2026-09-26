param(
    [ValidateSet('inspect', 'activate', 'tree', 'read', 'click', 'type', 'key')]
    [string]$Action = 'inspect',
    [string]$ClickName = '',
    [string]$Text = '',
    [string]$Key = '',
    [int]$ProcessId = 0,
    [int]$MaxDepth = 8,
    [int]$MaxChildren = 200
)

# Accented control names (e.g. "Fatiar Disco Único") get mangled when passed as
# command-line arguments to powershell.exe. The TS wrapper therefore passes the
# name through env instead; prefer it when present. Same idea for type text and
# keys, which are ASCII-only anyway but kept consistent here.
if (-not $ClickName -and $env:UIA_BRIDGE_CLICK_NAME) { $ClickName = $env:UIA_BRIDGE_CLICK_NAME }
if (-not $Text -and $env:UIA_BRIDGE_TEXT) { $Text = $env:UIA_BRIDGE_TEXT }
if (-not $Key -and $env:UIA_BRIDGE_KEY) { $Key = $env:UIA_BRIDGE_KEY }

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AnycubicWindowApi {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern uint SendInput(uint cInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
}
'@

$processes = @(Get-Process -Name 'AnycubicSlicerNext' -ErrorAction SilentlyContinue | Where-Object { $ProcessId -eq 0 -or $_.Id -eq $ProcessId })
if ($processes.Count -eq 0) {
    [pscustomobject]@{
        available = $true
        running = $false
        windows = @()
        note = 'Anycubic Slicer Next is not running.'
    } | ConvertTo-Json -Depth 6 -Compress
    exit 0
}

$root = [System.Windows.Automation.AutomationElement]::RootElement

function Get-AppElements {
    $all = @()
    foreach ($process in $processes) {
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
            $process.Id
        )
        $all += $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    }
    , $all
}

function Get-AppElementsByName([string]$name) {
    $found = @()
    foreach ($element in (Get-AppElements)) {
        if ($element.Current.Name -eq $name) { $found += $element }
    }
    , $found
}

# ASCII-fold a name so accented aliases match even if the file or the env var
# lost its non-ASCII characters (PowerShell 5.1 reads .ps1 without BOM as ANSI).
function Get-Folded([string]$value) {
    if (-not $value) { return "" }
    $folded = $value.Normalize([System.Text.NormalizationForm]::FormD)
    $builder = New-Object System.Text.StringBuilder
    foreach ($char in $folded.ToCharArray()) {
        $category = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($char)
        if ($category -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$builder.Append($char)
        }
    }
    return $builder.ToString().ToLowerInvariant()
}

function Get-ProcessByWindow($windowHandle) {
    $process = Get-Process | Where-Object { $_.MainWindowHandle -eq $windowHandle } | Select-Object -First 1
    $process
}

switch ($Action) {
    'activate' {
        $candidate = $processes | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if (-not $candidate) { throw 'Anycubic Slicer Next is running but no top-level window handle is available.' }
        [AnycubicWindowApi]::ShowWindowAsync($candidate.MainWindowHandle, 9) | Out-Null
        $activated = [AnycubicWindowApi]::SetForegroundWindow($candidate.MainWindowHandle)
        [pscustomobject]@{ available = $true; running = $true; activated = $activated } | ConvertTo-Json -Compress
        break
    }

    'inspect' {
        $aliases = @(
            'Slice plate', 'Slice all', 'Fatiar Disco Único', 'Fatiar todos',
            'Fatiar 1 placa', 'Fatiar todas as placas',
            'Save Project', 'Salvar Projeto', 'Export G-code', 'Exportar G-code',
            'Layer height', 'Altura da camada', 'Infill density', 'Densidade de preenchimento',
            'Support', 'Suporte', 'Wall loops', 'Paredes'
        )
        $windows = @()
        $matched = @()
        foreach ($process in $processes) {
            $condition = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
                $process.Id
            )
            $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
            $windows += [pscustomobject]@{
                processId = $process.Id
                mainWindowTitle = $process.MainWindowTitle
                mainWindowHandle = $process.MainWindowHandle.ToInt64()
                elementCount = $elements.Count
            }
            foreach ($element in $elements) {
                if ($aliases -contains $element.Current.Name) {
                    $rect = $element.Current.BoundingRectangle
                    $matched += [pscustomobject]@{
                        processId = $process.Id
                        name = $element.Current.Name
                        automationId = $element.Current.AutomationId
                        controlType = $element.Current.ControlType.ProgrammaticName
                        enabled = $element.Current.IsEnabled
                        offscreen = $element.Current.IsOffscreen
                        bounds = [pscustomobject]@{ x = $rect.X; y = $rect.Y; width = $rect.Width; height = $rect.Height }
                    }
                }
            }
        }
        [pscustomobject]@{
            available = $true
            running = $true
            windows = $windows
            matchedControls = $matched
            note = 'Read-only UIA inspection. Use tree/read for deeper access, click/type/key for safe actions.'
        } | ConvertTo-Json -Depth 8 -Compress
        break
    }

    'tree' {
        function Convert-Tree($element, [int]$depth, [int]$maxDepth, [int]$maxChildren) {
            if ($depth -gt $maxDepth) { return $null }
            $rect = $element.Current.BoundingRectangle
            $node = [ordered]@{
                name = $element.Current.Name
                automationId = $element.Current.AutomationId
                controlType = $element.Current.ControlType.ProgrammaticName
                enabled = $element.Current.IsEnabled
                offscreen = $element.Current.IsOffscreen
                bounds = [pscustomobject]@{ x = [int]$rect.X; y = [int]$rect.Y; width = [int]$rect.Width; height = [int]$rect.Height }
            }
            $childList = @()
            $count = 0
            try {
                $found = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
                $count = $found.Count
                foreach ($child in $found) {
                    if ($count -gt $maxChildren) { break }
                    $sub = Convert-Tree $child ($depth + 1) $maxDepth $maxChildren
                    if ($null -ne $sub) { $childList += $sub }
                }
            } catch {
                $count = -1
            }
            $node.children = $childList
            $node.childCount = $count
            return $node
        }
        $windowsData = @()
        foreach ($process in $processes) {
            $condition = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
                $process.Id
            )
            $windowEl = $null
            try {
                $windowEl = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
            } catch { }
            if ($windowEl) {
                $windowsData += [ordered]@{
                    processId = $process.Id
                    title = $process.MainWindowTitle
                    handle = $process.MainWindowHandle.ToInt64()
                    tree = Convert-Tree $windowEl 0 $MaxDepth $MaxChildren
                }
            }
        }
        [pscustomobject]@{
            available = $true
            running = $true
            windows = $windowsData
        } | ConvertTo-Json -Depth 14 -Compress
        break
    }

    'read' {
        $readable = [System.Collections.Generic.List[object]]::new()
        foreach ($process in $processes) {
            $condition = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
                $process.Id
            )
            $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
            foreach ($element in $elements) {
                $name = $element.Current.Name
                if (-not $name) { continue }
                $value = $null
                try {
                    $pattern = $null
                    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                        $value = $pattern.Current.Value
                    }
                } catch { }
                if ($value) {
                    $readable.Add([pscustomobject]@{
                        processId = $process.Id
                        name = $name
                        value = $value
                        automationId = $element.Current.AutomationId
                        controlType = $element.Current.ControlType.ProgrammaticName
                    })
                }
            }
        }
        [pscustomobject]@{
            available = $true
            running = $true
            controls = $readable
        } | ConvertTo-Json -Depth 8 -Compress
        break
    }

    'click' {
        # Safe list is ASCII-folded so "Fatiar Disco Unico" (env-var/decode
        # mangled) matches the intended "Fatiar Disco Único" (true UIA name).
        $safeFolded = @(
            'preparar', 'prepare',
            'fatiar disco unico', 'fatiar todos',
            'fatiar 1 placa', 'fatiar todas as placas',
            'slice plate', 'slice all',
            'salvar projeto', 'save project',
            'exportar g-code', 'export g-code'
        )
        $clickFolded = Get-Folded $ClickName
        if ($safeFolded -notcontains $clickFolded) {
            [pscustomobject]@{ available = $true; running = $true; clicked = $false; error = "Unsafe UIA click target: '$ClickName'. Allowed: $($safeFolded -join ', ')" } | ConvertTo-Json -Compress
            break
        }
        # Find by folded match against real control names (which retain accents).
        $found = @()
        $elements = Get-AppElements
        foreach ($element in $elements) {
            if ((Get-Folded $element.Current.Name) -eq $clickFolded) { $found += $element }
        }
        if ($found.Count -eq 0) {
            [pscustomobject]@{ available = $true; running = $true; clicked = $false; error = "No control named '$ClickName' found." } | ConvertTo-Json -Compress
            break
        }
        $target = $found[0]
        $invoke = $null
        $clicked = $false
        try {
            if ($target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
                $invoke.Invoke()
                $clicked = $true
            }
        } catch {
            $clicked = $false
        }
        if (-not $clicked) {
            try {
                # Fallback 1: mouse_event (SendInput can be blocked when the
                # target window was activated by another process moments before).
                $rect = $target.Current.BoundingRectangle
                $x = [int]($rect.X + $rect.Width / 2)
                $y = [int]($rect.Y + $rect.Height / 2)
                $cx = [System.Windows.Forms.Cursor]::Position.X
                $cy = [System.Windows.Forms.Cursor]::Position.Y
                [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
                Start-Sleep -Milliseconds 150
                [AnycubicWindowApi]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero) | Out-Null  # LEFTDOWN
                Start-Sleep -Milliseconds 60
                [AnycubicWindowApi]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero) | Out-Null  # LEFTUP
                Start-Sleep -Milliseconds 80
                [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($cx, $cy)
                $clicked = $true
            } catch {
                $clicked = $false
            }
        }
        if (-not $clicked) {
            try {
                # Fallback 2: legacy SendInput path
                $rect = $target.Current.BoundingRectangle
                $x = [int]($rect.X + $rect.Width / 2)
                $y = [int]($rect.Y + $rect.Height / 2)
                [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
                Start-Sleep -Milliseconds 100
                $inputDown = New-Object AnycubicWindowApi+INPUT
                $inputDown.type = 0
                $inputDown.U.mi.dwFlags = 0x0002 # LEFTDOWN
                [AnycubicWindowApi]::SendInput(1, [AnycubicWindowApi+INPUT[]]@($inputDown), [System.Runtime.InteropServices.Marshal]::SizeOf([AnycubicWindowApi+INPUT])) | Out-Null
                $inputUp = New-Object AnycubicWindowApi+INPUT
                $inputUp.type = 0
                $inputUp.U.mi.dwFlags = 0x0004 # LEFTUP
                [AnycubicWindowApi]::SendInput(1, [AnycubicWindowApi+INPUT[]]@($inputUp), [System.Runtime.InteropServices.Marshal]::SizeOf([AnycubicWindowApi+INPUT])) | Out-Null
                $clicked = $true
            } catch {
                $clicked = $false
            }
        }
        [pscustomobject]@{
            available = $true
            running = $true
            clicked = $clicked
            target = $ClickName
            error = if ($clicked) { $null } else { 'InvokePattern not available and bounding click failed.' }
        } | ConvertTo-Json -Compress
        break
    }

    'type' {
        $accepted = [System.Text.RegularExpressions.Regex]::IsMatch($Text, '^[\x20-\x7E]+$')
        if (-not $accepted) {
            [pscustomobject]@{ available = $true; running = $true; error = 'Only printable ASCII text can be typed.' } | ConvertTo-Json -Compress
            break
        }
        try {
            [System.Windows.Forms.SendKeys]::SendWait([string]::Escape($Text))
            [pscustomobject]@{ available = $true; running = $true; typedLength = $Text.Length } | ConvertTo-Json -Compress
        } catch {
            [pscustomobject]@{ available = $true; running = $true; error = $_.Exception.Message } | ConvertTo-Json -Compress
        }
        break
    }

    'key' {
        $validKeys = @('Enter', 'Tab', 'Escape', 'Space', 'Up', 'Down', 'Left', 'Right', 'Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+O', 'Ctrl+P', 'F5', 'Home', 'End', 'PageUp', 'PageDown')
        if ($validKeys -notcontains $Key) {
            [pscustomobject]@{ available = $true; running = $true; error = "Unsafe UIA key: '$Key'. Allowed: $($validKeys -join ', ')" } | ConvertTo-Json -Compress
            break
        }
        try {
            [System.Windows.Forms.SendKeys]::SendWait("{$Key}")
            [pscustomobject]@{ available = $true; running = $true; key = $Key } | ConvertTo-Json -Compress
        } catch {
            [pscustomobject]@{ available = $true; running = $true; error = $_.Exception.Message } | ConvertTo-Json -Compress
        }
        break
    }

    default {
        [pscustomobject]@{ available = $true; running = $true; error = "Unknown action: $Action" } | ConvertTo-Json -Compress
    }
}
