param([string]$OutDir = '.')
Add-Type -AssemblyName System.Drawing
# 关键：PowerShell 默认是 DPI-unaware 进程，150% 缩放下 GetSystemMetrics/截图
# 都拿到「虚拟化」尺寸(1707x1067)，会把 2560 宽屏幕截成左边 2/3，右端的百分比
# 和峰谷徽标就"消失"了。SetProcessDPIAware 之后坐标才是真实物理像素。
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class Dpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[Dpi]::SetProcessDPIAware() | Out-Null

Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Output ("screen: {0}x{1}" -f $b.Width, $b.Height)

$h = 60
$bmp = New-Object System.Drawing.Bitmap $b.Width, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
$out = Join-Path $OutDir 'shot3.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output $out
