# 仓库审查上下文

生成时间：2026-09-29（北京时间）

## 目标与范围

审查公开仓库 `AJiang233/Class-Assistant`，基线 `1baac85`。修复可在本地复现的功能与数据一致性缺陷；交付源码、回归测试、操作记录与验证报告。重点是 Web 后端的时间、分页、日历和表单提交；Android、Go 做结构审阅和可用的本地验证。私有教务服务不在此仓库内。

## 相似实现与复用

1. `web/backend/src/handlers/noticeHandler.js`：请求校验 → 模型写入 → 异步推送；响应复用 `success/error/jsonResponse`，时间复用 `toLocalDateTime`。
2. `web/backend/src/handlers/activityHandler.js`：与通知同构，列表经 `listByAudience`，更新只拣出允许修改的字段。
3. `web/backend/src/handlers/formHandler.js` 和 `formValidation.js`：纯校验与 I/O 分离，`submitGate` 统一关闭、截止和编辑策略，错误返回 400/409。
4. `web/backend/src/models/formModel.js`：D1 参数绑定、`meta.changes` 判断条件更新是否成功；`updateIfUnsubmitted` 是原子写入的现有范例。
5. `web/backend/test/forms.test.js`、`audience.test.js`、`security.test.js`：Node 原生测试、严格断言、D1 替身；现有替身不执行真实 SQL，无法发现数据库约束与竞争窗口。

## 项目约定

ES 模块、两空格缩进、单引号、分号；类用 PascalCase、函数用 camelCase。中文说明和测试名称。保持现有 handler / model / utils 分层。运行时无外部依赖，不引入框架或新构建工具。

## 依赖与集成

```text
Web / Android 调用方 → Pages Functions → 路由 / handler
                                    → 纯校验及受众工具
                                    → D1 模型 → SQLite 表
日历订阅客户端 → calendarHandler → 模型 + 受众判定 → ICS
表单详情 / 我的表单 / 提交 → submitGate → datetime
```

- 班务日期在库内为北京时间字符串；SQL 已用 `datetime('now', '+8 hours')`，JS 解析却依赖宿主时区，是明确的不一致。
- `schema.sql` 是新库结构；测试须直接使用此文件，不能再维护一份测试表结构。
- `forms.edit_policy` 支持 `none`、`before_deadline`、`always`。修改字段已有条件更新，提交仍为无条件 UPSERT，需要验证并发次序。
- Node v24.16.0 自带 `node:sqlite`，可以在原有 `node --test` 中执行真实模型 SQL；不增加依赖。采用 Node 22.13+ 的测试环境并记录要求。

## 计划与验收

- [x] 完成仓库、规范与至少三种实现的检索。
- [x] 执行现有 Web、Go 基线测试。
- [x] 用回归测试复现时区、分页、日历漏项、表单并发和日期输入问题。
- [x] 沿既有层次修复；保持客户端请求协议和数据库结构可用。
- [x] 本地运行定向及完整测试、跨时区测试、差异检查。
- [x] 记录评分、复现步骤、验证范围及剩余限制，见 `verification-report.md`。

验收：截止时间在 UTC / 上海 / 夏令时时区一致；分页不重复且不漏项；订阅按请求窗口取数据，不被窗口外记录挤掉；不可修改的表单不能被并发覆盖，字段变化时不写入旧答案；非法日期不写入或静默清空原值；原有测试全部通过。

## 检索工具与资料

指定的 sequential-thinking、shrimp-task-manager、desktop-commander、context7、github.search_code 未提供。依次用显式需求分析、本文任务清单、本地 PowerShell / rg / GitHub CLI 替代。没有使用远程流水线或外包验证。

- GitHub CLI 代码搜索：`gh search code 'INSERT SELECT ON CONFLICT repo:cloudflare/workers-sdk'`，用于查找官方 SQLite/D1 范例。
- Cloudflare D1 官方文档：https://developers.cloudflare.com/d1/worker-api/prepared-statements/ ，核对参数绑定及执行结果。
- SQLite 官方文档：https://www.sqlite.org/lang_upsert.html ，核对 INSERT SELECT 的 WHERE 与 UPSERT 条件。
- Node 官方文档：https://nodejs.org/api/sqlite.html ，核对内存数据库测试接口。

## 风险和边界

分页过滤需要从首行计数，深分页增加查询次数；沿用现有受众语义。日历输出仍保持现有浮动时间 ICS 契约。表单提交采用单条条件 SQL，避免引入应用锁；用顺序可控的交错请求模拟并发。Android SDK 在默认位置不存在，需要检查可用构建环境；不把未运行的测试描述为通过。保持本次修复聚焦，不改认证体系或生产配置。
