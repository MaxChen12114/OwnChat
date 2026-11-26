param([string]$Json = "")

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
try { $OutputEncoding = [Console]::OutputEncoding } catch {}
# status.ps1 — 屏幕尺寸 / 锁屏 / 前台窗口 / DPI
# 输出单行 JSON。所有 pc-bridge lib 统一用 -Json <base64> 传参。

$ErrorActionPreference = "Stop"
$in = @{}
if ($Json) {
  try {
    $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json))
    if ($raw) { $in = $raw | ConvertFrom-Json }
  } catch { }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class PcDeskState {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
}
"@

try { [PcDeskState]::SetProcessDpiAwareness(2) | Out-Null } catch {
  try { [PcDeskState]::SetProcessDPIAware() | Out-Null } catch { }
}

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$fg = [PcDeskState]::GetForegroundWindow()

$title = ""
$procId = 0
$procName = ""
if ($fg -ne [IntPtr]::Zero) {
  $sb = New-Object System.Text.StringBuilder 512
  [PcDeskState]::GetWindowText($fg, $sb, 512) | Out-Null
  $title = $sb.ToString()
  [PcDeskState]::GetWindowThreadProcessId($fg, [ref]$procId) | Out-Null
  if ($procId -gt 0) {
    try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $procName = "" }
  }
}

# OpenInputDesktop 在锁屏/安全桌面下拿不到句柄
$h = [PcDeskState]::OpenInputDesktop(0, $false, 0x0100)
$locked = ($h -eq [IntPtr]::Zero)
if (-not $locked) { [PcDeskState]::CloseDesktop($h) | Out-Null }

$dpi = 96
if ($fg -ne [IntPtr]::Zero) {
  try { $d = [PcDeskState]::GetDpiForWindow($fg); if ($d -gt 0) { $dpi = [int]$d } } catch { }
}

$out = [ordered]@{
  ok = $true
  screen = [ordered]@{
    x = [int]$vs.X; y = [int]$vs.Y; width = [int]$vs.Width; height = [int]$vs.Height
  }
  dpi = $dpi
  scale = [math]::Round($dpi / 96.0, 2)
  locked = $locked
  foreground = [ordered]@{
    hwnd = [int64]$fg
    title = $title
    pid = [int]$procId
    process = $procName
  }
}
Write-Output ($out | ConvertTo-Json -Compress -Depth 6)
