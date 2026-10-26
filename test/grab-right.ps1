Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Output ("screen: {0}x{1} at {2},{3}" -f $bounds.Width, $bounds.Height, $bounds.X, $bounds.Y)
$stripW = 900
$stripH = 70
$x = [Math]::Max(0, $bounds.Width - $stripW)
$bmp = New-Object System.Drawing.Bitmap $stripW, $stripH
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, 0, 0, 0, $bmp.Size)
$out = Join-Path $args[0] 'shot4.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output $out
