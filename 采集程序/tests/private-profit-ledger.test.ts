import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error Node-only local private contract has no declaration file.
import { buildPrivateProfitLedger } from '../../自动化/private-profit-ledger.mjs'

const model = {
  product_key: 'product_7f3a', country: 'GB', currency: 'GBP', effective_from: '2026-09-01',
  listed_price: '100', landed_product_cost: '20', packaging_cost: '2', warehouse_cost: '3', outbound_shipping_cost: '5', duties_tax_cost: '4',
  payment_fee_rate: '0.03', refund_rate: '0.1', chargeback_rate: '0.02', refund_loss_per_order: '10', support_cost: '2', other_variable_cost: '1',
  inventory_units: '100', replenishment_days: '14', rights_status: 'VERIFIED', responsible_party_status: 'VERIFIED', fulfillment_status: 'VERIFIED',
}

function aggregate(overrides: Record<string, string> = {}) {
  return {
    date: '2026-09-06', product_key: 'product_7f3a', country: 'GB', currency: 'GBP', orders_count: '12', net_revenue: '1200',
    refunds_count: '1', refund_amount: '100', chargebacks_count: '0', chargeback_amount: '0', ad_spend: '300', attributed_purchases: '10', ...overrides,
  }
}

test('利润账本按聚合订单计算贡献利润和扩量候选，不把平台 ROAS 当利润', () => {
  const ledger = buildPrivateProfitLedger([aggregate()], [model])
  assert.equal(ledger.summary.calculable, 1)
  const entry = ledger.entries[0]
  assert.equal(entry.decision, 'SCALE_CANDIDATE')
  assert.equal(entry.expected.allowableCpa, 57)
  assert.equal(entry.expected.breakEvenRoas, 1.75)
  assert.equal(entry.actual.actualRoas, 4)
  assert.equal(entry.actual.actualContributionProfit, 320)
})

test('利润账本在模型缺失、状态未验证和实际亏损时严格降级或停止', () => {
  const missing = buildPrivateProfitLedger([aggregate()], [])
  assert.equal(missing.entries[0].decision, 'EVIDENCE_REQUIRED')
  const pending = buildPrivateProfitLedger([aggregate()], [{ ...model, rights_status: 'PENDING' }])
  assert.equal(pending.entries[0].decision, 'EVIDENCE_REQUIRED')
  const loss = buildPrivateProfitLedger([aggregate({ ad_spend: '800' })], [model])
  assert.equal(loss.entries[0].decision, 'STOP')
})
