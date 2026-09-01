$ErrorActionPreference = 'Stop'
$projectRoot = 'E:\跨境热销商品'
$stateFile = Join-Path $projectRoot '系统数据\cloud-state\last-github-run.json'
$inbox = Join-Path $projectRoot '系统数据\cloud-inbox'
$tempBase = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '临时文件'))
$mirrorBase = 'https://raw.githubusercontent.com/aexfs888/cross-border-product-radar/encrypted-radar-packages'

function Get-Sha256Hex([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-SafeFileName([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Length -gt 240 -or [System.IO.Path]::GetFileName($Name) -ne $Name -or $Name.Contains('..')) {
    throw "加密镜像文件名安全校验失败：$Name"
  }
}

function Invoke-RadarDownload([string]$Uri, [string]$Destination) {
  Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing -MaximumRedirection 3
}

Set-Location -LiteralPath $projectRoot

$lastRun = 0
if (Test-Path -LiteralPath $stateFile) {
  $saved = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  $lastRun = [long]$saved.lastRunId
}

try {
  $indexResponse = Invoke-WebRequest -Uri "$mirrorBase/index.json" -UseBasicParsing -MaximumRedirection 3
} catch {
  $statusCode = $null
  if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
  if ($statusCode -eq 404) { Write-Host '公共加密包镜像尚未建立；等待下一轮 GitHub 云端采集发布。'; exit 0 }
  throw "读取 GitHub 公共加密包索引失败：$($_.Exception.Message)"
}
$index = $indexResponse.Content | ConvertFrom-Json
if ($index.schemaVersion -ne 1 -or $index.kind -ne 'encrypted-product-radar-mirror' -or $null -eq $index.packages) { throw 'GitHub 公共加密包索引格式不正确。' }
$pending = @($index.packages | Where-Object { $_.githubRunId -match '^\d{6,20}$' -and [long]$_.githubRunId -gt $lastRun } | Sort-Object { [long]$_.githubRunId })
if ($pending.Count -eq 0) { Write-Host '没有新的加密采集包。'; exit 0 }

New-Item -ItemType Directory -Force -Path $inbox | Out-Null
foreach ($run in $pending) {
  $runId = [long]$run.githubRunId
  if ($null -eq $run.files -or @($run.files).Count -ne 3) { throw "加密镜像运行 $runId 的文件清单不完整。" }
  $downloadDir = [System.IO.Path]::GetFullPath((Join-Path $tempBase "github-run-$runId"))
  if (-not $downloadDir.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) { throw '临时目录安全校验失败' }
  New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
  try {
    foreach ($file in @($run.files)) {
      $name = [string]$file.name
      Assert-SafeFileName $name
      if ($name -notmatch '(\.age|\.manifest\.json|\.manifest\.json\.sig)$') { throw "加密镜像包含未允许文件：$name" }
      $expectedHash = [string]$file.sha256
      if ($expectedHash -notmatch '^[a-fA-F0-9]{64}$') { throw "加密镜像文件哈希格式不正确：$name" }
      $destination = Join-Path $downloadDir $name
      Invoke-RadarDownload -Uri "$mirrorBase/packages/$runId/$name" -Destination $destination
      if ((Get-Sha256Hex $destination) -ne $expectedHash.ToLowerInvariant()) { throw "加密镜像文件哈希不匹配：$name" }
      Copy-Item -LiteralPath $destination -Destination (Join-Path $inbox $name) -Force
    }
    npm run sync
    if ($LASTEXITCODE -ne 0) { throw "验签、解密或入库失败：$runId" }
    $stateDirectory = Split-Path -Parent $stateFile; New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
    $temporaryState = "$stateFile.$PID.tmp"
    @{ lastRunId = $runId; syncedAt = (Get-Date).ToUniversalTime().ToString('o'); transport = 'public-encrypted-mirror' } | ConvertTo-Json | Set-Content -LiteralPath $temporaryState -Encoding UTF8
    Move-Item -LiteralPath $temporaryState -Destination $stateFile -Force
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
