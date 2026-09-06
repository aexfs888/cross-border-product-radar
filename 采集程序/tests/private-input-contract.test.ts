import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error This Node-only local contract intentionally has no TypeScript declaration file.
import { privateAggregateContract, validatePrivateAggregateHeaders, validatePrivateAggregateRows } from '../../自动化/private-input-contract.mjs'

test('私密聚合合同只接受11国、匿名商品键和聚合指标', () => {
  const headers = privateAggregateContract.requiredColumns
  const result = validatePrivateAggregateRows(headers, [{
    date: '2026-09-06', product_key: 'product_7f3a', country: 'GB', currency: 'GBP',
    orders_count: '12', net_revenue: '1000', refunds_count: '1', refund_amount: '20',
    chargebacks_count: '0', chargeback_amount: '0', ad_spend: '200', attributed_purchases: '8',
  }])
  assert.deepEqual(result, { ok: true, errors: [], acceptedRows: 1 })
})

test('私密聚合合同拒绝PII列、未配置国家和负金额', () => {
  const headers = [...privateAggregateContract.requiredColumns, 'customer_email']
  const headerResult = validatePrivateAggregateHeaders(headers)
  assert.equal(headerResult.ok, false)
  assert.ok(headerResult.errors.includes('forbidden_column:customer_email'))
  const rowResult = validatePrivateAggregateRows(privateAggregateContract.requiredColumns, [{
    date: '2026-09-06', product_key: 'product_7f3a', country: 'DE', currency: 'EUR',
    orders_count: '1', net_revenue: '-1', refunds_count: '0', refund_amount: '0',
    chargebacks_count: '0', chargeback_amount: '0', ad_spend: '0', attributed_purchases: '0',
  }])
  assert.equal(rowResult.ok, false)
  assert.ok(rowResult.errors.includes('row_2:country:outside_configured_scope'))
  assert.ok(rowResult.errors.includes('row_2:net_revenue:invalid_nonnegative_number'))
})
