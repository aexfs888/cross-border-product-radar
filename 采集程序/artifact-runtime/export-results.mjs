import fs from 'node:fs/promises'
import path from 'node:path'
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) throw new Error('用法：export-results.mjs <input.json> <output.xlsx>')
const data = JSON.parse(await fs.readFile(inputPath, 'utf8'))
const products = Array.isArray(data.products) ? data.products : []
const reusable = data.bucket === 'REUSABLE'
if (!reusable && products.some((product) => Number(product.peak_heat_score || product.research_heat_score || 0) < 60)) throw new Error('普通热度不可复用商品不得进入研究报表')

const workbook = Workbook.create()
workbook.comments.setSelf({ displayName: '跨境热销商品雷达' })
const colors = { navy: '#15324B', blue: '#21618C', cyan: '#DDEFF7', green: '#1F7A5A', mint: '#DFF3E8', red: '#B64C4C', rose: '#F8E2E2', amber: '#C77B16', sand: '#FFF0D5', ink: '#17212B', muted: '#61717F', line: '#D8E0E6', white: '#FFFFFF', paper: '#F7F9FB' }
const sheetNames = reusable
  ? ['使用说明', '商品总览', '国家趋势', '时间趋势', '供应与物流', '可复用素材', '授权记录', '风险检查', '证据链', '运行审计']
  : ['使用说明', '商品研究总览', '国家趋势', '时间趋势', '不能复用原因', '风险与召回', '未授权素材链接', '待补资料与转库条件', '证据链', '运行审计']
const sheets = Object.fromEntries(sheetNames.map((name) => [name, workbook.worksheets.add(name)]))

function colLetter(number) {
  let result = ''; let value = number
  while (value > 0) { const remainder = (value - 1) % 26; result = String.fromCharCode(65 + remainder) + result; value = Math.floor((value - 1) / 26) }
  return result
}
function safeText(value) {
  if (value === null || value === undefined || value === '') return '未知'
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item)).join('；') : '未知'
  if (typeof value === 'object') return Object.keys(value).length ? JSON.stringify(value) : '未知'
  return value
}
function dossierField(product, dotted) {
  let current = product.dossier
  for (const segment of dotted.split('.')) current = current?.[segment]
  if (current && typeof current === 'object' && 'state' in current) return { state: current.state, value: safeText(current.value), note: current.note || '' }
  return { state: '未知', value: '未知', note: '当前公开证据不足，未作推测' }
}
function baseSheet(sheet, title, subtitle, lastColumn) {
  sheet.showGridLines = false
  sheet.getRange(`A1:${lastColumn}1`).format.fill = colors.navy; sheet.getRange(`A2:${lastColumn}2`).format.fill = colors.cyan
  sheet.getRange('A1:H1').merge(); sheet.getRange('A1').values = [[title]]
  sheet.getRange('A2:H2').merge(); sheet.getRange('A2').values = [[subtitle]]
  sheet.getRange('A1:H1').format = { fill: colors.navy, font: { bold: true, color: colors.white, size: 17 }, verticalAlignment: 'center' }
  sheet.getRange('A2:H2').format = { fill: colors.cyan, font: { color: colors.navy, size: 9 }, verticalAlignment: 'center', wrapText: true }
  sheet.getRange('A1').format.rowHeightPx = 36; sheet.getRange('A2').format.rowHeightPx = 34
}
function header(range) { range.format = { fill: reusable ? colors.green : colors.blue, font: { bold: true, color: colors.white, size: 9 }, wrapText: true, verticalAlignment: 'center', borders: { bottom: { style: 'medium', color: colors.navy } } }; range.format.rowHeightPx = 34 }
function body(range) { range.format = { font: { color: colors.ink, size: 9 }, wrapText: true, verticalAlignment: 'top', borders: { insideHorizontal: { style: 'thin', color: colors.line } } } }
function addTableSheet(name, title, subtitle, headers, rows, widths = []) {
  const sheet = sheets[name]; const last = colLetter(headers.length)
  baseSheet(sheet, title, subtitle, last)
  sheet.getRange(`A4:${last}4`).values = [headers]; header(sheet.getRange(`A4:${last}4`)); sheet.freezePanes.freezeRows(4); sheet.freezePanes.freezeColumns(Math.min(2, headers.length))
  if (rows.length) {
    const end = 4 + rows.length; sheet.getRange(`A5:${last}${end}`).values = rows; body(sheet.getRange(`A5:${last}${end}`))
    for (let row = 5; row <= end; row += 1) if (row % 2 === 0) sheet.getRange(`A${row}:${last}${row}`).format.fill = colors.paper
  } else {
    if (headers.length > 1) sheet.getRange('B5:H6').merge()
    sheet.getRange('B5').values = [['当前没有符合本工作表条件的商品。系统不会为了凑数量而降低证据、授权或热度门槛。']]
    sheet.getRange('B5').format = { fill: colors.paper, font: { color: colors.muted, italic: true }, horizontalAlignment: 'center', verticalAlignment: 'center', wrapText: true }
    sheet.getRange('B5').format.rowHeightPx = 48
  }
  widths.forEach((width, index) => sheet.getRange(`${colLetter(index + 1)}:${colLetter(index + 1)}`).format.columnWidthPx = width)
  return sheet
}
function formatDateColumns(sheet, columns, rowCount) {
  if (!rowCount) return
  const end = 4 + rowCount
  for (const column of columns) sheet.getRange(`${column}5:${column}${end}`).format.numberFormat = 'yyyy-mm-dd hh:mm:ss'
}

