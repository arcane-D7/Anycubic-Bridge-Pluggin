param(
    [string]$Src = (Join-Path $PSScriptRoot "..\.slicer-screen.png"),
    [string]$Out = (Join-Path $PSScriptRoot "..\poc-output\slicer-buttons.png"),
    [int]$X = 2870, [int]$Y = 0, [int]$W = 570, [int]$H = 120,
    [double]$Scale = 2.0
)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($Src)
$bmp = New-Object System.Drawing.Bitmap([int]($W * $Scale), [int]($H * $Scale))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$srcRect = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
$dstRect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
$g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $src.Dispose()
Write-Host "cropped $X,$Y ${W}x${H} scale=$Scale -> $Out"
