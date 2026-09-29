# 操作记录

## 2026-09-29：研究与计划

- 用户要求：审查并修改 GitHub 仓库。克隆到当前工作区 `Class-Assistant/`，基线 `1baac85`；工作分支 `codex/review-data-consistency`。
- 工具链替代：先分析范围、输入输出和验收，再建立上下文与任务清单，最后执行。指定工具未在当前工具清单中提供；使用本地 PowerShell、rg、Git、gh 及 Node/Go。GitHub 代码搜索已成功，官方资料改为直读。工具缺失不阻断已有能力可完成的工作。
- 基线：Web 251 项测试全部通过；Go 四个内部包测试通过，调度入口没有测试文件。
- 观察：当前测试多用 D1 替身；没有覆盖真实 SQL 的提交竞争、筛选前截断以及 Worker UTC 与北京时间的差异。

## 编码前检查

- [x] 已分析并生成 `.Codex/context-summary-仓库审查.md`。
- [x] 复用 `datetime`、`submitGate`、D1 模型、受众判断及统一响应；不重复建立数据访问或时间系统。
- [x] 遵循现有 ES 模块、两空格、单引号、分号、中文说明规范。
- [x] 新回归用例接入已有 `node --test`，采用 Node 自带 SQLite 执行真实表结构；不新增第三方测试框架。
- [x] 已按用户授权自行确认实施计划与可重复验收条件。

## 复现与实施

- 首批 18 项真实 SQL / 时间回归用例：基线 17 失败、1 通过，明确复现功能缺陷，原始输出保留在 `regression-before.log`。这是先写回归用例的预期失败，确认原因后进入修复。
- 复用日期模块：统一 UTC+8 解析和格式化；通知、活动及表单联动通知复用 `normalizeTimeRange`；表单日期字段用同一个解析器验证实际日期。
- 复用 `listByAudience`：偏移按过滤后的记录计数。日历模型先限定日期窗口，再由同一函数处理受众分页；排序带 `id` 保证同时间记录的稳定次序。
- 复用 D1 条件更新模式：表单提交在一条 INSERT SELECT / UPSERT 中检查当前字段、名单、关闭/截止状态及编辑策略，以 `meta.changes` 返回写入结果。保留已有答案的首次提交时间。
- 官方资料已直读：Cloudflare D1 prepared-statements、SQLite UPSERT、Node sqlite；GitHub CLI 搜索了 Cloudflare workers-sdk 的 D1 查询示例。使用现有数据库能力和标准库，没有增加运行时依赖。
- 模块检查：命名、导入、缩进沿现有实现；纯时间/输入规范化仍在 utils，SQL 仍在 model，HTTP 编排仍在 handler；没有创建另一套应用框架或数据层。

## 2026-09-29 23:16 +08:00：验证与复盘

- 完整 Web：272/272 通过（原有 251 + 新增 21）。
- UTC、Asia/Shanghai、America/New_York 三个时区：各 21/21 通过，覆盖夏令时、跨年及北京时间零点。
- Go：四个内部包测试通过；`go vet ./...` 通过。
- 61 个 JavaScript 文件 `node --check` 通过；`git diff --check` 通过。
- Android 第一次被中文路径检查阻断；第二次未加引号的 PowerShell `-P` 参数未正确生效；第三次以带引号参数排除该检查后，确定阻断原因是缺少 Android SDK。按连续失败规则停止重试并复盘：这不是当前 Web 修改引入的失败，Android 没有任何源码改动；完整 Android 验证需在补齐 SDK 后运行，不声称已通过。
- 补偿计划：本次 Web 改动以真实 SQLite 回归、原有测试、跨时区检查验证；Android 需在下一次 Android 修改或发布前配置 SDK 34，并运行项目原有单测，具体命令见验证报告。

## 编码后声明

1. 复用了 `datetime.js`、`submitGate`、`canView`、`listByAudience`、`FormModel` 和统一响应工具；新测试直接执行 `schema.sql`，不复制表结构。
2. 相似实现对照：通知和活动保留同构 handler 流程；表单沿用条件写入的 `meta.changes` 判据；日历模型使用既有 `prepare/bind/all`，只增加日期窗口查询。
3. 遵循 ES 模块、两空格、单引号、分号、中文说明；任务文件仅在项目 `.Codex/`，正式回归用例在现有测试目录。
4. 未引入第三方运行时或测试框架。Node 自带 SQLite 用于弥补原有 D1 替身不执行 SQL 的盲点；测试环境要求已写入 Web README。
5. 工作保留为本地分支上的可审阅改动；未执行远程 CI、部署或数据库迁移。评分与范围结论见 `verification-report.md`。

## 提交 PR

- 用户明确要求修复完成后提交 PR。
- 重新获取上游 `main`，仍为 `1baac85`，与已验证基线一致。
- 上游权限为只读，使用现有且已核实归属的 `TsoiTZF/Class-Assistant` fork 推送 `codex/review-data-consistency`，向 `AJiang233/Class-Assistant:main` 发起 PR。
- 提交包含源码、21 项回归用例、开发说明及三份审查文档；本机测试原始日志不进入仓库。
- 提交前由本地子代理只读复核条件 SQL、UTC+8 转换及日历分页，未发现阻断项；暂存区检查发现并修正了报告中的 Markdown 行尾空格，随后检查通过。
