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

Write-Output 'PowerShell GitHub 多运行展开与水位筛选回归：PASS'
