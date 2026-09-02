import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { findAgeBinary } from './crypto.js'
import { loadCountries, loadKeywordRules, loadSourceRules } from './config.js'
import { paths } from './paths.js'
import { RadarStore } from './store.js'
import { sha256 } from './utils.js'

type Check = { name: string, status: 'PASS' | 'WARN' | 'FAIL', detail: string }

function checkFilePair(name: string, source: string, backup: string): Check {
  if (!fs.existsSync(source)) return { name, status: 'FAIL', detail: `主文件不存在：${source}` }
  if (!fs.existsSync(backup)) return { name, status: 'FAIL', detail: `备份不存在：${backup}` }
  const sourceHash = sha256(fs.readFileSync(source)); const backupHash = sha256(fs.readFileSync(backup))
  return sourceHash === backupHash
    ? { name, status: 'PASS', detail: `E/H 校验一致：${sourceHash.toUpperCase()}` }
    : { name, status: 'FAIL', detail: `E/H 校验不一致：E=${sourceHash} H=${backupHash}` }
}

function checkSensitiveDirectoryAcl(): Check {
  if (process.platform !== 'win32') return { name: '密钥目录权限', status: 'WARN', detail: '非 Windows 环境未执行 ACL 检查' }
  const directories = [paths.keys, path.join(paths.backupRoot, '密钥恢复包')]
  const quoted = directories.map((item) => `'${item.replaceAll("'", "''")}'`).join(',')
  const script = [
    "Import-Module (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop",
    `$targets=@(${quoted})`,
    "$broad=@('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-32-546')",
    '$problems=@()',
    'foreach($target in $targets){',
    "  if(-not (Test-Path -LiteralPath $target)){ $problems += 'missing'; continue }",
    '  $acl=Get-Acl -LiteralPath $target',
    '  foreach($rule in $acl.Access){',
    '    try { $sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid=$rule.IdentityReference.Value }',
    "    if($rule.IsInherited){ $problems += 'inherited' }",
    "    if($broad -contains $sid){ $problems += 'broad' }",
    '  }',
    '}',
    "if($problems.Count -gt 0){ Write-Output (($problems | Sort-Object -Unique) -join ','); exit 2 }",
  ].join('\n')
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], { encoding: 'utf8', windowsHide: true })
  const failureReason = result.stdout.trim() || `检查器状态=${result.status ?? '无法启动'}`
  return result.status === 0
    ? { name: '密钥目录权限', status: 'PASS', detail: 'E/H 密钥目录未发现继承权限，也未向 Everyone、Users、Guests 或 Authenticated Users 开放' }
    : { name: '密钥目录权限', status: 'FAIL', detail: `密钥目录缺失、仍继承权限或向宽泛用户组开放（${failureReason}）` }
}

