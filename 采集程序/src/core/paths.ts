import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

export const projectRoot = path.resolve(process.env.RADAR_ROOT || path.join(moduleDir, '..', '..', '..'))
export const paths = {
  root: projectRoot,
  reusable: path.join(projectRoot, '可复用商品'),
  nonReusable: path.join(projectRoot, '不可复用商品'),
  data: path.join(projectRoot, '系统数据'),
  keys: path.join(projectRoot, '系统数据', 'keys'),
  inbox: path.join(projectRoot, '系统数据', 'cloud-inbox'),
  state: path.join(projectRoot, '系统数据', 'cloud-state'),
  history: path.join(projectRoot, '系统数据', '档案历史'),
  reports: path.join(projectRoot, '报表'),
  logs: path.join(projectRoot, '运行日志'),
  temp: path.join(projectRoot, '临时文件'),
  sourceRules: path.join(projectRoot, '来源规则', 'sources.json'),
  productWatchlist: path.join(projectRoot, '来源规则', 'high-heat-product-watchlist.json'),
  keywordRules: path.join(projectRoot, '来源规则', 'product-keywords.json'),
  countries: path.join(projectRoot, '国家配置', 'countries.json'),
  db: path.join(projectRoot, '系统数据', '跨境热销商品雷达.db'),
  backupRoot: 'H:\\跨境热销商品',
  artifactRuntime: path.join(projectRoot, '采集程序', 'artifact-runtime'),
  dashboard: path.join(projectRoot, '采集程序', 'dashboard'),
}

export function ensureProjectDirectories(): void {
  for (const directory of [
    paths.reusable,
    paths.nonReusable,
    paths.data,
    paths.keys,
    paths.inbox,
    paths.state,
    paths.history,
    paths.reports,
    paths.logs,
    paths.temp,
  ]) fs.mkdirSync(directory, { recursive: true })
}
