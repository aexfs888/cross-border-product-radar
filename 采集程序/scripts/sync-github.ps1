$ErrorActionPreference = 'Stop'
$projectRoot = 'E:\跨境热销商品'
$stateFile = Join-Path $projectRoot '系统数据\cloud-state\last-github-run.json'
$inbox = Join-Path $projectRoot '系统数据\cloud-inbox'
$tempBase = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '临时文件'))
$mirrorBase = 'https://raw.githubusercontent.com/aexfs888/cross-border-product-radar/encrypted-radar-packages'

# Hermes Studio uses Windows PowerShell 5.1 on this machine.  Explicitly allow
# TLS 1.2 so a transient negotiation downgrade cannot break the whole sync.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-Sha256Hex([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-SafeFileName([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Length -gt 240 -or [System.IO.Path]::GetFileName($Name) -ne $Name -or $Name.Contains('..')) {
    throw "加密镜像文件名安全校验失败：$Name"
  }
}

function Invoke-GitHubApiFallback([string]$Uri, [string]$Destination = '') {
  $parsed = [Uri]$Uri
  if ($parsed.Scheme -ne 'https' -or $parsed.Host -ne 'raw.githubusercontent.com') {
    throw "备用下载通道拒绝非 GitHub raw 地址：$Uri"
  }
  $segments = @($parsed.AbsolutePath.Trim('/').Split('/'))
  if ($segments.Count -lt 4 -or $segments[0] -ne 'aexfs888' -or $segments[1] -ne 'cross-border-product-radar' -or $segments[2] -ne 'encrypted-radar-packages') {
    throw "备用下载通道拒绝仓库或分支范围外地址：$Uri"
  }
  $relativePath = ($segments[3..($segments.Count - 1)] -join '/')
  $endpoint = "repos/aexfs888/cross-border-product-radar/contents/$relativePath`?ref=encrypted-radar-packages"
  $json = (& gh api $endpoint 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "GitHub API 备用下载失败：$json" }
  $payload = $json | ConvertFrom-Json
  if ($payload.type -ne 'file') {
    throw "GitHub API 备用下载返回了非文件内容：$relativePath"
  }
  $encoded = [string]$payload.content
  $encoding = [string]$payload.encoding
  # Contents API omits inline content once a file grows beyond its response
  # limit.  Use the same authenticated public API to read the exact git blob;
  # this avoids depending on an intermittently failing raw CDN connection.
  if ([string]::IsNullOrWhiteSpace($encoded) -and -not [string]::IsNullOrWhiteSpace([string]$payload.git_url)) {
    $blobUri = [Uri]$payload.git_url
    if ($blobUri.Scheme -ne 'https' -or $blobUri.Host -ne 'api.github.com' -or $blobUri.AbsolutePath -notmatch '^/repos/aexfs888/cross-border-product-radar/git/blobs/[a-fA-F0-9]{40,64}$') {
      throw "GitHub Blob API 地址安全校验失败：$relativePath"
    }
    $blobEndpoint = $blobUri.AbsolutePath.TrimStart('/')
    $blobJson = (& gh api $blobEndpoint 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "GitHub Blob API 备用下载失败：$blobJson" }
    $blob = $blobJson | ConvertFrom-Json
    $encoded = [string]$blob.content
    $encoding = [string]$blob.encoding
  }
  if ([string]::IsNullOrWhiteSpace($encoded) -or $encoding -ne 'base64') {
    throw "GitHub API 备用下载未返回可解码文件：$relativePath"
  }
  $bytes = [Convert]::FromBase64String(($encoded -replace '\s', ''))
  if ($bytes.Length -gt 10MB) { throw "GitHub API 备用下载文件超过 10MB 限制：$relativePath" }
  if ([string]::IsNullOrWhiteSpace($Destination)) {
    return [pscustomobject]@{ StatusCode = 200; Content = [Text.Encoding]::UTF8.GetString($bytes) }
  }
  [IO.File]::WriteAllBytes($Destination, $bytes)
}

function Invoke-RadarRequest([string]$Uri, [string]$Destination = '') {
  $apiFailure = $null
  try {
    $parsed = [Uri]$Uri
    if ($parsed.Scheme -eq 'https' -and $parsed.Host -eq 'raw.githubusercontent.com' -and (Get-Command gh -ErrorAction SilentlyContinue)) {
      # Contents API is preferred because raw CDN responses can briefly serve a
      # stale index immediately after the mirror branch is updated.
      return Invoke-GitHubApiFallback -Uri $Uri -Destination $Destination
    }
  } catch {
    # Files over the Contents API limit or a temporary API failure still get a
    # chance through the public raw endpoint below.
    $apiFailure = $_
  }
  $lastFailure = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      if ([string]::IsNullOrWhiteSpace($Destination)) {
        return Invoke-WebRequest -Uri $Uri -UseBasicParsing -MaximumRedirection 3 -TimeoutSec 45
      }
      Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing -MaximumRedirection 3 -TimeoutSec 45
      return
    } catch {
      $lastFailure = $_
      $statusCode = $null
      if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
      # Authentication, permission and missing-file failures are not transient.
      if ($statusCode -ge 400 -and $statusCode -lt 500) { throw }
      if ($attempt -lt 3) { Start-Sleep -Seconds (2 * $attempt) }
    }
  }
  $apiDetail = if ($apiFailure) { "；GitHub API：$($apiFailure.Exception.Message)" } else { '' }
  throw "直接下载失败（$($lastFailure.Exception.Message)）$apiDetail"
}

Set-Location -LiteralPath $projectRoot

$lastRun = 0
if (Test-Path -LiteralPath $stateFile) {
  $saved = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  $lastRun = [long]$saved.lastRunId
}

try {
  $indexResponse = Invoke-RadarRequest -Uri "$mirrorBase/index.json"
} catch {
  $statusCode = $null
  if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
  if ($statusCode -eq 404) { Write-Host '公共加密包镜像尚未建立；等待下一轮 GitHub 云端采集发布。'; exit 0 }
  throw "读取 GitHub 公共加密包索引失败：$($_.Exception.Message)"
}
$index = $indexResponse.Content | ConvertFrom-Json
if ($index.schemaVersion -ne 1 -or $index.kind -ne 'encrypted-product-radar-mirror' -or $null -eq $index.packages) { throw 'GitHub 公共加密包索引格式不正确。' }
$pending = @($index.packages | Where-Object { $_.githubRunId -match '^\d{6,20}$' -and [long]$_.githubRunId -gt $lastRun } | Sort-Object { [long]$_.githubRunId })
$healthTemp = [System.IO.Path]::GetFullPath((Join-Path $tempBase 'github-source-health.json'))
try {
  Invoke-RadarRequest -Uri "$mirrorBase/source-health.json" -Destination $healthTemp
  npm run import:cloud-health -- --from $healthTemp
  if ($LASTEXITCODE -ne 0) { throw '云端来源健康状态导入失败' }
} catch {
  if (Test-Path -LiteralPath $healthTemp) { Remove-Item -LiteralPath $healthTemp -Force }
  Write-Warning "云端来源健康状态暂不可用，保留本地上一版：$($_.Exception.Message)"
} finally {
  if (Test-Path -LiteralPath $healthTemp) { Remove-Item -LiteralPath $healthTemp -Force }
}
if ($pending.Count -eq 0) { Write-Host '没有新的加密采集包；来源健康状态已检查。'; exit 0 }

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
      Invoke-RadarRequest -Uri "$mirrorBase/packages/$runId/$name" -Destination $destination
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
