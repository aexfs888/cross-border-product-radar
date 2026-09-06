import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { buildPrivateProfitLedger, sha256Text } from './private-profit-ledger.mjs'
import { validatePrivateAggregateRows, validateUnitEconomicsRows } from './private-input-contract.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const privateRoot = path.resolve(projectRoot, '系统数据', 'private')
const outputRoot = path.join(privateRoot, 'profit-ledger')
const [aggregateArg, economicsArg] = process.argv.slice(2)

function parseCsv(text) {
  const rows = []
  let row = []; let cell = ''; let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]; const next = text[index + 1]
    if (char === '"' && quoted && next === '"') { cell += '"'; index += 1; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (char === ',' && !quoted) { row.push(cell.trim()); cell = ''; continue }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1
      row.push(cell.trim()); cell = ''
      if (row.some((value) => value !== '')) rows.push(row)
      row = []; continue
    }
    cell += char
  }
  if (quoted) throw new Error('csv_unclosed_quote')
  row.push(cell.trim())
  if (row.some((value) => value !== '')) rows.push(row)
  if (!rows.length) throw new Error('csv_empty')
  const [headers, ...values] = rows
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length || values.some((value) => value.length !== headers.length)) throw new Error('csv_shape_invalid')
  return { headers, rows: values.map((value) => Object.fromEntries(value.map((item, index) => [headers[index], item]))) }
}

function insidePrivateRoot(value) {
  const resolved = path.resolve(value || '')
  const relative = path.relative(privateRoot, resolved)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative) && path.extname(resolved).toLowerCase() === '.csv' ? resolved : null
}

async function runWorkspacePrivacyCheck() {
  const workspaceRoot = 'E:/fb+bm'
  const command = process.platform === 'win32' ? 'cmd.exe' : process.execPath
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd run privacy:check']
    : [path.join(workspaceRoot, 'src', 'cli.mjs'), 'privacy-check']
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd: workspaceRoot, windowsHide: true, stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}

function outputSummary(ledger, aggregatePath, economicsPath) {
  return {
    state: 'private_profit_ledger_generated', privateDataAccessed: true, uploaded: false, advertisingActions: false,
    inputHashes: { aggregate: sha256Text(aggregatePath), unitEconomics: sha256Text(economicsPath) },
    summary: ledger.summary,
  }
}

if (process.env.RADAR_PRIVATE_LEDGER_APPROVED !== '1') {
  console.log(JSON.stringify({ state: 'blocked_private_ledger_not_approved', privateDataAccessed: false, uploaded: false, advertisingActions: false }))
  process.exitCode = 2
} else {
  const aggregatePath = insidePrivateRoot(aggregateArg)
  const economicsPath = insidePrivateRoot(economicsArg)
  if (!aggregatePath || !economicsPath) {
    console.log(JSON.stringify({ state: 'blocked_private_ledger_path_or_type', privateDataAccessed: false, uploaded: false, advertisingActions: false }))
    process.exitCode = 2
  } else if (!await runWorkspacePrivacyCheck()) {
    console.log(JSON.stringify({ state: 'blocked_workspace_privacy_check_failed', privateDataAccessed: false, uploaded: false, advertisingActions: false }))
    process.exitCode = 2
  } else {
    try {
      const [aggregateText, economicsText] = await Promise.all([fs.readFile(aggregatePath, 'utf8'), fs.readFile(economicsPath, 'utf8')])
      if (Buffer.byteLength(aggregateText) > 2 * 1024 * 1024 || Buffer.byteLength(economicsText) > 2 * 1024 * 1024) throw new Error('private_input_too_large')
      const aggregates = parseCsv(aggregateText); const economics = parseCsv(economicsText)
      const aggregateValidation = validatePrivateAggregateRows(aggregates.headers, aggregates.rows)
      const economicsValidation = validateUnitEconomicsRows(economics.headers, economics.rows)
      if (!aggregateValidation.ok || !economicsValidation.ok) {
        console.log(JSON.stringify({ state: 'private_profit_ledger_validation_failed', privateDataAccessed: true, uploaded: false, advertisingActions: false, errorCodes: [...aggregateValidation.errors, ...economicsValidation.errors].slice(0, 20) }))
        process.exitCode = 2
      } else {
        const ledger = buildPrivateProfitLedger(aggregates.rows, economics.rows)
        await fs.mkdir(outputRoot, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const output = path.join(outputRoot, `profit-ledger-${stamp}.json`)
        await fs.writeFile(output, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
        console.log(JSON.stringify(outputSummary(ledger, aggregateText, economicsText)))
      }
    } catch (error) {
      const code = error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message) ? error.message : 'private_profit_ledger_failed'
      console.log(JSON.stringify({ state: 'private_profit_ledger_failed', privateDataAccessed: true, uploaded: false, advertisingActions: false, errorCodes: [code] }))
      process.exitCode = 2
    }
  }
}
