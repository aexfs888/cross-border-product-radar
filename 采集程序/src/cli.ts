import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createFullBackup } from './core/backup.js'
import { runDoctor } from './core/doctor.js'
import { exportReports } from './core/exporter.js'
import { paths } from './core/paths.js'
import { analyzeAll, collectCloud, collectLocal, importPipiadsHistory, importPublicResearchLinks, initializeProject, purgeSourceEvents, syncInbox, writeHealthSnapshot } from './core/pipeline.js'
import { startDashboard } from './core/server.js'
import { RadarStore } from './core/store.js'
import { atomicWrite } from './core/utils.js'

function valueAfter(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }

async function writePublicCloudConfig(recipient: string): Promise<string> {
  const publicPem = fs.readFileSync(path.join(paths.keys, 'signing-public.pem'), 'utf8')
  const output = path.join(paths.root, '来源规则', 'cloud-public-config.json')
  await atomicWrite(output, `${JSON.stringify({ schemaVersion: 1, ageRecipient: recipient, signingPublicKeyBase64: Buffer.from(publicPem).toString('base64'), note: '这些是公钥信息，可以提交到公开 GitHub；私钥永远不能提交。' }, null, 2)}\n`)
  return output
}

async function main(): Promise<void> {
  const args = process.argv.slice(2); const command = args[0] || 'doctor'
  if (command === 'init') {
    const initialized = initializeProject() as { recipient: string }
    const publicConfig = await writePublicCloudConfig(initialized.recipient)
    const backup = await createFullBackup()
    print({ ...initialized, publicConfig, initialBackup: backup }); return
  }
  if (command === 'collect') {
    print(args.includes('--cloud') ? await collectCloud() : await collectLocal({ sourceId: valueAfter(args, '--source'), approvedUrl: valueAfter(args, '--approved-url'), countryCode: valueAfter(args, '--country') })); return
  }
  if (command === 'import-pipiads-history') {
    const source = valueAfter(args, '--from'); if (!source) throw new Error('缺少 --from 离线历史导出 JSON 路径')
    const imported = await importPipiadsHistory(source); const reports = await exportReports(); const backup = await createFullBackup()
    print({ ...imported, reports, backup }); return
  }
  if (command === 'purge-source') {
    const sourceId = valueAfter(args, '--source'); const reason = valueAfter(args, '--reason') || '来源事件不再满足证据关联规则'
    if (!sourceId) throw new Error('缺少 --source 来源标识')
    const purged = await purgeSourceEvents(sourceId, reason); const reports = await exportReports(); const backup = await createFullBackup()
    print({ ...purged, reports, backup }); return
  }
  if (command === 'import-public-links') {
    const imported = await importPublicResearchLinks(valueAfter(args, '--from')); const reports = await exportReports(); const backup = await createFullBackup()
    print({ ...imported, reports, backup }); return
  }
  if (command === 'analyze') {
    const store = new RadarStore(); try { print(await analyzeAll(store)) } finally { store.close() }; return
  }
  if (command === 'sync') { const result = await syncInbox() as { ok?: boolean }; print(result); if (result.ok === false) process.exitCode = 1; return }
  if (command === 'export') { const result = await exportReports() as { ok?: boolean }; print(result); if (result.ok === false) process.exitCode = 1; return }
  if (command === 'backup') { print(await createFullBackup()); return }
  if (command === 'prune') { const store = new RadarStore(); try { print(store.pruneLowHeat(30)) } finally { store.close() }; return }
  if (command === 'doctor') { const result = runDoctor(); print(result); if (!result.ok) process.exitCode = 1; return }
  if (command === 'health') { print({ output: await writeHealthSnapshot() }); return }
  if (command === 'serve') {
    const port = Number(valueAfter(args, '--port') || 8765); startDashboard(port)
    process.stdout.write(`本地只读看板：http://127.0.0.1:${port}\n按 Ctrl+C 关闭。\n`); return
  }
  if (command === 'copy-cloud-files') {
    const source = valueAfter(args, '--from'); if (!source) throw new Error('缺少 --from 下载目录')
    await fsp.mkdir(paths.inbox, { recursive: true })
    for (const name of await fsp.readdir(source)) if (/\.(age|json|sig)$/.test(name)) await fsp.copyFile(path.join(source, name), path.join(paths.inbox, name))
    print({ ok: true, inbox: paths.inbox }); return
  }
  throw new Error(`未知命令：${command}`)
}

main().catch((error) => { process.stderr.write(`执行失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`); process.exitCode = 1 })
