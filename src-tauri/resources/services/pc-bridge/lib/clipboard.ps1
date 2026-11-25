param([string]$Json = "")

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
try { $OutputEncoding = [Console]::OutputEncoding } catch {}
# clipboard.ps1 — 读取/写入剪贴板文本
# 入参：{ "action":"get" } 或 { "action":"set", "text":"..." }
# 输出：{ ok, action, text?, length, truncated? }

$ErrorActionPreference = "Stop"
$in = @{}
if ($Json) {
  try {
    $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json))
    if ($raw) { $in = $raw | ConvertFrom-Json }
  } catch { }
}
$action = "get"
if ($in.action) { $action = [string]$in.action }

try {
  if ($action -eq "set") {
    $text = [string]$in.text
    Set-Clipboard -Value $text
    Write-Output (@{ ok = $true; action = "set"; length = $text.Length } | ConvertTo-Json -Compress)
  } else {
    $t = Get-Clipboard -Raw -ErrorAction Stop
    if ($null -eq $t) { $t = "" }
    $t = [string]$t
    $truncated = $false
    if ($t.Length -gt 6000) { $t = $t.Substring(0, 6000); $truncated = $true }
    Write-Output (@{ ok = $true; action = "get"; text = $t; length = $t.Length; truncated = $truncated } | ConvertTo-Json -Compress)
  }
} catch {
  Write-Output (@{ ok = $false; action = $action; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress)
}
