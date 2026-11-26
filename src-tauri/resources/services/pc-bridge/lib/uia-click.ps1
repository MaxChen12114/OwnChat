param([string]$Json = "")

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
try { $OutputEncoding = [Console]::OutputEncoding } catch {}
# uia-click.ps1 — 按控件名点击（优先 InvokePattern，退化为点中心）
# 入参：{ "name":"下载", "type":"Button", "exact":true, "index":0 }
# 返回：{ ok, method:"invoke|select|click", type, name, x,y,w,h }
# 多个匹配且没给 index：返回 { ok:false, error:"multiple", candidates:[...] }，让 agent 换更精确的名字。

$ErrorActionPreference = "Stop"
$in = @{}
if ($Json) {
  try {
    $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json))
    if ($raw) { $in = $raw | ConvertFrom-Json }
  } catch { }
}
$name = [string]$in.name
$type = [string]$in.type
$exact = $true
if ($null -ne $in.exact) { $exact = [bool]$in.exact }
$index = -1
if ($null -ne $in.index) { $index = [int]$in.index }

if (-not $name) {
  Write-Output (@{ ok = $false; error = "name 必填" } | ConvertTo-Json -Compress)
  exit 0
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class PcUiaClick {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)]
  public struct PcRect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out PcRect lpRect);
  public static PcRect GetRect(IntPtr hWnd) { PcRect r; GetWindowRect(hWnd, out r); return r; }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@
try { [PcUiaClick]::SetProcessDpiAwareness(2) | Out-Null } catch { try { [PcUiaClick]::SetProcessDPIAware() | Out-Null } catch { } }

$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$TW = [System.Windows.Automation.TreeWalker]

$win = $null
try {
  $hfg = [PcUiaClick]::GetForegroundWindow()
  if ($hfg -ne [IntPtr]::Zero) { $win = $A::FromHandle($hfg) }
} catch { }
if (-not $win) {
  $fg = $null
  try { $fg = $A::FocusedElement } catch { }
  $el = $fg
  for ($i = 0; $i -lt 12 -and $el; $i++) {
    try {
      if ($el.Current.ControlType -eq $CT::Window) { $win = $el; break }
      $el = $TW::ControlViewWalker.GetParent($el)
    } catch { break }
  }
}
if (-not $win) {
  Write-Output (@{ ok = $false; error = "拿不到前台窗口（可能锁屏）" } | ConvertTo-Json -Compress)
  exit 0
}

# 统一到物理像素（与 pc_click / 截图同一套坐标）
$wc = $win.Current
$winRectUIA = $wc.BoundingRectangle
$winHwnd = [IntPtr][int64]$wc.NativeWindowHandle
$winPhysL = 0; $winPhysT = 0; $winPhysR = 0; $winPhysB = 0
$hasPhys = $false
if ($winHwnd -ne [IntPtr]::Zero) {
  try {
    $pr = [PcUiaClick]::GetRect($winHwnd)
    $winPhysL = $pr.Left; $winPhysT = $pr.Top; $winPhysR = $pr.Right; $winPhysB = $pr.Bottom
    $hasPhys = (($winPhysR - $winPhysL) -gt 0 -and ($winPhysB - $winPhysT) -gt 0)
  } catch { $hasPhys = $false }
}
$physW = 0; $physH = 0
if ($hasPhys) { $physW = $winPhysR - $winPhysL; $physH = $winPhysB - $winPhysT }
$uiaW = [double]$winRectUIA.Width; $uiaH = [double]$winRectUIA.Height
$sx = 1.0; $sy = 1.0
if ($uiaW -gt 0 -and $uiaH -gt 0 -and $physW -gt 0 -and $physH -gt 0) {
  $sx = $physW / $uiaW; $sy = $physH / $uiaH
  if ([math]::Abs($sx - 1.0) -lt 0.03) { $sx = 1.0 }
  if ([math]::Abs($sy - 1.0) -lt 0.03) { $sy = 1.0 }
}
function MapRect($r) {
  if ($hasPhys) {
    return [ordered]@{
      x = [int][math]::Round($winPhysL + (([double]$r.X) - [double]$winRectUIA.X) * $sx)
      y = [int][math]::Round($winPhysT + (([double]$r.Y) - [double]$winRectUIA.Y) * $sy)
      w = [int][math]::Round(([double]$r.Width) * $sx)
      h = [int][math]::Round(([double]$r.Height) * $sy)
    }
  }
  return [ordered]@{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
}

try {
  $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
} catch {
  Write-Output (@{ ok = $false; error = "UIA FindAll 失败: " + $_.Exception.Message } | ConvertTo-Json -Compress)
  exit 0
}

$hits = New-Object System.Collections.ArrayList
foreach ($e in $all) {
  try {
    $c = $e.Current
    $n = [string]$c.Name
    if (-not $n) { continue }
    if ($exact) { if ($n -ne $name) { continue } }
    else { if (-not $n.ToLower().Contains($name.ToLower())) { continue } }
    $t = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    if ($type -and ($t.ToLower() -ne $type.ToLower())) { continue }
    if ($c.IsOffscreen) { continue }
    $r = $c.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { continue }
    $null = $hits.Add([pscustomobject]@{ e = $e; type = $t; name = $n; r = $r })
    if ($hits.Count -ge 20) { break }
  } catch { }
}

if ($hits.Count -eq 0) {
  Write-Output (@{ ok = $false; error = "not_found"; hint = "先用 pc_ui 看前台窗口的控件名；可以关掉 exact 用包含匹配" } | ConvertTo-Json -Compress)
  exit 0
}

if ($hits.Count -gt 1 -and $index -lt 0) {
  $cand = @()
  $i = 0
  foreach ($m in $hits) {
    $mr = MapRect $m.r
    $cand += [ordered]@{
      i = $i; type = $m.type; name = $m.name
      x = $mr.x; y = $mr.y; w = $mr.w; h = $mr.h
    }
    $i++
  }
  Write-Output ([ordered]@{ ok = $false; error = "multiple"; count = $hits.Count; candidates = $cand } | ConvertTo-Json -Compress -Depth 5)
  exit 0
}

$hit = $hits[0]
if ($index -ge 0 -and $index -lt $hits.Count) { $hit = $hits[$index] }
$e = $hit.e
$r = $hit.r
$mr = MapRect $r
$cx = [int]($mr.x + $mr.w / 2)
$cy = [int]($mr.y + $mr.h / 2)

$method = ""
try {
  $ip = $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  if ($ip) { $ip.Invoke(); $method = "invoke" }
} catch { }
if (-not $method) {
  try {
    $sp = $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($sp) { $sp.Select(); $method = "select" }
  } catch { }
}
if (-not $method) {
  [PcUiaClick]::Click($cx, $cy)
  $method = "click"
}

Write-Output ([ordered]@{
  ok = $true; method = $method; type = $hit.type; name = $hit.name
  x = $cx; y = $cy; w = $mr.w; h = $mr.h
} | ConvertTo-Json -Compress)
