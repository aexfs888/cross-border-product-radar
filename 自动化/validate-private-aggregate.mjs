import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { validatePrivateAggregateRows } from './private-input-contract.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const privateRoot = path.resolve(projectRoot, '系统数据', 'private')
const input = process.argv[2]

if (process.env.RADAR_PRIVATE_IMPORT_APPROVED !== '1') {
  console.log(JSON.stringify({ state: 'blocked_private_import_not_approved', privateDataAccessed: false, note: '私密聚合导入验证需要单独人工批准；本次未读取文件。' }))
  process.exitCode = 2
} else if (!input) {
  console.log(JSON.stringify({ state: 'blocked_missing_input', privateDataAccessed: false }))
  process.exitCode = 2
} else {
  const resolved = path.resolve(input)
  if (!resolved.startsWith(`${privateRoot}${path.sep}`)) {
    console.log(JSON.stringify({ state: 'blocked_path_outside_private_root', privateDataAccessed: false }))
    process.exitCode = 2
  } else {
    const text = await fs.readFile(resolved, 'utf8')
    const [headerLine, ...lines] = text.split(/\r?\n/).filter(Boolean)
    const headers = headerLine.split(',').map((value) => value.trim())
    const rows = lines.map((line) => Object.fromEntries(line.split(',').map((value, index) => [headers[index], value.trim()])))
    const validation = validatePrivateAggregateRows(headers, rows)
    console.log(JSON.stringify({ state: validation.ok ? 'validated_not_imported' : 'validation_failed', privateDataAccessed: true, imported: false, acceptedRows: validation.acceptedRows, errorCodes: validation.errors.slice(0, 20) }))
    process.exitCode = validation.ok ? 0 : 2
  }
}
