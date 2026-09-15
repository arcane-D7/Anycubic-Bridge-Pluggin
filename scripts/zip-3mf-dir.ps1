# Repack a directory tree as a .3mf (zip) with .NET ZipArchive,
# entries relative (no ./ prefix); .gcode/.metadata stored uncompressed.
param(
  [Parameter(Mandatory=$true)][string]$SrcDir,
  [Parameter(Mandatory=$true)][string]$OutFile
)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
$outFull = (Resolve-Path (Split-Path $OutFile)).Path + '\' + (Split-Path $OutFile -Leaf)
$zip = [System.IO.Compression.ZipFile]::Open($outFull, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -Path $SrcDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($SrcDir.Length).TrimStart('\').Replace('\', '/')
    $level = if ($rel.EndsWith('.gcode') -or $rel.EndsWith('.metadata')) { [System.IO.Compression.CompressionLevel]::NoCompression } else { [System.IO.Compression.CompressionLevel]::Optimal }
    $entry = $zip.CreateEntry($rel, $level)
    $es = $entry.Open()
    try {
      $fs = [System.IO.File]::OpenRead($_.FullName)
      try { $fs.CopyTo($es) } finally { $fs.Dispose() }
    } finally { $es.Dispose() }
  }
} finally {
  $zip.Dispose()
}
Write-Output "packed $outFull"
