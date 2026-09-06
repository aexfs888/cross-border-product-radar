# 本机私密聚合输入合同（已提供模板，未启用自动导入）

本文件是数据合同，不是将真实经营资料提交到 Git 或聊天的模板。实际 CSV 只能位于 `系统数据/private/`；该目录已被 Git 忽略。当前工具**仅验证，不导入数据库、不上传、不执行广告或账户操作**。

## 允许的订单/广告聚合字段

```text
date,product_key,country,currency,orders_count,revenue_before_refunds_chargebacks,refunds_count,refund_amount,chargebacks_count,chargeback_amount,ad_spend,attributed_purchases
```

- `product_key` 是稳定匿名键；不能使用商品明文、SKU、订单号或客户标识；
- `revenue_before_refunds_chargebacks`：本期已确认、已扣折扣的商品销售收入，**尚未扣除**退款金额和拒付金额；不得包含代收代缴税费、不可留存的运费或任何无法作为商家收入的金额。利润账本会分别扣减 `refund_amount` 与 `chargeback_amount`，因此不得使用已经扣除两者后的“净收入”；
- `country` 只能为 `GB, US, AU, CA, NZ, CH, IE, NO, SE, DK, FI`；
- 金额与计数均须为零或正数；日期为 `YYYY-MM-DD`；
- 数据必须是按日期 × 匿名商品键 × 国家 × 币种聚合后的结果。

空表头模板位于（仅本机、被 Git 忽略）：

```text
系统数据/private/templates/private-aggregate-template.csv
```

## 允许的单位经济字段

```text
product_key,country,currency,effective_from,listed_price,landed_product_cost,packaging_cost,warehouse_cost,outbound_shipping_cost,duties_tax_cost,payment_fee_rate,refund_rate,chargeback_rate,refund_loss_per_order,support_cost,other_variable_cost,inventory_units,replenishment_days,rights_status,responsible_party_status,fulfillment_status
```

费率为 `0` 到 `1` 的小数（例如 3.5% 写为 `0.035`）；三个状态字段只能为 `VERIFIED`、`PENDING` 或 `BLOCKED`。空表头模板：

```text
系统数据/private/templates/unit-economics-template.csv
```

## 永久禁止字段

禁止姓名、邮箱、电话、地址、IP、Cookie、Token、订单 ID、Checkout、支付或卡信息，以及任何可识别客户、员工或供应商个人的信息。

## 验证命令

默认不读取任何私密文件：

```text
npm run automation:validate-private-aggregate <系统数据/private 下的 CSV>
```

只有在当前 PowerShell/命令提示符中显式设置 `RADAR_PRIVATE_IMPORT_APPROVED=1` 后才会读取指定 CSV。使用 `--unit-economics` 验证单位经济文件。验证输出只返回状态、类型、是否读取、可接受行数和最多 20 个错误码；不会回显行内容或金额。

## 后续启用条件

自动导入、利润账本或任何广告动作均未启用。它们需要独立的代码、回归测试、恢复点和逐次人工批准；广告、预算、目录和账户写入继续属于单独审批动作。
