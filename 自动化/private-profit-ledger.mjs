import crypto from 'node:crypto'

const verified = 'VERIFIED'
const blocked = 'BLOCKED'
const minimumScaleSample = 10

function number(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error('invalid_numeric_value')
  return parsed
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function findEffectiveEconomics(economics, aggregate) {
  const date = String(aggregate.date)
  return economics
    .filter((row) => row.product_key === aggregate.product_key && row.country === aggregate.country && row.currency === aggregate.currency && row.effective_from <= date)
    .sort((left, right) => String(right.effective_from).localeCompare(String(left.effective_from)))[0] || null
}

function expectedMetrics(model) {
  const listedPrice = number(model.listed_price)
  const directCost = ['landed_product_cost', 'packaging_cost', 'warehouse_cost', 'outbound_shipping_cost', 'duties_tax_cost', 'support_cost', 'other_variable_cost']
    .reduce((sum, key) => sum + number(model[key]), 0)
  const paymentFee = listedPrice * number(model.payment_fee_rate)
  const refundReserve = number(model.refund_rate) * number(model.refund_loss_per_order)
  const chargebackReserve = number(model.chargeback_rate) * listedPrice
  const allowableCpa = listedPrice - directCost - paymentFee - refundReserve - chargebackReserve
  return {
    listedPrice: round(listedPrice), directCostPerOrder: round(directCost), paymentFeePerOrder: round(paymentFee),
    refundReservePerOrder: round(refundReserve), chargebackReservePerOrder: round(chargebackReserve),
    allowableCpa: round(allowableCpa),
    breakEvenRoas: allowableCpa > 0 ? round(listedPrice / allowableCpa) : null,
  }
}

function decisionFor(model, expected, actual) {
  const statuses = ['rights_status', 'responsible_party_status', 'fulfillment_status'].map((key) => String(model[key]))
  if (statuses.includes(blocked)) return { decision: 'REJECT', reason: '权利、责任主体或履约状态为 BLOCKED' }
  if (statuses.some((status) => status !== verified)) return { decision: 'EVIDENCE_REQUIRED', reason: '权利、责任主体或履约证据尚未全部 VERIFIED' }
  if (expected.allowableCpa <= 0) return { decision: 'REJECT', reason: 'Allowable CPA 小于或等于 0' }
  if (actual.actualContributionProfit < 0) return { decision: 'STOP', reason: '实际贡献利润为负' }
  if (actual.ordersCount >= minimumScaleSample && actual.actualContributionProfit > 0) return { decision: 'SCALE_CANDIDATE', reason: `至少 ${minimumScaleSample} 笔聚合订单且实际贡献利润为正；仍需单独审批，不代表可自动扩量` }
  return { decision: 'TEST_READY', reason: '单位经济、权利、责任主体与履约字段已验证；样本尚不足以判断扩量' }
}

export function buildPrivateProfitLedger(aggregates, economics) {
  const entries = []
  const missingEconomics = []
  for (const aggregate of aggregates) {
    const model = findEffectiveEconomics(economics, aggregate)
    const identity = { date: aggregate.date, product_key: aggregate.product_key, country: aggregate.country, currency: aggregate.currency }
    if (!model) {
      missingEconomics.push(identity)
      entries.push({ ...identity, decision: 'EVIDENCE_REQUIRED', reason: '缺少生效的单位经济模型', calculable: false })
      continue
    }
    const expected = expectedMetrics(model)
    const ordersCount = number(aggregate.orders_count)
    const netRevenue = number(aggregate.revenue_before_refunds_chargebacks)
    const refunds = number(aggregate.refund_amount)
    const chargebacks = number(aggregate.chargeback_amount)
    const adSpend = number(aggregate.ad_spend)
    const directCost = ordersCount * expected.directCostPerOrder
    const paymentFees = netRevenue * number(model.payment_fee_rate)
    const actualContributionProfit = netRevenue - directCost - paymentFees - refunds - chargebacks - adSpend
    const actual = {
      ordersCount,
      netRevenue: round(netRevenue),
      refundAmount: round(refunds),
      chargebackAmount: round(chargebacks),
      adSpend: round(adSpend),
      directCost: round(directCost),
      paymentFees: round(paymentFees),
      actualContributionProfit: round(actualContributionProfit),
      actualContributionMargin: netRevenue > 0 ? round(actualContributionProfit / netRevenue) : null,
      actualRoas: adSpend > 0 ? round(netRevenue / adSpend) : null,
      actualCpa: number(aggregate.attributed_purchases) > 0 ? round(adSpend / number(aggregate.attributed_purchases)) : null,
    }
    const outcome = decisionFor(model, expected, actual)
    entries.push({ ...identity, effective_from: model.effective_from, calculable: true, expected, actual, ...outcome })
  }
  const decisions = Object.fromEntries(['REJECT', 'EVIDENCE_REQUIRED', 'TEST_READY', 'STOP', 'SCALE_CANDIDATE'].map((decision) => [decision, entries.filter((entry) => entry.decision === decision).length]))
  return { schemaVersion: 1, minimumScaleSample, entries, summary: { total: entries.length, calculable: entries.filter((entry) => entry.calculable).length, missingEconomics: missingEconomics.length, decisions } }
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}
