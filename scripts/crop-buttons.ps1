Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::new((Join-Path $PSScriptRoot "..\.slicer-screen.png"))
$X = 2870; $Y = 0; $W = 570; $H = 120; $Scale = 2.0
$bmp = [System.Drawing.Bitmap]::new([int]($W * $Scale), [int]($H * $Scale))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$srcRect = [System.Drawing.Rectangle]::new($X, $Y, $W, $H)
$dstRect = [System.Drawing.Rectangle]::new(0, 0, $bmp.Width, $bmp.Height)
$g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$out = (Join-Path $PSScriptRoot "..\poc-output\slicer-buttons.png")
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $src.Dispose()
Write-Host "cropped -> $out ($($bmp.Width)x$($bmp.Height))"
