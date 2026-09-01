Set-StrictMode -Version Latest

function Expand-RadarRunItems {
  [CmdletBinding()]
  param([Parameter(ValueFromPipeline = $true)][AllowNull()][object]$Value)

  process {
    if ($null -eq $Value) { return }
    if ($Value -is [System.Array]) {
      foreach ($item in $Value) { Expand-RadarRunItems -Value $item }
      return
    }
    Write-Output $Value
  }
}

function ConvertFrom-RadarRunListJson {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Json)

  if ([string]::IsNullOrWhiteSpace($Json)) { return }
  $decoded = ConvertFrom-Json -InputObject $Json
  $items = @(Expand-RadarRunItems -Value $decoded)
  foreach ($item in ($items | Sort-Object { [long]$_.databaseId })) { Write-Output $item }
}

function Select-RadarPendingRuns {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Runs,
    [Parameter(Mandatory = $true)][long]$LastRunId
  )

  foreach ($run in $Runs) {
    if ($null -eq $run -or $null -eq $run.databaseId) { throw 'GitHub 运行记录缺少 databaseId。' }
    [long]$runId = 0
    if (-not [long]::TryParse([string]$run.databaseId, [ref]$runId)) { throw "GitHub 运行编号无效：$($run.databaseId)" }
    if ($runId -gt $LastRunId) { Write-Output $run }
  }
}