const overviewName = reusable ? '商品总览' : '商品研究总览'
const overviewHeaders = ['商品ID', '原始名称', '中文名称', '品牌', '型号', 'GTIN', 'MPN', '类别', '趋势区间', '研究热度', '热度等级', '商业分', '商业级别', '完整度%', '可信度', '素材权利', '当前库', reusable ? '复用资格复核' : '研究保留复核', '判定原因', '商品完整说明摘要', '优点', '缺点/风险', '未知/待补资料', '最近证据时间']
const overviewRows = products.map((product) => [
  product.id, product.original_name, product.zh_name || '未知', product.brand || '未知', product.model || '未知', product.gtin || '未知', product.mpn || '未知', product.category || '未知', product.trend_age_band,
  Number(product.research_heat_score || 0), '', Number(product.commercial_score || 0), product.commercial_grade, Number(product.completeness || 0) / 100, Number(product.confidence || 0), product.rights_status,
  product.reuse_bucket, '', product.restriction_reason || product.research_reason || '未知', product.dossier?.summary || '未知',
  dossierField(product, 'balancedAssessment.advantages').value, dossierField(product, 'balancedAssessment.disadvantages').value,
  dossierField(product, 'balancedAssessment.unknownInformation').value, product.last_seen_at,
])
const overview = addTableSheet(overviewName, reusable ? '可复用商品完整说明总览' : '高热度不可复用商品研究总览', reusable ? '只有全部商业复用闸门通过的商品才会出现。' : '只保留当前或历史峰值研究热度达到 60 分的不可复用商品；普通热度商品不进入本表。', overviewHeaders, overviewRows, [210, 300, 180, 120, 120, 130, 130, 130, 120, 90, 100, 90, 100, 90, 80, 100, 110, 120, 350, 420, 240, 260, 320, 170])
if (products.length) {
  const end = 4 + products.length
  overview.getRange(`K5:K${end}`).formulas = products.map((_, index) => [`=IF(J${index + 5}>=80,"爆发",IF(J${index + 5}>=60,"上升",IF(J${index + 5}>=40,"普通","低")))`])
  overview.getRange(`R5:R${end}`).formulas = products.map((_, index) => reusable
    ? [`=IF(AND(N${index + 5}>=85%,O${index + 5}>=0.75,P${index + 5}="AUTHORIZED",Q${index + 5}="REUSABLE"),"通过","复核")`]
    : [`=IF(AND(J${index + 5}>=60,Q${index + 5}="NON_REUSABLE"),"保留研究","排除")`])
  overview.getRange(`J5:J${end}`).format.numberFormat = '0.00'; overview.getRange(`L5:L${end}`).format.numberFormat = '0.00'
  overview.getRange(`N5:O${end}`).format.numberFormat = '0.0%'; overview.getRange(`X5:X${end}`).format.numberFormat = 'yyyy-mm-dd hh:mm'
  overview.getRange(`J5:J${end}`).conditionalFormats.add('colorScale', { colors: ['#F8E2E2', '#FFF0D5', '#DFF3E8'], thresholds: ['min', '50%', 'max'] })
  overview.getRange(`R5:R${end}`).conditionalFormats.add('containsText', { text: reusable ? '通过' : '保留研究', format: { fill: colors.mint, font: { bold: true, color: colors.green } } })
}

