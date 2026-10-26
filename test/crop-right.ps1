Add-Type -AssemblyName System.Drawing
$src = Join-Path $args[0] 'shot3.png'
$img = [System.Drawing.Image]::FromFile($src)
# 取右侧 360x60 一段，放大 3 倍看清楚百分比与峰谷徽标
$rect = New-Object System.Drawing.Rectangle ($img.Width - 360), 0, 360, 56
$crop = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $rect.Width, $rect.Height), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$zoomed = New-Object System.Drawing.Bitmap ($rect.Width * 3), ($rect.Height * 3)
$g2 = [System.Drawing.Graphics]::FromImage($zoomed)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g2.DrawImage($crop, 0, 0, $zoomed.Width, $zoomed.Height)
$g2.Dispose()
$out = Join-Path $args[0] 'shot3-right.png'
$zoomed.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$img.Dispose()
$crop.Dispose()
$zoomed.Dispose()
Write-Output $out
