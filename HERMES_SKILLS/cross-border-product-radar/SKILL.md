---
name: cross-border-product-radar
description: 管理 E:\跨境热销商品 的免费公开来源采集、加密 GitHub 同步、严格可复用分库、完整商品档案、Excel 和 H 盘备份。
version: 1.0.0
author: local-user
platforms: [windows]
metadata:
  hermes:
    tags: [Cross-border, Product-Research, GitHub-Actions, RSS, Safety, Shopify]
    related_skills: [public-knowledge-cloud-sync, github-repo-management, github-auth, grounded-citations, blogwatcher, xlsx]
---

# 跨境热销商品雷达

固定项目根目录为 `E:\跨境热销商品`，备份根目录为 `H:\跨境热销商品`。不要把本任务写入 `E:\fb+bm` 或其他项目的数据库。

## 强制规则

1. 默认商品先进入 `NON_REUSABLE`。只有身份、供应、物流、责任主体、风险、完整度、可信度和商业素材授权全部通过后，才能转为 `REUSABLE`。
2. 不可复用商品只有当前或历史峰值热度达到 60 分才进入长期研究库。普通热度不可复用商品不生成档案、不进入 Excel，30 天后删除详情并只留匿名墓碑。
3. 正式两库只收录可上架的实体商品。人物、赛事、票务、应用、订阅和纯服务即使热度超过 60，也只能在待复核区短期核实，不能进入商品报表。
4. 热度、广告、浏览、新闻、搜索、评价都是信号，不得写成销量或利润证明；无证据字段必须写“未知”。
5. 未知权利素材只留公开链接和元数据。禁止下载、去水印、破解 DRM、搬运平台视频或把 Common Crawl 内容当商业授权。
6. 不访问登录后私有数据、验证码、付费墙、泄露数据；不规避 robots、访问频率或平台限制。TikTok、Amazon、Temu、AliExpress、Etsy、WIPO 只做人工官方复核。
7. Pipiads、付费 API 和付费代理保持关闭。

## 每 30 分钟任务

运行 `E:\Hermes\Agent\scripts\cross_border_radar_sync.py`。没有新 GitHub 加密包时保持安静；有新包时，必须按顺序完成下载、清单签名验证、SHA-256 校验、解密、事件格式与数量校验、去重、分库、Excel 更新和 H 盘备份。任一步失败就停止本轮，不移动水位点，不覆盖上一版合格结果。

## 用户口令

- “更新跨境商品雷达” → 运行 `②立即采集并更新报表.cmd`，报告来源成功/失败、证据数、正式两库数量、待复核数量和备份结果。
- “同步 GitHub 商品结果” → 运行 `⑦同步GitHub并更新全部结果.cmd`。
- “查看商品雷达” → 运行 `③打开只读看板.cmd`。
- “检查商品雷达” → 运行 `⑤系统体检.cmd`，优先解释 FAIL，再解释 WARN。
- “为什么没有商品” → 读取数据库看板、来源健康和门槛，不得为了凑数降低标准。

## 报告边界

只报告真实执行结果。每次说明：采集时间、成功/失败来源、请求量、插入证据量、可复用数、高热不可复用数、待复核数、清理数、数据库完整性和 H 盘备份。不得在聊天中显示私钥、HMAC、完整加密身份或 GitHub Secret。