const countryRows = []
for (const product of products) for (const [code, block] of Object.entries(product.dossier?.countryPerformance || {})) countryRows.push([
  product.id, product.zh_name || product.original_name, code, block.countryName?.value || code, block.evidenceCount?.state || '未知', block.evidenceCount?.value ?? 0,
  block.latestEvidenceAt?.value || '未知', safeText(block.search?.value), safeText(block.news?.value), safeText(block.ads?.value), safeText(block.offers?.value), safeText(block.reviews?.value), safeText(block.publicSales?.value),
])
const countrySheet = addTableSheet('国家趋势', '11个目标国家分别表现', '零证据只表示当前获准来源未发现，不代表该国市场绝对没有需求。', ['商品ID', '商品', '国家代码', '国家', '字段状态', '证据数', '最近证据', '搜索', '新闻', '广告', '报价', '评价', '公开销量'], countryRows, [210, 280, 90, 100, 100, 80, 170, 280, 300, 220, 220, 220, 220])
formatDateColumns(countrySheet, ['G'], countryRows.length)

const timeRows = []
for (const product of products) for (const [windowName, block] of Object.entries(product.dossier?.chronology?.timeWindows || {})) timeRows.push([
  product.id, product.zh_name || product.original_name, windowName, block.observedEvidenceCount?.state || '未知', block.observedEvidenceCount?.value ?? 0,
  safeText(block.sourceFamilies?.value), safeText(block.countries?.value), safeText(block.searchSignals?.value), safeText(block.publicSalesSignals?.value),
])
addTableSheet('时间趋势', '七个时间区间趋势证据', '覆盖 0–7、8–15、16–30、31–60、61–90、91–120、121–180 天；不把缺失证据填成销量。', ['商品ID', '商品', '时间区间', '字段状态', '证据数', '来源家族', '国家', '搜索信号', '公开销量信号'], timeRows, [210, 280, 160, 100, 80, 180, 160, 360, 360])

const evidenceRows = products.flatMap((product) => (product.events || []).map((event) => [product.id, product.zh_name || product.original_name, event.eventId, event.sourceId, event.sourceFamily, event.countryCode, event.eventType, event.sourceUrl, event.publishedAt || '未知', event.observedAt, event.evidenceStrength, event.rightsStatus, event.policyDecision, event.rawHash]))
const evidenceSheet = addTableSheet('证据链', '完整证据链', '每条证据保留编号、原始网址、发布时间、采集时间、强度、权利与政策决定。', ['商品ID', '商品', '证据ID', '来源', '来源家族', '国家', '类型', 'URL', '发布时间', '采集时间', '证据强度', '权利', '采集政策', '原始哈希'], evidenceRows, [210, 260, 250, 170, 110, 80, 100, 420, 170, 170, 100, 110, 150, 250])
formatDateColumns(evidenceSheet, ['I', 'J'], evidenceRows.length)

const auditRows = (data.audits || []).map((item) => [item.created_at, item.type, item.severity, item.message, item.meta_json])
const auditSheet = addTableSheet('运行审计', '运行、转库、清理与备份审计', '记录系统做过什么，不隐藏低热度清理或来源失败。', ['时间', '类型', '严重度', '说明', '细节'], auditRows, [170, 210, 90, 420, 500])
formatDateColumns(auditSheet, ['A'], auditRows.length)