export function runDoctor(): Record<string, unknown> {
  const checks: Check[] = []
  checks.push({ name: '项目根目录', status: paths.root === 'E:\\跨境热销商品' ? 'PASS' : 'FAIL', detail: paths.root })
  checks.push({ name: '备份根目录', status: fs.existsSync(paths.backupRoot) ? 'PASS' : 'FAIL', detail: paths.backupRoot })
  const planNames = ['跨境热销商品雷达：可复用与不可复用完全分库版.md', '跨境热销商品雷达：研究全量保留版最终规划.md']
  for (const name of planNames) checks.push(checkFilePair(name, path.join(paths.root, name), path.join(paths.backupRoot, '规划备份', name)))
  try {
    const countries = loadCountries(); const sources = loadSourceRules(); loadKeywordRules()
    const enabled = new Set(sources.automatic.filter((item) => item.enabled).map((item) => item.id))
    const required = ['google-trends-rss', 'google-news-product-watchlist', 'gdelt-product-news', 'approved-product-jsonld', 'common-crawl-approved-pages', 'us-cpsc-recalls', 'uk-opss-alerts', 'canada-consumer-product-recalls', 'australia-accc-recalls', 'new-zealand-product-recalls', 'eu-safety-gate-weekly', 'ecb-reference-rates']
    const valid = countries.length === 11 && sources.network.maxRequestsPerRun === 250 && required.every((id) => enabled.has(id))
    checks.push({ name: '国家与来源配置', status: valid ? 'PASS' : 'FAIL', detail: `${countries.length}国；${enabled.size}个自动来源；单轮上限${sources.network.maxRequestsPerRun}请求` })
  } catch (error) { checks.push({ name: '国家与来源配置', status: 'FAIL', detail: error instanceof Error ? error.message : String(error) }) }
  try {
    const binary = findAgeBinary('age'); const version = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true })
    checks.push({ name: '结果加密工具', status: version.status === 0 && /1\.3\.1/.test(`${version.stdout}${version.stderr}`) ? 'PASS' : 'FAIL', detail: `${version.stdout}${version.stderr}`.trim() || binary })
  } catch (error) { checks.push({ name: '结果加密工具', status: 'FAIL', detail: error instanceof Error ? error.message : String(error) }) }
  try {
    const store = new RadarStore(); const integrity = store.integrityCheck(true); const dashboard = store.dashboard(); store.close()
    checks.push({ name: '数据库完整性', status: integrity === 'ok' ? 'PASS' : 'FAIL', detail: `${integrity}；${JSON.stringify(dashboard.counts)}` })
  } catch (error) { checks.push({ name: '数据库完整性', status: 'FAIL', detail: error instanceof Error ? error.message : String(error) }) }
  const reportRuntime = path.join(paths.artifactRuntime, 'node_modules', '@oai', 'artifact-tool')
  checks.push({ name: 'Excel 报表引擎', status: fs.existsSync(reportRuntime) ? 'PASS' : 'WARN', detail: fs.existsSync(reportRuntime) ? '已连接 Codex 本地报表引擎' : '尚未连接报表引擎，采集不受影响，Excel 暂不能生成' })
  try {
    const jobsFile = 'E:\\Hermes\\Agent\\cron\\jobs.json'
    const parsed = JSON.parse(fs.readFileSync(jobsFile, 'utf8')) as { jobs?: Array<Record<string, any>> }
    const job = parsed.jobs?.find((item) => item.id === '99c97b80b9eb' || item.name === '跨境热销商品雷达-本地同步')
    const interval30 = job?.schedule?.kind === 'interval' && Number(job?.schedule?.minutes) === 30
    const cronMatch = String(job?.schedule?.expr || '').match(/^(\d{1,2}),(\d{1,2}) \* \* \* \*$/)
    const cronTwiceHourly = job?.schedule?.kind === 'cron' && Boolean(cronMatch && Math.abs(Number(cronMatch[1]) - Number(cronMatch[2])) === 30)
    const scheduled = Boolean(job?.enabled && job?.state === 'scheduled' && (interval30 || cronTwiceHourly) && job?.repeat?.times === null)
    const lastFailed = job?.last_status === 'error'
    checks.push({
      name: 'Hermes 30分钟同步', status: !scheduled ? 'FAIL' : lastFailed ? 'WARN' : 'PASS',
      detail: !job ? '未找到跨境商品雷达定时任务' : `状态=${job.state}；最近=${job.last_status || '尚未运行'}；下次=${job.next_run_at || '未知'}`,
    })
  } catch (error) { checks.push({ name: 'Hermes 30分钟同步', status: 'FAIL', detail: error instanceof Error ? error.message : String(error) }) }
  const gh = spawnSync(process.platform === 'win32' ? 'gh.exe' : 'gh', ['auth', 'status'], { encoding: 'utf8', windowsHide: true })
  // Windows 凭据管理器偶尔会让 auth status 单次返回非零。用不输出内容的
  // auth token 探针复核，避免把瞬时读取失败误报为“账号未授权”。
  const ghTokenProbe = gh.status === 0 ? null : spawnSync(process.platform === 'win32' ? 'gh.exe' : 'gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true })
  const githubAuthorized = gh.status === 0 || ghTokenProbe?.status === 0
  const githubCliMissing = gh.error && (gh.error as NodeJS.ErrnoException).code === 'ENOENT'
  checks.push({
    name: 'GitHub 连接', status: githubAuthorized ? 'PASS' : 'WARN',
    detail: githubAuthorized ? 'GitHub CLI 已授权' : githubCliMissing ? '未找到 GitHub CLI；本地采集可用，云端同步需安装后授权' : 'GitHub 凭据检查暂不可用或尚未授权；不会把瞬时检查失败当作账号注销',
  })
  const keyNames = ['age-identity.txt', 'age-recipient.txt', 'signing-private.pem', 'signing-public.pem', 'hmac-secret.txt']
  checks.push({ name: '本地密钥', status: keyNames.every((name) => fs.existsSync(path.join(paths.keys, name))) ? 'PASS' : 'FAIL', detail: '只检查存在性，不显示任何密钥内容' })
  checks.push(checkSensitiveDirectoryAcl())
  const failed = checks.filter((item) => item.status === 'FAIL').length; const warnings = checks.filter((item) => item.status === 'WARN').length
  return { ok: failed === 0, failed, warnings, checkedAt: new Date().toISOString(), checks }
}
