param([string]$Json = "")

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
try { $OutputEncoding = [Console]::OutputEncoding } catch {}
# ui.ps1 — 前台窗口的 UIA 控件树（精简文本版）
# 入参：{ "limit": 40 }
# 设计：交互控件优先；不足 limit 再用带名字的 Text/Document 补。
# 输出单行 JSON：{ ok, window:{...}, total, shown, truncated, elements:[{i,type,name,value,x,y,w,h,enabled,focused,aid}] }

$ErrorActionPreference = "Stop"
$in = @{}
if ($Json) {
  try {
    $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json))
    if ($raw) { $in = $raw | ConvertFrom-Json }
  } catch { }
}
$limit = 40
if ($in.limit) { $limit = [int]$in.limit }
if ($limit -lt 10) { $limit = 10 }
if ($limit -gt 120) { $limit = 120 }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$TW = [System.Windows.Automation.TreeWalker]

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class PcFgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [StructLayout(LayoutKind.Sequential)]
  public struct PcRect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out PcRect lpRect);
  public static PcRect GetRect(IntPtr hWnd) { PcRect r; GetWindowRect(hWnd, out r); return r; }
}
"@
try { [PcFgWin]::SetProcessDpiAwareness(2) | Out-Null } catch { try { [PcFgWin]::SetProcessDPIAware() | Out-Null } catch { } }
$win = $null
try {
  $hfg = [PcFgWin]::GetForegroundWindow()
  if ($hfg -ne [IntPtr]::Zero) { $win = $A::FromHandle($hfg) }
} catch { }
if (-not $win) {
  # 兜底：从焦点元素往上找 Window（有些自绘窗口 FromHandle 拿不到）
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
  Write-Output (@{ ok = $false; error = "拿不到前台窗口（可能锁屏，或 UIA 被目标程序拒绝）" } | ConvertTo-Json -Compress)
  exit 0
}

$wc = $win.Current
$winTitle = [string]$wc.Name
$winPid = [int]$wc.ProcessId
$winProc = ""
try { $winProc = (Get-Process -Id $winPid -ErrorAction Stop).ProcessName } catch { }
$winRect = $wc.BoundingRectangle

# 统一到物理像素：UIA 在不同窗口/DPI 感知状态下可能返回逻辑像素。
# 用 DPI-aware 的 GetWindowRect 取物理窗口矩形，按窗口比例把元素坐标映射到物理屏幕坐标。
$winHwnd = [IntPtr][int64]$wc.NativeWindowHandle
$winPhysL = 0; $winPhysT = 0; $winPhysR = 0; $winPhysB = 0
$hasPhys = $false
if ($winHwnd -ne [IntPtr]::Zero) {
  try {
    $pr = [PcFgWin]::GetRect($winHwnd)
    $winPhysL = $pr.Left; $winPhysT = $pr.Top; $winPhysR = $pr.Right; $winPhysB = $pr.Bottom
    $hasPhys = (($winPhysR - $winPhysL) -gt 0 -and ($winPhysB - $winPhysT) -gt 0)
  } catch { $hasPhys = $false }
}
$physW = 0; $physH = 0
if ($hasPhys) { $physW = $winPhysR - $winPhysL; $physH = $winPhysB - $winPhysT }
$uiaW = [double]$winRect.Width; $uiaH = [double]$winRect.Height
$sx = 1.0; $sy = 1.0
if ($uiaW -gt 0 -and $uiaH -gt 0 -and $physW -gt 0 -and $physH -gt 0) {
  $sx = $physW / $uiaW; $sy = $physH / $uiaH
  if ([math]::Abs($sx - 1.0) -lt 0.03) { $sx = 1.0 }
  if ([math]::Abs($sy - 1.0) -lt 0.03) { $sy = 1.0 }
}

function ShortType($el) {
  try { return ($el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') } catch { return "" }
}
function CleanText([string]$s, [int]$max) {
  if (-not $s) { return "" }
  $s = ($s -replace '\s+', ' ').Trim()
  if ($s.Length -gt $max) { $s = $s.Substring(0, $max) + "…" }
  return $s
}
function PatternValue($el) {
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp -and $vp.Current) { return [string]$vp.Current.Value }
  } catch { }
  return ""
}

