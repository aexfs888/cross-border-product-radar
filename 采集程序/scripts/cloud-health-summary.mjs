import fs from 'node:fs/promises'
import path from 'node:path'

const repository = process.env.RADAR_REPOSITORY
const token = process.env.GITHUB_TOKEN
if (!repository || !token) throw new Error('缺少 GitHub 只读运行环境')
const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'CrossBorderProductRadar/0.1' }
async function api(endpoint) { const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, { headers }); if (!response.ok) throw new Error(`GitHub API ${response.status}`); return response.json() }
const cutoff = Date.now() - 24 * 60 * 60 * 1000
const artifactsResponse = await api('/actions/artifacts?per_page=100')
const runsResponse = await api('/actions/workflows/cloud-collect.yml/runs?per_page=100')
const artifacts = (artifactsResponse.artifacts || []).filter((item) => item.name.startsWith('encrypted-radar-') && new Date(item.created_at).getTime() >= cutoff)
const runs = (runsResponse.workflow_runs || []).filter((item) => new Date(item.created_at).getTime() >= cutoff)
const summary = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), timezone: 'Asia/Taipei', scopeHours: 24,
  encryptedPackages: artifacts.length, encryptedBytes: artifacts.reduce((sum, item) => sum + Number(item.size_in_bytes || 0), 0),
  runs: { total: runs.length, successful: runs.filter((item) => item.conclusion === 'success').length, failed: runs.filter((item) => item.conclusion === 'failure').length, other: runs.filter((item) => !['success', 'failure'].includes(item.conclusion)).length },
  securityNote: 'GitHub 只汇总运行和加密包健康信息；商品内容只能由本地 Hermes 持有私钥后解密。',
}
const output = path.resolve('临时文件', 'cloud-health', 'cloud-health-summary.json')
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary))

