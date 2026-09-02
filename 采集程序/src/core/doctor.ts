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

export function runDoctor(): Record<string, unknown> {
  const checks: Check[] = []
  checks.push({ name: '项目根目录', status: paths.root === 'E:\\跨境热销商品' ? 'PASS' : 'FAIL', detail: paths.root })
  checks.push({ name: '备份根目录', status: fs.existsSync(paths.backupRoot) ? 'PASS' : 'FAIL', detail: paths.backupRoot })
  const planNames = ['跨境热销商品雷达：可复用与不可复用完全分库版.md', '跨境热销商品雷达：研究全量保留版最终规划.md']
  for (const name of planNames) checks.push(checkFilePair(name, path.join(paths.root, name), path.join(paths.backupRoot, '规划备份', name)))
  try {
    const countries = loadCountries(); const sources = loadSourceRules(); loadKeywordRules()
    checks.push({ name: '国家与来源配置', status: countries.length === 11 && sources.network.maxRequestsPerRun === 250 ? 'PASS' : 'FAIL', detail: `${countries.length}国；单轮上限${sources.network.maxRequestsPerRun}请求` })
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
  const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', windowsHide: true })
  checks.push({ name: 'GitHub 连接', status: gh.status === 0 ? 'PASS' : 'WARN', detail: gh.status === 0 ? 'GitHub CLI 已授权' : '尚未授权 GitHub；本地采集可用，云端全天采集需稍后连接' })
  const keyNames = ['age-identity.txt', 'age-recipient.txt', 'signing-private.pem', 'signing-public.pem', 'hmac-secret.txt']
  checks.push({ name: '本地密钥', status: keyNames.every((name) => fs.existsSync(path.join(paths.keys, name))) ? 'PASS' : 'FAIL', detail: '只检查存在性，不显示任何密钥内容' })
  const failed = checks.filter((item) => item.status === 'FAIL').length; const warnings = checks.filter((item) => item.status === 'WARN').length
  return { ok: failed === 0, failed, warnings, checkedAt: new Date().toISOString(), checks }
}
