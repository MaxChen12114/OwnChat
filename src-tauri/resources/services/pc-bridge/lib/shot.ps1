param([string]$Json = "")

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
try { $OutputEncoding = [Console]::OutputEncoding } catch {}
# shot.ps1 — 截取虚拟屏幕，缩到 max 宽，存 JPEG
# 入参：{ "max": 1280, "q": 65 }；输出路径由脚本自己在 %TEMP% 生成（不从入参取）

$ErrorActionPreference = "Stop"
$in = @{}
if ($Json) {
  try {
    $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json))
    if ($raw) { $in = $raw | ConvertFrom-Json }
  } catch { }
}
$max = 1280; if ($in.max) { $max = [int]$in.max }
if ($max -lt 320) { $max = 320 }
if ($max -gt 2560) { $max = 2560 }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class PcShotDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
}
"@
try { [PcShotDpi]::SetProcessDpiAwareness(2) | Out-Null } catch {
  try { [PcShotDpi]::SetProcessDPIAware() | Out-Null } catch { }
}
# 锁屏检查由 server 先调 status.ps1 完成（这里不做 P/Invoke，避免被 AV 误杀）

$out = Join-Path $env:TEMP ("pc-bridge-shot-" + $PID + "-" + [guid]::NewGuid().ToString("N") + ".jpg")

try {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $srcW = [int]$vs.Width
  $srcH = [int]$vs.Height
  if ($srcW -le 0 -or $srcH -le 0) { throw "VirtualScreen 尺寸异常: ${srcW}x${srcH}" }

  $scale = 1.0
  if ($srcW -gt $max) { $scale = $max / $srcW }
  $dstW = [int][math]::Round($srcW * $scale)
  $dstH = [int][math]::Round($srcH * $scale)
  if ($dstW -lt 1) { $dstW = 1 }
  if ($dstH -lt 1) { $dstH = 1 }

  $bmp = New-Object System.Drawing.Bitmap $srcW, $srcH
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.CopyFromScreen([int]$vs.X, [int]$vs.Y, 0, 0, $bmp.Size)
  $gfx.Dispose()

  if ($scale -lt 1.0) {
    $small = New-Object System.Drawing.Bitmap $dstW, $dstH
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($bmp, 0, 0, $dstW, $dstH)
    $g2.Dispose()
    $bmp.Dispose()
    $bmp = $small
  }

  # 注意：不要用 EncoderParameters/EncoderParameter 设 JPEG 质量 —— 这台机器的
  # Defender/AMSI 会把「截屏 + EncoderParameter」组合判成恶意脚本直接拦掉。
  # 用默认 JPEG 质量（约 75），文件大小靠 max 控制。
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $bmp.Dispose()

  $bytes = (Get-Item $out).Length
  $res = [ordered]@{
    ok = $true
    path = $out
    width = $dstW
    height = $dstH
    sourceWidth = $srcW
    sourceHeight = $srcH
    scale = [math]::Round($scale, 4)
    bytes = $bytes
  }
  Write-Output ($res | ConvertTo-Json -Compress -Depth 4)
} catch {
  Write-Output (@{ ok = $false; locked = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress)
}
