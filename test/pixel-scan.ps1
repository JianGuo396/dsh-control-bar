Add-Type -AssemblyName System.Drawing
$p = Join-Path $args[0] 'shot3.png'
$bmp = [System.Drawing.Bitmap]::FromFile($p)
Write-Output ("image: {0}x{1}" -f $bmp.Width, $bmp.Height)

$cyan = @()
$warm = @()
$barBg = @()
for ($x = 0; $x -lt $bmp.Width; $x += 1) {
  for ($y = 4; $y -lt 34; $y += 2) {
    $c = $bmp.GetPixel($x, $y)
    # 百分比文字 #7fd0ff：亮青
    if ($c.B -gt 200 -and $c.G -gt 150 -and $c.R -lt 170) { $cyan += $x }
    # 峰时徽标文字 #ffcf7a：暖黄
    if ($c.R -gt 200 -and $c.G -gt 150 -and $c.G -lt 230 -and $c.B -lt 160) { $warm += $x }
  }
}
$bmp.Dispose()
if ($cyan.Count -gt 0) {
  $min = ($cyan | Measure-Object -Minimum).Minimum
  $max = ($cyan | Measure-Object -Maximum).Maximum
  Write-Output ("cyan pixels: {0}, x {1}..{2}" -f $cyan.Count, $min, $max)
} else { Write-Output 'cyan pixels: none' }
if ($warm.Count -gt 0) {
  $min = ($warm | Measure-Object -Minimum).Minimum
  $max = ($warm | Measure-Object -Maximum).Maximum
  Write-Output ("warm pixels: {0}, x {1}..{2}" -f $warm.Count, $min, $max)
} else { Write-Output 'warm pixels: none' }
