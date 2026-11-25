param([string]$Json = "")

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
try { $OutputEncoding = [Console]::OutputEncoding } catch {}
# windows.ps1 — 顶层窗口列表 / 聚焦窗口
# 入参：{ "action": "list" } 或 { "action": "focus", "hwnd": 123456, "title": "Chrome" }

$ErrorActionPreference = "Stop"
$in = @{}
if ($Json) {
  try {
    $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json))
    if ($raw) { $in = $raw | ConvertFrom-Json }
  } catch { }
}
$action = "list"
if ($in.action) { $action = [string]$in.action }

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class PcWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  public struct RECT { public int Left, Top, Right, Bottom; }

  public static IntPtr[] TopLevel() {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  public static string Title(IntPtr h) {
    int n = GetWindowTextLength(h);
    if (n <= 0) return "";
    var sb = new StringBuilder(n + 2);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static RECT Rect(IntPtr h) {
    RECT r;
    GetWindowRect(h, out r);
    return r;
  }
  public static uint Pid(IntPtr h) {
    uint p;
    GetWindowThreadProcessId(h, out p);
    return p;
  }
  public static bool ForceFocus(IntPtr h) {
    ShowWindow(h, 9); // SW_RESTORE
    IntPtr fg = GetForegroundWindow();
    if (fg == h) return true;
    uint dummy;
    uint fgThread = GetWindowThreadProcessId(fg, out dummy);
    uint thisThread = GetCurrentThreadId();
    bool ok;
    if (fgThread != 0 && fgThread != thisThread) {
      AttachThreadInput(thisThread, fgThread, true);
      ok = SetForegroundWindow(h);
      AttachThreadInput(thisThread, fgThread, false);
    } else {
      ok = SetForegroundWindow(h);
    }
    return ok;
  }
}
"@
try { [PcWin]::SetProcessDpiAwareness(2) | Out-Null } catch { try { [PcWin]::SetProcessDPIAware() | Out-Null } catch { } }

function CleanText([string]$s, [int]$max) {
  if (-not $s) { return "" }
  $s = ($s -replace '\s+', ' ').Trim()
  if ($s.Length -gt $max) { $s = $s.Substring(0, $max) + "…" }
  return $s
}

if ($action -eq "focus") {
  $target = [IntPtr]::Zero
  $hwndRaw = [string]$in.hwnd
  if ($hwndRaw) {
    try {
      $n = [int64]$hwndRaw
      if ($n -ne 0) { $target = [IntPtr]$n }
    } catch { }
  }
  if ($target -eq [IntPtr]::Zero -and $in.title) {
    $needle = [string]$in.title
    foreach ($h in [PcWin]::TopLevel()) {
      if (-not [PcWin]::IsWindowVisible($h)) { continue }
      $t = [PcWin]::Title($h)
      if ($t -and $t.ToLower().Contains($needle.ToLower())) { $target = $h; break }
    }
  }
  if ($target -eq [IntPtr]::Zero) {
    Write-Output (@{ ok = $false; error = "找不到窗口（hwnd/title 都没匹配）" } | ConvertTo-Json -Compress)
    exit 0
  }
  $ok = [PcWin]::ForceFocus($target)
  $t = [PcWin]::Title($target)
  Write-Output (@{ ok = [bool]$ok; hwnd = [int64]$target; title = (CleanText $t 200); note = $(if ($ok) { "" } else { "SetForegroundWindow 被系统拒绝；可先点一下目标窗口再试" }) } | ConvertTo-Json -Compress)
  exit 0
}

$fg = [PcWin]::GetForegroundWindow()
$list = New-Object System.Collections.ArrayList
foreach ($h in [PcWin]::TopLevel()) {
  if (-not [PcWin]::IsWindowVisible($h)) { continue }
  $t = [PcWin]::Title($h)
  if (-not $t) { continue }
  $r = [PcWin]::Rect($h)
  $w = $r.Right - $r.Left
  $hh = $r.Bottom - $r.Top
  if ($w -le 0 -or $hh -le 0) { continue }
  $procId = [int][PcWin]::Pid($h)
  $proc = ""
  if ($procId -gt 0) {
    try { $proc = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
  }
  $null = $list.Add([ordered]@{
    hwnd = [int64]$h
    title = CleanText $t 200
    process = $proc
    pid = $procId
    x = [int]$r.Left; y = [int]$r.Top; w = [int]$w; h = [int]$hh
    foreground = ($h -eq $fg)
  })
  if ($list.Count -ge 60) { break }
}

Write-Output ([ordered]@{ ok = $true; count = $list.Count; windows = $list } | ConvertTo-Json -Compress -Depth 5)
