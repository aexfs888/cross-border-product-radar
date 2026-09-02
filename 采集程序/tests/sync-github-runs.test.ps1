$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\scripts\github-run-selection.ps1')

$fixture = @'
[
  {"databaseId":33501972913,"createdAt":"2026-09-01T11:20:21Z"},
  {"databaseId":33501271475,"createdAt":"2026-09-01T11:12:15Z"}
]
'@

$runs = @(ConvertFrom-RadarRunListJson -Json $fixture)
if ($runs.Count -ne 2) { throw "回归失败：应展开为2条运行记录，实际为$($runs.Count)条。" }
if ([long]$runs[0].databaseId -ne 33501271475 -or [long]$runs[1].databaseId -ne 33501972913) { throw '回归失败：运行记录没有按 databaseId 正确排序。' }

$pending = @(Select-RadarPendingRuns -Runs $runs -LastRunId 33501271475)
if ($pending.Count -ne 1) { throw "回归失败：应筛出1条待同步运行，实际为$($pending.Count)条。" }
if ([long]$pending[0].databaseId -ne 33501972913) { throw '回归失败：待同步运行编号不正确。' }

$none = @(Select-RadarPendingRuns -Runs $runs -LastRunId 33501972913)
if ($none.Count -ne 0) { throw '回归失败：水位已最新时仍返回了待同步运行。' }

$syncScript = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\sync-github.ps1') -Raw
$exportPosition = $syncScript.LastIndexOf('npm run export')
$backupPosition = $syncScript.LastIndexOf('npm run backup')
$stateWritePosition = $syncScript.LastIndexOf('Move-Item -LiteralPath $temporaryState -Destination $stateFile -Force')
if ($exportPosition -lt 0 -or $backupPosition -lt 0 -or $stateWritePosition -lt 0) { throw '回归失败：同步脚本缺少报表、备份或水位提交步骤。' }
if ($stateWritePosition -lt $exportPosition -or $stateWritePosition -lt $backupPosition) { throw '回归失败：GitHub 水位不得早于报表与 H 盘备份提交。' }
if (([regex]::Matches($syncScript, 'Move-Item -LiteralPath \$temporaryState -Destination \$stateFile -Force')).Count -ne 1) { throw '回归失败：水位必须且只能在全部收尾成功后提交一次。' }

Write-Output 'PowerShell GitHub 多运行展开、水位筛选与延迟提交回归：PASS'
