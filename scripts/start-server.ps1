$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $pluginRoot 'dist\server.mjs'

if (-not (Test-Path -LiteralPath $serverPath)) {
    throw "Built MCP server not found at $serverPath. Run 'pnpm install' and 'pnpm run build' in the plugin directory."
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundledNode) {
        $node = Get-Item -LiteralPath $bundledNode
    }
}

if (-not $node) {
    throw 'Node.js 22 or newer was not found. Install Node.js or make node.exe available on PATH.'
}

$nodePath = if ($node.Source) { $node.Source } else { $node.FullName }
& $nodePath $serverPath
exit $LASTEXITCODE
