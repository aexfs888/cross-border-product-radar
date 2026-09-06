import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { validatePrivateAggregateRows, validateUnitEconomicsRows } from './private-input-contract.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const privateRoot = path.resolve(projectRoot, '系统数据', 'private')
const input = process.argv[2]
const kind = process.argv.includes('--unit-economics') ? 'unit-economics' : 'aggregate'

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
  if (rows.length === 0) throw new Error('csv_empty')
  const [headers, ...values] = rows
  if (headers.some((header) => !header)) throw new Error('csv_empty_header')
  if (new Set(headers).size !== headers.length) throw new Error('csv_duplicate_header')
  if (values.some((value) => value.length !== headers.length)) throw new Error('csv_column_count_mismatch')
  return { headers, rows: values.map((value) => Object.fromEntries(value.map((item, index) => [headers[index], item]))) }
}

function safeErrorCode(error) {
  const text = error instanceof Error ? error.message : String(error)
  return /^[a-z0-9_:-]+$/i.test(text) ? text : 'private_input_read_failed'
}

if (process.env.RADAR_PRIVATE_IMPORT_APPROVED !== '1') {
  console.log(JSON.stringify({ state: 'blocked_private_import_not_approved', kind, privateDataAccessed: false, note: '私密聚合输入验证需要单独人工批准；本次未读取文件。' }))
  process.exitCode = 2
} else if (!input) {
  console.log(JSON.stringify({ state: 'blocked_missing_input', kind, privateDataAccessed: false }))
  process.exitCode = 2
} else {
  const resolved = path.resolve(input)
  const relative = path.relative(privateRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    console.log(JSON.stringify({ state: 'blocked_path_outside_private_root', kind, privateDataAccessed: false }))
    process.exitCode = 2
  } else if (path.extname(resolved).toLowerCase() !== '.csv') {
    console.log(JSON.stringify({ state: 'blocked_unsupported_private_input_type', kind, privateDataAccessed: false }))
    process.exitCode = 2
  } else {
    try {
      const stat = await fs.stat(resolved)
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('private_input_size_or_type_invalid')
      const { headers, rows } = parseCsv(await fs.readFile(resolved, 'utf8'))
      const validation = kind === 'unit-economics'
        ? validateUnitEconomicsRows(headers, rows)
        : validatePrivateAggregateRows(headers, rows)
      console.log(JSON.stringify({
        state: validation.ok ? 'validated_not_imported' : 'validation_failed', kind,
        privateDataAccessed: true, imported: false, acceptedRows: validation.acceptedRows,
        errorCodes: validation.errors.slice(0, 20),
      }))
      process.exitCode = validation.ok ? 0 : 2
    } catch (error) {
      console.log(JSON.stringify({ state: 'validation_failed', kind, privateDataAccessed: true, imported: false, acceptedRows: 0, errorCodes: [safeErrorCode(error)] }))
      process.exitCode = 2
    }
  }
}
