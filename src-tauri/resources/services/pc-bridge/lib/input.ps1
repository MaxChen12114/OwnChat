param([string]$Json = "")

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
try { $OutputEncoding = [Console]::OutputEncoding } catch {}
# input.ps1 — 鼠标点击/移动/滚轮 + 键盘输入
# 入参（base64 JSON）：
#   { "action":"click", "x":100, "y":200, "button":"left|right|middle", "count":1 }
#   { "action":"move",  "x":100, "y":200 }
#   { "action":"scroll","x":100, "y":200, "dx":0, "dy":-3 }
#   { "action":"type",  "text":"你好 Hello" }
#   { "action":"key",   "key":"Enter" | "Ctrl+C" | "Alt+Tab" | "Ctrl+Shift+Esc" }

$ErrorActionPreference = "Stop"
$in = @{}
if ($Json) {
  try {
    $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json))
    if ($raw) { $in = $raw | ConvertFrom-Json }
  } catch { }
}
$action = [string]$in.action

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class PcInp {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }

  public static void TypeText(string text) {
    foreach (char c in text) {
      INPUT[] inputs = new INPUT[2];
      inputs[0].type = 1;
      inputs[0].U.ki.wVk = 0;
      inputs[0].U.ki.wScan = (ushort)c;
      inputs[0].U.ki.dwFlags = 0x0004;
      inputs[0].U.ki.time = 0;
      inputs[0].U.ki.dwExtraInfo = IntPtr.Zero;
      inputs[1] = inputs[0];
      inputs[1].U.ki.dwFlags = 0x0004 | 0x0002;
      SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
  }

  public static void Click(int x, int y, string button, int count) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    uint down, up;
    if (button == "right") { down = 0x0008; up = 0x0010; }
    else if (button == "middle") { down = 0x0020; up = 0x0040; }
    else { down = 0x0002; up = 0x0004; }
    for (int i = 0; i < count; i++) {
      mouse_event(down, 0, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(35);
      mouse_event(up, 0, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(110);
    }
  }

  public static void Scroll(int x, int y, int dx, int dy) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(40);
    if (dy != 0) mouse_event(0x0800, 0, 0, dy * 120, UIntPtr.Zero);
    if (dx != 0) mouse_event(0x01000, 0, 0, dx * 120, UIntPtr.Zero);
  }

  public static void Key(byte vk, bool up) {
    keybd_event(vk, 0, up ? 0x0002u : 0u, UIntPtr.Zero);
  }
}
"@

try { [PcInp]::SetProcessDPIAware() | Out-Null } catch { }

function Ok($extra) {
  $o = [ordered]@{ ok = $true; action = $action }
  if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
  Write-Output ($o | ConvertTo-Json -Compress -Depth 4)
}

try {
  switch ($action) {
    "click" {
      $x = [int]$in.x; $y = [int]$in.y
      $btn = "left"; if ($in.button) { $btn = [string]$in.button }
      $cnt = 1; if ($in.count) { $cnt = [int]$in.count }
      if ($cnt -lt 1) { $cnt = 1 }
      if ($cnt -gt 2) { $cnt = 2 }
      [PcInp]::Click($x, $y, $btn, $cnt)
      Ok @{ x = $x; y = $y; button = $btn; count = $cnt }
    }
    "move" {
      $x = [int]$in.x; $y = [int]$in.y
      $null = [PcInp]::SetCursorPos($x, $y)
      Ok @{ x = $x; y = $y }
    }
    "scroll" {
      $x = [int]$in.x; $y = [int]$in.y; $dx = [int]$in.dx; $dy = [int]$in.dy
      [PcInp]::Scroll($x, $y, $dx, $dy)
      Ok @{ x = $x; y = $y; dx = $dx; dy = $dy }
    }
    "type" {
      $text = [string]$in.text
      if (-not $text) { throw "text 为空" }
      [PcInp]::TypeText($text)
      Ok @{ length = $text.Length }
    }
    "key" {
      $key = [string]$in.key
      if (-not $key) { throw "key 为空" }
      $mods = @()
      $parts = $key -split '\+'
      $main = $parts[$parts.Length - 1].Trim()
      for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        $m = $parts[$i].Trim().ToLower()
        if ($m -eq "ctrl" -or $m -eq "control") { $mods += 0x11 }
        elseif ($m -eq "shift") { $mods += 0x10 }
        elseif ($m -eq "alt") { $mods += 0x12 }
        elseif ($m -eq "win" -or $m -eq "meta") { $mods += 0x5B }
      }
      $map = @{
        "enter"=0x0D; "return"=0x0D; "tab"=0x09; "esc"=0x1B; "escape"=0x1B
        "backspace"=0x08; "delete"=0x2E; "del"=0x2E; "space"=0x20
        "up"=0x26; "down"=0x28; "left"=0x25; "right"=0x27
        "home"=0x24; "end"=0x23; "pageup"=0x21; "pagedown"=0x22
        "insert"=0x2D; "printscreen"=0x2C
        "shift"=0x10; "ctrl"=0x11; "control"=0x11; "alt"=0x12; "win"=0x5B; "meta"=0x5B
        "capslock"=0x14; "numlock"=0x90; "scrolllock"=0x91
        "f1"=0x70; "f2"=0x71; "f3"=0x72; "f4"=0x73; "f5"=0x74; "f6"=0x75
        "f7"=0x76; "f8"=0x77; "f9"=0x78; "f10"=0x79; "f11"=0x7A; "f12"=0x7B
      }
      $low = $main.ToLower()
      if ($map.ContainsKey($low)) { $vk = [byte]$map[$low] }
      elseif ($main.Length -eq 1) {
        $ch = $main.ToUpper()
        $code = [int][char]$ch
        if (($code -ge 65 -and $code -le 90) -or ($code -ge 48 -and $code -le 57)) { $vk = [byte]$code }
        else { throw "不支持的按键: " + $main }
      }
      else { throw "不支持的按键: " + $main }

      foreach ($m in $mods) { [PcInp]::Key([byte]$m, $false) }
      [PcInp]::Key($vk, $false)
      Start-Sleep -Milliseconds 40
      [PcInp]::Key($vk, $true)
      for ($i = $mods.Count - 1; $i -ge 0; $i--) { [PcInp]::Key([byte]$mods[$i], $true) }
      Ok @{ key = $key }
    }
    default {
      throw "未知 action: " + $action
    }
  }
} catch {
  Write-Output (@{ ok = $false; action = $action; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress)
}
