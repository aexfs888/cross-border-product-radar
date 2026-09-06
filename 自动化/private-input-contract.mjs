const countries = new Set(['GB', 'US', 'AU', 'CA', 'NZ', 'CH', 'IE', 'NO', 'SE', 'DK', 'FI'])
const requiredColumns = [
  'date', 'product_key', 'country', 'currency', 'orders_count', 'net_revenue',
  'refunds_count', 'refund_amount', 'chargebacks_count', 'chargeback_amount',
  'ad_spend', 'attributed_purchases',
]
const forbiddenColumnPattern = /(^|_)(customer|email|phone|name|address|ip|cookie|token|order_id|checkout|payment|card)(_|$)/i

function parseNumber(value, field, errors) {
  if (value === '' || value === undefined || value === null) {
    errors.push(`${field}:missing`)
    return null
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) {
    errors.push(`${field}:invalid_nonnegative_number`)
    return null
  }
  return number
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
}

export function validatePrivateAggregateHeaders(headers) {
  const normalized = headers.map((header) => String(header).trim())
  const errors = []
  for (const column of requiredColumns) if (!normalized.includes(column)) errors.push(`missing_column:${column}`)
  for (const column of normalized) if (forbiddenColumnPattern.test(column)) errors.push(`forbidden_column:${column}`)
  return { ok: errors.length === 0, errors }
}

export function validatePrivateAggregateRows(headers, rows) {
  const headerCheck = validatePrivateAggregateHeaders(headers)
  if (!headerCheck.ok) return { ok: false, errors: headerCheck.errors, acceptedRows: 0 }
  const errors = []
  let acceptedRows = 0
  for (const [index, row] of rows.entries()) {
    const prefix = `row_${index + 2}`
    if (!isIsoDate(row.date)) errors.push(`${prefix}:date:invalid_iso_date`)
    if (!String(row.product_key ?? '').match(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/)) errors.push(`${prefix}:product_key:invalid_pseudonym`)
    if (!countries.has(row.country)) errors.push(`${prefix}:country:outside_configured_scope`)
    if (!/^[A-Z]{3}$/.test(String(row.currency ?? ''))) errors.push(`${prefix}:currency:invalid_iso_code`)
    for (const field of requiredColumns.filter((column) => /(_count|_amount|revenue|spend|purchases)$/.test(column))) parseNumber(row[field], `${prefix}:${field}`, errors)
    if (!errors.some((error) => error.startsWith(`${prefix}:`))) acceptedRows += 1
  }
  return { ok: errors.length === 0, errors, acceptedRows }
}

export const privateAggregateContract = { requiredColumns, countries: [...countries] }
