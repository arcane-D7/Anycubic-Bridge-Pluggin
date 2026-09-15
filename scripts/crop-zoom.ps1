param(
    [int]$X = 2970, [int]$Y = 25, [int]$W = 260, [int]$H = 70, [double]$Scale = 3.0
)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::new((Join-Path $PSScriptRoot "..\.slicer-screen.png"))
$bmp = [System.Drawing.Bitmap]::new([int]($W * $Scale), [int]($H * $Scale))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$srcRect = [System.Drawing.Rectangle]::new($X, $Y, $W, $H)
$dstRect = [System.Drawing.Rectangle]::new(0, 0, $bmp.Width, $bmp.Height)
$g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$out = (Join-Path $PSScriptRoot "..\poc-output\slicer-btn-zoom.png")
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $src.Dispose()
Write-Host "zoomed -> $out ($($bmp.Width)x$($bmp.Height))"
