param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$Root = 'E:\跨境热销商品'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$TaskName = 'CrossBorderRadar-ShadowHealth-30m'
$Script = Join-Path $Root '自动化\cross-border-coordinator.mjs'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "已移除任务：$TaskName"
  exit 0
}

if (-not (Test-Path -LiteralPath $Script)) { throw "未找到协调器：$Script" }
$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"{0}"' -f $Script) -WorkingDirectory $Root
$Triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650))
)
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers -Settings $Settings -Principal $Principal -Description '跨境雷达影子模式：每30分钟运行只读健康预检；不采集、不读取私密经营数据。' -Force | Out-Null
Write-Output "已安装影子模式任务：$TaskName"
