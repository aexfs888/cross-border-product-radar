$ErrorActionPreference = 'Stop'
$projectRoot = 'E:\跨境热销商品'
$stateFile = Join-Path $projectRoot '系统数据\cloud-state\last-github-run.json'
$inbox = Join-Path $projectRoot '系统数据\cloud-inbox'
$tempBase = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '临时文件'))
. (Join-Path $PSScriptRoot 'github-run-selection.ps1')

Set-Location -LiteralPath $projectRoot
gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw 'GitHub 尚未登录。请先运行“⑥连接GitHub云端采集.cmd”。' }

$lastRun = 0
if (Test-Path -LiteralPath $stateFile) {
  $saved = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  $lastRun = [long]$saved.lastRunId
}
$runJsonLines = @(gh run list --workflow cloud-collect.yml --status success --limit 30 --json databaseId,createdAt)
if ($LASTEXITCODE -ne 0) { throw '读取 GitHub 成功运行列表失败。' }
$runJson = $runJsonLines -join [Environment]::NewLine
$runs = @(ConvertFrom-RadarRunListJson -Json $runJson)
$pending = @(Select-RadarPendingRuns -Runs $runs -LastRunId $lastRun)
if ($pending.Count -eq 0) { Write-Host '没有新的加密采集包。'; exit 0 }

New-Item -ItemType Directory -Force -Path $inbox | Out-Null
foreach ($run in $pending) {
  $runId = [long]$run.databaseId
  $downloadDir = [System.IO.Path]::GetFullPath((Join-Path $tempBase "github-run-$runId"))
  if (-not $downloadDir.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) { throw '临时目录安全校验失败' }
  New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
  try {
    gh run download $runId --name "encrypted-radar-$runId" --dir $downloadDir
    if ($LASTEXITCODE -ne 0) { throw "下载运行 $runId 失败" }
    Get-ChildItem -LiteralPath $downloadDir -File | Where-Object { $_.Name -match '\.(age|json|sig)$' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $inbox $_.Name) -Force }
    npm run sync
    if ($LASTEXITCODE -ne 0) { throw "验签、解密或入库失败：$runId" }
    $stateDirectory = Split-Path -Parent $stateFile; New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
    @{ lastRunId = $runId; syncedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
  } finally {
    if (Test-Path -LiteralPath $downloadDir) {
      $resolved = [System.IO.Path]::GetFullPath($downloadDir)
      if ($resolved.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
  }
}
npm run export
if ($LASTEXITCODE -ne 0) { throw 'Excel 报表更新失败' }
npm run backup
if ($LASTEXITCODE -ne 0) { throw 'H盘备份失败' }
Write-Host "已同步 $($pending.Count) 个加密采集包，并完成分库、报表和备份。"