$interactive = @(
  "Button", "Edit", "ComboBox", "CheckBox", "RadioButton", "List", "ListItem",
  "MenuItem", "TabItem", "Hyperlink", "Slider", "Spinner", "TreeItem", "DataItem",
  "MenuItem", "SplitButton", "ToolBar", "Menu", "Tab"
)

try {
  $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
} catch {
  Write-Output (@{ ok = $false; error = "UIA FindAll 失败: " + $_.Exception.Message } | ConvertTo-Json -Compress)
  exit 0
}

$total = $all.Count
$picked = New-Object System.Collections.ArrayList
$seen = @{}

function TryAdd($e, $isInteractivePass) {
  if ($picked.Count -ge $limit) { return }
  try {
    $c = $e.Current
    if ($c.IsOffscreen) { return }
    $r = $c.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { return }
    $t = ShortType $e
    $name = CleanText ([string]$c.Name) 160
    $aid = CleanText ([string]$c.AutomationId) 60
    if (-not $name -and -not $aid) { return }
    if (-not $isInteractivePass -and $t -ne "Text" -and $t -ne "Document" -and $t -ne "Image") { return }
    if ($name.Length -lt 1 -and $aid.Length -lt 1) { return }
    # 去重：同 type+name+rect 只留一个
    $key = "$t|$name|$([int]$r.X),$([int]$r.Y),$([int]$r.Width),$([int]$r.Height)"
    if ($seen.ContainsKey($key)) { return }
    $seen[$key] = 1
    $val = ""
    if ($t -eq "Edit" -or $t -eq "ComboBox" -or $t -eq "Document") { $val = CleanText (PatternValue $e) 160 }
    $focused = $false
    try { $focused = [bool]$c.HasKeyboardFocus } catch { }
    $enabled = $true
    try { $enabled = [bool]$c.IsEnabled } catch { }
    if ($hasPhys) {
      $ex = [int][math]::Round($winPhysL + (([double]$r.X) - [double]$winRect.X) * $sx)
      $ey = [int][math]::Round($winPhysT + (([double]$r.Y) - [double]$winRect.Y) * $sy)
      $ew = [int][math]::Round(([double]$r.Width) * $sx)
      $eh = [int][math]::Round(([double]$r.Height) * $sy)
    } else {
      $ex = [int]$r.X; $ey = [int]$r.Y; $ew = [int]$r.Width; $eh = [int]$r.Height
    }
    $null = $picked.Add([ordered]@{
      i = $picked.Count
      type = $t
      name = $name
      value = $val
      x = $ex; y = $ey; w = $ew; h = $eh
      enabled = $enabled
      focused = $focused
      aid = $aid
    })
  } catch { }
}

# 第一遍：交互控件
foreach ($e in $all) {
  if ($picked.Count -ge $limit) { break }
  $t = ShortType $e
  if ($interactive -contains $t) { TryAdd $e $true }
}
# 第二遍：文本/文档补足
if ($picked.Count -lt $limit) {
  foreach ($e in $all) {
    if ($picked.Count -ge $limit) { break }
    $t = ShortType $e
    if ($t -eq "Text" -or $t -eq "Document" -or $t -eq "Image") { TryAdd $e $false }
  }
}

$wx = [int]$winRect.X; $wy = [int]$winRect.Y; $ww = [int]$winRect.Width; $wh = [int]$winRect.Height
if ($hasPhys) { $wx = $winPhysL; $wy = $winPhysT; $ww = $physW; $wh = $physH }
$out = [ordered]@{
  ok = $true
  coordSpace = "physical"
  scale = @([math]::Round($sx, 4), [math]::Round($sy, 4))
  window = [ordered]@{
    title = CleanText $winTitle 200
    process = $winProc
    pid = $winPid
    hwnd = [int64]$wc.NativeWindowHandle
    x = $wx; y = $wy
    w = $ww; h = $wh
  }
  total = $total
  shown = $picked.Count
  truncated = ($picked.Count -lt $total)
  elements = $picked
}
Write-Output ($out | ConvertTo-Json -Compress -Depth 8)