if (reusable) {
  const supplyRows = products.map((product) => [product.id, product.zh_name || product.original_name, ...['supplierName', 'supplierUrl', 'supplierVerified', 'moq', 'leadTimeDays', 'shipsTo', 'returnsPolicy', 'logisticsRestrictions'].flatMap((key) => { const item = dossierField(product, `supplyAndLogistics.${key}`); return [item.state, item.value] })])
  addTableSheet('供应与物流', '供应商与物流完整核验', '每个项目均同时显示字段状态和值；未知不得猜测。', ['商品ID', '商品', '供应商状态', '供应商', '网址状态', '网址', '核验状态', '已核验', 'MOQ状态', 'MOQ', '交期状态', '交期天数', '可送国家状态', '可送国家', '退货状态', '退货', '限制状态', '物流限制'], supplyRows, [210, 260, 90, 160, 90, 300, 90, 100, 90, 80, 90, 100, 100, 220, 90, 320, 90, 320])
  const mediaRows = products.flatMap((product) => (product.media || []).filter((item) => item.rights_status === 'AUTHORIZED').map((item) => [product.id, product.zh_name || product.original_name, item.media_type, item.url, item.rights_status, item.license || '未知', item.attribution || '未知', item.event_id, item.created_at]))
  const mediaSheet = addTableSheet('可复用素材', '明确允许商业使用的素材', '只列 AUTHORIZED 素材；系统不会下载或搬运未知权利素材。', ['商品ID', '商品', '类型', 'URL', '权利状态', '许可证', '署名要求', '证据ID', '记录时间'], mediaRows, [210, 260, 90, 420, 110, 180, 240, 240, 170])
  formatDateColumns(mediaSheet, ['I'], mediaRows.length)
  addTableSheet('授权记录', '素材授权审计记录', '上架前仍需人工确认许可证原文、适用范围、有效期与署名要求。', ['商品ID', '商品', '素材URL', '许可证', '署名', '权利状态', '证据ID'], mediaRows.map((row) => [row[0], row[1], row[3], row[5], row[6], row[4], row[7]]), [210, 260, 420, 220, 260, 110, 240])
  const riskRows = products.map((product) => [product.id, product.zh_name || product.original_name, dossierField(product, 'riskReview.recallAndSafety').state, dossierField(product, 'riskReview.recallAndSafety').value, dossierField(product, 'riskReview.regulatory').value, dossierField(product, 'riskReview.trademarkAndIp').value, dossierField(product, 'riskReview.logistics').value, dossierField(product, 'riskReview.allFlags').value, product.restriction_reason])
  addTableSheet('风险检查', '召回、安全、监管、商标与知识产权风险', '可复用商品应无未解决红色风险；本表是初筛，不替代律师、责任主体或实验室结论。', ['商品ID', '商品', '状态', '召回/安全', '监管', '商标/IP', '物流', '全部风险', '当前结论'], riskRows, [210, 260, 90, 260, 260, 260, 260, 300, 360])
} else {
  const reasonRows = products.map((product) => [product.id, product.zh_name || product.original_name, product.research_heat_score, product.peak_heat_score, product.restriction_reason, safeText(product.riskFlags), safeText(product.missingRequirements), product.rights_status])
  addTableSheet('不能复用原因', '高热度商品不能复用的原因', '热度高不等于可以上架；授权、身份、召回、监管、供应或责任主体任一不通过就留在研究库。', ['商品ID', '商品', '当前热度', '峰值热度', '不能复用原因', '风险标记', '待补资料', '素材权利'], reasonRows, [210, 280, 90, 90, 420, 320, 380, 110])
  const riskRows = products.map((product) => [product.id, product.zh_name || product.original_name, dossierField(product, 'riskReview.recallAndSafety').state, dossierField(product, 'riskReview.recallAndSafety').value, dossierField(product, 'riskReview.regulatory').value, dossierField(product, 'riskReview.trademarkAndIp').value, dossierField(product, 'riskReview.logistics').value, dossierField(product, 'riskReview.allFlags').value])
  addTableSheet('风险与召回', '召回、安全、监管、知识产权与物流风险', '只作研究引用；疑似召回匹配必须回到官方页面人工确认商品身份。', ['商品ID', '商品', '状态', '召回/安全', '监管', '商标/IP', '物流', '全部风险'], riskRows, [210, 280, 90, 300, 280, 280, 260, 360])
  const mediaRows = products.flatMap((product) => (product.media || []).map((item) => [product.id, product.zh_name || product.original_name, item.media_type, item.url, item.rights_status, item.license || '未知', item.attribution || '未知', '只保留链接和元数据，不下载、不去水印、不商业复用']))
  addTableSheet('未授权素材链接', '公开素材链接与权利说明', '这些链接仅供研究；未知或 LINK_ONLY 不代表商业授权。', ['商品ID', '商品', '类型', '公开URL', '权利状态', '许可证', '署名', '强制限制'], mediaRows, [210, 280, 90, 430, 110, 180, 220, 360])
  const missingRows = products.flatMap((product) => (product.missingRequirements || []).map((requirement) => [product.id, product.zh_name || product.original_name, requirement, product.restriction_reason, '补齐资料后重新运行全部安全、授权、完整度和可信度闸门；不得人工强制转库']))
  addTableSheet('待补资料与转库条件', '转入可复用库前必须补齐的资料', '全部条件同时通过才允许转库；出现新召回、授权失效或知识产权风险会立即退回研究库。', ['商品ID', '商品', '待补资料', '当前原因', '转库条件'], missingRows, [210, 280, 380, 420, 420])
}

