const countries = new Set(['GB', 'US', 'AU', 'CA', 'NZ', 'CH', 'IE', 'NO', 'SE', 'DK', 'FI'])

const aggregateRequiredColumns = [
  'date', 'product_key', 'country', 'currency', 'orders_count', 'net_revenue',
  'refunds_count', 'refund_amount', 'chargebacks_count', 'chargeback_amount',
  'ad_spend', 'attributed_purchases',
]

const unitEconomicsRequiredColumns = [
  'product_key', 'country', 'currency', 'effective_from', 'listed_price',
  'landed_product_cost', 'packaging_cost', 'warehouse_cost', 'outbound_shipping_cost',
  'duties_tax_cost', 'payment_fee_rate', 'refund_rate', 'chargeback_rate',
  'refund_loss_per_order', 'support_cost', 'other_variable_cost', 'inventory_units',
  'replenishment_days', 'rights_status', 'responsible_party_status', 'fulfillment_status',
]

const forbiddenColumnPattern = /(^|_)(customer|email|phone|name|address|ip|cookie|token|order_id|checkout|payment|card)(_|$)/i
const monetaryColumns = new Set([
  'net_revenue', 'refund_amount', 'chargeback_amount', 'ad_spend', 'listed_price',
  'landed_product_cost', 'packaging_cost', 'warehouse_cost', 'outbound_shipping_cost',
  'duties_tax_cost', 'refund_loss_per_order', 'support_cost', 'other_variable_cost',
])
const nonNegativeColumns = new Set([
  'orders_count', 'refunds_count', 'chargebacks_count', 'attributed_purchases',
  ...monetaryColumns, 'inventory_units', 'replenishment_days',
])
const rateColumns = new Set(['payment_fee_rate', 'refund_rate', 'chargeback_rate'])
const statusColumns = new Set(['rights_status', 'responsible_party_status', 'fulfillment_status'])

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

function parseRate(value, field, errors) {
  const number = parseNumber(value, field, errors)
  if (number !== null && number > 1) errors.push(`${field}:must_be_decimal_between_0_and_1`)
  return number
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
}

function validateHeaders(headers, requiredColumns) {
  const normalized = headers.map((header) => String(header).trim())
  const errors = []
  for (const column of requiredColumns) if (!normalized.includes(column)) errors.push(`missing_column:${column}`)
  for (const column of normalized) if (forbiddenColumnPattern.test(column) && !requiredColumns.includes(column)) errors.push(`forbidden_column:${column}`)
  return { ok: errors.length === 0, errors }
}

function validateCommonRow(row, prefix, errors, { dateField = 'date' } = {}) {
  if (!isIsoDate(row[dateField])) errors.push(`${prefix}:${dateField}:invalid_iso_date`)
  if (!String(row.product_key ?? '').match(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/)) errors.push(`${prefix}:product_key:invalid_pseudonym`)
  if (!countries.has(row.country)) errors.push(`${prefix}:country:outside_configured_scope`)
  if (!/^[A-Z]{3}$/.test(String(row.currency ?? ''))) errors.push(`${prefix}:currency:invalid_iso_code`)
}

export function validatePrivateAggregateHeaders(headers) {
  return validateHeaders(headers, aggregateRequiredColumns)
}

export function validatePrivateAggregateRows(headers, rows) {
  const headerCheck = validatePrivateAggregateHeaders(headers)
  if (!headerCheck.ok) return { ok: false, errors: headerCheck.errors, acceptedRows: 0 }
  const errors = []
  let acceptedRows = 0
  for (const [index, row] of rows.entries()) {
    const prefix = `row_${index + 2}`
    validateCommonRow(row, prefix, errors)
    for (const field of aggregateRequiredColumns.filter((column) => nonNegativeColumns.has(column))) parseNumber(row[field], `${prefix}:${field}`, errors)
    if (!errors.some((error) => error.startsWith(`${prefix}:`))) acceptedRows += 1
  }
  return { ok: errors.length === 0, errors, acceptedRows }
}

export function validateUnitEconomicsHeaders(headers) {
  return validateHeaders(headers, unitEconomicsRequiredColumns)
}

export function validateUnitEconomicsRows(headers, rows) {
  const headerCheck = validateUnitEconomicsHeaders(headers)
  if (!headerCheck.ok) return { ok: false, errors: headerCheck.errors, acceptedRows: 0 }
  const errors = []
  let acceptedRows = 0
  for (const [index, row] of rows.entries()) {
    const prefix = `row_${index + 2}`
    validateCommonRow(row, prefix, errors, { dateField: 'effective_from' })
    for (const field of unitEconomicsRequiredColumns.filter((column) => nonNegativeColumns.has(column))) parseNumber(row[field], `${prefix}:${field}`, errors)
    for (const field of rateColumns) parseRate(row[field], `${prefix}:${field}`, errors)
    for (const field of statusColumns) if (!['VERIFIED', 'PENDING', 'BLOCKED'].includes(String(row[field] ?? ''))) errors.push(`${prefix}:${field}:invalid_status`)
    if (!errors.some((error) => error.startsWith(`${prefix}:`))) acceptedRows += 1
  }
  return { ok: errors.length === 0, errors, acceptedRows }
}

export const privateAggregateContract = { requiredColumns: aggregateRequiredColumns, countries: [...countries] }
export const unitEconomicsContract = { requiredColumns: unitEconomicsRequiredColumns, countries: [...countries] }
