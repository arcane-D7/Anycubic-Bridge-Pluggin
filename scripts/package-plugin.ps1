param(
    [string]$OutputPath,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$pluginName = 'anycubic-slicer-next-control'
if (-not $OutputPath) {
    $OutputPath = Join-Path (Split-Path -Parent $pluginRoot) "$pluginName-0.1.0.zip"
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)

if (Test-Path -LiteralPath $OutputPath) {
    if (-not $Force) {
        throw "Package already exists at $OutputPath. Pass -Force to replace it."
    }
    Remove-Item -LiteralPath $OutputPath -Force
}

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$stagingRoot = Join-Path $temporaryBase ("anycubic-plugin-package-" + [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $stagingRoot $pluginName

try {
    New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null
    foreach ($directory in @('.codex-plugin', 'docs', 'schemas', 'skills')) {
        Copy-Item -LiteralPath (Join-Path $pluginRoot $directory) -Destination $packageRoot -Recurse
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot 'dist'), (Join-Path $packageRoot 'scripts') | Out-Null
    Copy-Item -LiteralPath (Join-Path $pluginRoot 'dist\server.mjs') -Destination (Join-Path $packageRoot 'dist\server.mjs')
    Copy-Item -LiteralPath (Join-Path $pluginRoot 'scripts\start-server.ps1') -Destination (Join-Path $packageRoot 'scripts\start-server.ps1')
    Copy-Item -LiteralPath (Join-Path $pluginRoot 'scripts\uia-bridge.ps1') -Destination (Join-Path $packageRoot 'scripts\uia-bridge.ps1')
    foreach ($file in @('.mcp.json', 'README.md', 'LICENSE')) {
        Copy-Item -LiteralPath (Join-Path $pluginRoot $file) -Destination $packageRoot
    }
    Compress-Archive -LiteralPath $packageRoot -DestinationPath $OutputPath -CompressionLevel Optimal
    Get-Item -LiteralPath $OutputPath
}
finally {
    $resolvedStaging = [System.IO.Path]::GetFullPath($stagingRoot)
    if ($resolvedStaging.StartsWith($temporaryBase, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedStaging)) {
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
    }
}
