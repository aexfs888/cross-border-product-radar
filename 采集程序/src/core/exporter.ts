import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { paths } from './paths.js'
import { RadarStore } from './store.js'
import { atomicWrite } from './utils.js'

function runExporter(inputPath: string, outputPath: string): Record<string, unknown> {
  const script = path.join(paths.artifactRuntime, 'export-results.mjs')
  if (!fs.existsSync(script)) throw new Error(`缺少报表生成器：${script}`)
  const result = spawnSync(process.execPath, [script, inputPath, outputPath], {
    cwd: paths.artifactRuntime, windowsHide: true, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`Excel 生成失败：${result.stderr || result.stdout}`)
  const lastLine = result.stdout.trim().split(/\r?\n/).at(-1) || '{}'
  try { return JSON.parse(lastLine) as Record<string, unknown> } catch { return { ok: true, message: result.stdout.trim(), outputPath } }
}

function versionedOutputPath(outputPath: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const extension = path.extname(outputPath)
  return path.join(path.dirname(outputPath), `${path.basename(outputPath, extension)}-最新待替换-${stamp}${extension}`)
}

function exportWithoutOverwritingOpenFile(inputPath: string, outputPath: string): Record<string, unknown> {
  try {
    return runExporter(inputPath, outputPath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (!/(?:EBUSY|EPERM|resource busy or locked)/i.test(detail)) throw error
    const fallbackPath = versionedOutputPath(outputPath)
    const fallbackResult = runExporter(inputPath, fallbackPath)
    return {
      ...fallbackResult,
      outputPath: fallbackPath,
      warning: `固定报表正被打开，已安全生成最新待替换版本：${fallbackPath}`,
    }
  }
}

export async function exportReports(): Promise<Record<string, unknown>> {
  await fsp.mkdir(paths.reports, { recursive: true }); await fsp.mkdir(paths.temp, { recursive: true })
  const store = new RadarStore()
  let reusable: Record<string, unknown>; let nonReusable: Record<string, unknown>
  try {
    reusable = store.exportSnapshot('REUSABLE')
    nonReusable = store.exportSnapshot('NON_REUSABLE')
  } finally { store.close() }
  const nonReusableProducts = (nonReusable.products || []) as Record<string, unknown>[]
  if (nonReusableProducts.some((product) => Number(product.peak_heat_score || product.research_heat_score || 0) < 60)) {
    throw new Error('安全闸门：发现普通热度不可复用商品，已停止生成研究报表')
  }
  const reusableInput = path.join(paths.temp, 'report-reusable.json')
  const nonReusableInput = path.join(paths.temp, 'report-non-reusable.json')
  await atomicWrite(reusableInput, `${JSON.stringify(reusable)}\n`)
  await atomicWrite(nonReusableInput, `${JSON.stringify(nonReusable)}\n`)
  const reusableOutput = path.join(paths.reports, '可复用商品.xlsx')
  const nonReusableOutput = path.join(paths.reports, '不可复用商品研究.xlsx')
  const reusableResult = exportWithoutOverwritingOpenFile(reusableInput, reusableOutput)
  const nonReusableResult = exportWithoutOverwritingOpenFile(nonReusableInput, nonReusableOutput)
  await fsp.rm(reusableInput, { force: true }); await fsp.rm(nonReusableInput, { force: true })
  return { ok: true, reusable: reusableResult, nonReusable: nonReusableResult, outputs: [reusableOutput, nonReusableOutput] }
}
