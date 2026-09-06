# 跨境雷达本机协调器

`cross-border-coordinator.mjs` 默认运行影子模式。它每次只读取公开国家/来源配置及数据库文件元数据，写入被 Git 忽略的 `运行日志/automation/` 状态和历史；不会打开数据库、发起采集、导入订单/成本/广告资料，也不会改写数据库。

## 已验证行为

- 独占锁：已有 `collector.lock` 时跳过；不会自动删除过期或畸形锁，避免并发时误启动第二个进程；
- 锁冲突只记录最小诊断信息（可解析性、年龄、启动时间、PID、模式），不回显锁文件任意内容；
- 本机 `run-history.ndjson` 原子保留最近 336 条（约 7 天、每 30 分钟一次），避免长期运行无限增长；
- 关键预检：11 国范围、启用来源数、250 请求预算和数据库文件存在性；
- 不再调用会打开/写入数据库的旧 `doctor` 或 `health` 命令；
- 不发起网络请求；
- 成功检查后写入 `nextEligibleAt`；30 分钟窗口内再次触发会记录 `skipped_not_due`，不重复读取配置或数据库元数据；
- `active` 模式在创建运行目录、写日志、读取状态、尝试加锁或执行预检前即显式阻止并返回非零退出码，不会误触发真实采集。

## 手动影子运行

```text
npm run automation:shadow
```

## 公开自动采集（不含私密数据）

```text
npm run automation:public
```

该模式只执行 12 个已配置、HTTPS、白名单和请求预算受控的公开来源；写入现有本机公开研究库。单轮最多 13 分钟，低频商品页、Common Crawl 和 Safety Gate 成功后至少间隔 24 小时。它不读取 `系统数据/private/`、订单、成本、客户、Meta/Shopify 账户、Cookie 或 Token。私密 `active` 模式目前仍被显式阻止，须另行实施聚合数据合同、人工批准与本机路径/权限/Git 排除/MCP 隔离验收；单机私密存储不以 BitLocker 为前置条件。

## 48 小时影子观察

```text
npm run automation:shadow-status
```

该命令只读取本机状态与历史，输出影子观察时长、合格运行次数、异常状态数和当前安全标志。通过 48 小时及 96 次合格运行不等于可以启用主动模式；隐私验证、回归测试、恢复点和单独审批仍缺一不可。

## 私密聚合阶段合同（未启用）

`templates/private-aggregate-contract.md` 定义后续仅本机、去标识化聚合输入的最小字段和禁止字段。`npm run automation:validate-private-aggregate` 默认失败关闭，不读取任何文件；它不是导入器，也不能绕过隐私闸门。

## 本机私密聚合与利润账本（需逐次明确批准）

私密数据流程不会自动启动、不调用真实 Meta/Shopify 账户，也不会创建广告、预算、目录或账户变更。

- `npm run automation:validate-private-aggregate <CSV>`：默认拒绝读取；当前进程显式设置 `RADAR_PRIVATE_IMPORT_APPROVED=1` 后，只验证 `系统数据/private/` 内的聚合 CSV，不导入；
- `npm run automation:generate-private-ledger <聚合CSV> <单位经济CSV>`：默认拒绝执行；当前进程显式设置 `RADAR_PRIVATE_LEDGER_APPROVED=1` 后，先运行 `E:/fb+bm` 的 `privacy:check`，再生成本机私密利润账本；
- 输入合同与空表头模板见 `templates/private-aggregate-contract.md`。模板和账本均在 Git 忽略的私密目录；
- 账本结果只输出 `REJECT`、`EVIDENCE_REQUIRED`、`TEST_READY`、`STOP` 或 `SCALE_CANDIDATE`。`SCALE_CANDIDATE` 仅表示满足最小聚合样本和正贡献利润条件，绝不自动扩量。

## 任务计划脚本

`install-shadow-tasks.ps1` 创建当前 Windows 用户的交互式 30 分钟影子健康检查任务；`-Remove` 删除任务。它不提升权限，也不创建真实采集任务。

当前自动注册曾被系统以 `Access is denied` 拒绝，因此必须由拥有任务计划权限的本机用户在 PowerShell 中执行。不要为了安装该任务扩大目录权限或以 SYSTEM 身份运行。

## 启用私密聚合阶段前的硬条件

1. `E:/fb+bm` 的 `npm run privacy:check` 通过本机路径、私密目录重定向、NTFS 权限、Git 排除和模型/MCP 隔离检查；
2. 私密经营数据只位于本机私密目录，输入符合去标识化聚合合同；
3. 完成至少 48 小时影子观察；
4. 增加真实采集的回归测试、恢复点和单独审批。

`npm run privacy:verify-admin` 仅保留为 BitLocker 状态的可选只读诊断，不是单机私密存储的前置条件。
