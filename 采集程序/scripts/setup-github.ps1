$ErrorActionPreference = 'Stop'
$projectRoot = 'E:\跨境热销商品'
Set-Location -LiteralPath $projectRoot
gh auth status *> $null
if ($LASTEXITCODE -ne 0) { gh auth login --web --git-protocol https }
if ($LASTEXITCODE -ne 0) { throw 'GitHub 登录没有完成。' }

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.git'))) { git init -b main }
git add .
git commit -m 'Initialize encrypted cross-border product radar'
if ($LASTEXITCODE -ne 0) {
  $hasHead = git rev-parse --verify HEAD 2>$null
  if ($LASTEXITCODE -ne 0) { throw '无法创建首次本地版本。请检查 Git 用户姓名和邮箱。' }
}

$remote = git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0) {
  gh repo create cross-border-product-radar --public --source . --remote origin --push --description 'Free, evidence-first and encrypted cross-border product trend radar'
  if ($LASTEXITCODE -ne 0) { throw 'GitHub 仓库创建失败，可能已有同名仓库。' }
} else { git push -u origin main }

$publicConfig = Get-Content -LiteralPath (Join-Path $projectRoot '来源规则\cloud-public-config.json') -Raw | ConvertFrom-Json
gh variable set AGE_RECIPIENT --body $publicConfig.ageRecipient
$privatePem = Get-Content -LiteralPath (Join-Path $projectRoot '系统数据\keys\signing-private.pem') -Raw
$privateBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($privatePem))
$privateBase64 | gh secret set RADAR_SIGNING_PRIVATE_KEY_B64
if ($LASTEXITCODE -ne 0) { throw 'GitHub 加密签名密钥保存失败。' }
gh workflow run cloud-collect.yml
Write-Host 'GitHub 免费加密采集已经连接，并已触发首次测试运行。'

