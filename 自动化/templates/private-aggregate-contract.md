# 本机私密聚合导入合同（未启用）

本文件是结构合同，不是数据模板；不得把真实成本、订单、客户或广告数据提交到 Git。实际 CSV 必须仅保存在 `系统数据/private/`，并且在 `E:/fb+bm` 的隐私闸门通过、单独批准后才可验证。

## 允许字段

```text
date,product_key,country,currency,orders_count,net_revenue,refunds_count,refund_amount,chargebacks_count,chargeback_amount,ad_spend,attributed_purchases
```

- `product_key`：稳定匿名商品键，不可使用商品明文、SKU、订单号或客户标识；
- `country`：仅 `GB, US, AU, CA, NZ, CH, IE, NO, SE, DK, FI`；
- 货币金额和计数必须为非负数；`date` 为 ISO `YYYY-MM-DD`；
- 禁止姓名、邮箱、电话、地址、IP、Cookie、Token、订单 ID、Checkout、支付或卡信息字段。

## 当前安全状态

`validate-private-aggregate.mjs` 默认不读取任何文件。只有显式设置 `RADAR_PRIVATE_IMPORT_APPROVED=1` 后，才会读取位于 `系统数据/private/` 下的 CSV；它仅校验，绝不导入数据库、绝不上传、绝不执行广告或账户操作。

在私密阶段启用前还必须完成：管理员隐私验证、48 小时影子验收、恢复点演练、导入回归测试和单独人工审批。