const guide = sheets['使用说明']; baseSheet(guide, reusable ? '可复用商品报表使用说明' : '高热度不可复用商品研究报表使用说明', `生成时间：${data.generatedAt}｜项目：${data.projectName}｜数据结论以证据状态为准`, 'H')
guide.getRange('A4:B11').values = [
  ['指标', '结果'], ['商品数', ''], ['字段状态规则', '已验证 / 来源冲突 / 未知 / 不适用'], ['销量与利润', '没有公开证据时一律未知，不做估算'],
  ['素材处理', reusable ? '只列明确商业授权素材' : '只列公开链接与元数据，不下载、不复用'], ['低热不可复用', reusable ? '与本表无关' : '热度低于60分不进入本研究报表'],
  ['最终责任', '本系统是研究与初筛工具，上架前仍需供应、合规、授权和税务人工复核'], ['证据原则', '热度、浏览量、新闻和广告只代表信号，不等于真实销量或利润'],
]
header(guide.getRange('A4:B4')); body(guide.getRange('A5:B11')); guide.getRange('A:A').format.columnWidthPx = 210; guide.getRange('B:B').format.columnWidthPx = 720
guide.getRange('B5').formulas = [[`=COUNTA('${overviewName}'!A5:A10000)`]]
guide.getRange('A13:H15').merge(); guide.getRange('A13').values = [[reusable ? '本表只有在商品身份、供应、价格、物流、责任主体、风险、资料完整度、证据可信度和商业素材授权全部过关后才收录。' : '本表仅保留很火但当前不能安全商业复用的商品。普通热度不可复用商品会在30天待复核区观察，仍未升温则删除详细内容，只留下匿名墓碑以避免短期重复采集。']]
guide.getRange('A13').format = { fill: reusable ? colors.mint : colors.sand, font: { bold: true, color: reusable ? colors.green : colors.amber, size: 11 }, wrapText: true, verticalAlignment: 'center' }; guide.getRange('A13').format.rowHeightPx = 64

const verificationRoot = path.join(path.dirname(outputPath), 'verification', path.basename(outputPath, '.xlsx'))
await fs.mkdir(verificationRoot, { recursive: true })
const checks = []
for (const name of sheetNames) {
  const inspection = await workbook.inspect({ kind: 'table', range: `${name}!A1:H15`, include: 'values,formulas', tableMaxRows: 15, tableMaxCols: 8 })
  checks.push({ sheet: name, inspection: inspection.ndjson.slice(0, 2000) })
  const preview = await workbook.render({ sheetName: name, range: 'A1:H15', scale: 0.75, format: 'png' })
  await fs.writeFile(path.join(verificationRoot, `${name.replace(/[\\/:*?"<>|]/g, '_')}.png`), new Uint8Array(await preview.arrayBuffer()))
}
const errors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A', options: { useRegex: true, maxResults: 300 }, summary: 'final formula error scan' })
await fs.writeFile(path.join(verificationRoot, 'verification-summary.json'), JSON.stringify({ sheets: sheetNames, checks, formulaErrors: errors.ndjson }, null, 2))
await fs.mkdir(path.dirname(outputPath), { recursive: true })
const output = await SpreadsheetFile.exportXlsx(workbook); await output.save(outputPath)
console.log(JSON.stringify({ ok: true, bucket: data.bucket, sheets: sheetNames.length, products: products.length, renderedSheets: sheetNames.length, formulaErrorScan: errors.ndjson, outputPath }))
