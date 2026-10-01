# 架构修复上下文与验收契约

研究时间：2026-09-30；验收更新：2026-10-01 17:39 +08:00。用户已授权修复并提交，交付追加至 PR #98。

## 研究与复用

编码前分析了以下既有实现：

- `web/backend/src/models/noticeModel.js` 与 `handlers/noticeHandler.js`：准备语句、时间校验、受众与通知创建。保留 handler 编排、model 执行 SQL 的分层。
- `web/backend/src/models/activityModel.js` 与 `handlers/activityHandler.js`：按日期窗口及受众查询。个人列表将过滤推进 SQL，在 LIMIT 之前执行。
- `web/backend/src/models/formModel.js` 与 `handlers/formHandler.js`：条件提交、修改闸门和联动通知。复用条件写入与 D1 batch，替换失败后逐条补偿删除。
- `web/backend/src/utils/audience.js`、`email.js`、`webpush.js`：复用角色规则、邮件模板及发送器；删除旧广播编排，不复制邮件或 Web Push 协议实现。
- `android/app/src/main/java/com/classassistant/app/sync/SyncRunner.kt` 与 `data/Store.kt`：复用同步入口、提醒排程和 SharedPreferences；完整分页后一次持久提交。
- `web/backend/test/dataConsistency.test.js` 与 Android 既有 JUnit 测试：沿用 node:test、真实 SQLite 和 JUnit，新增事务、恢复及协议行为断言。

命名沿用 camelCase、模型类及 ES 模块；JavaScript 两空格、单引号、分号，Kotlin 沿用四空格；文档与新注释用简体中文。现有模型、utils 和同步入口中没有可靠发件箱或单调变更日志，新增模块仅负责这两项职责。

## 依赖与接口

创建 handler → 模型 → D1 业务表 → 同事务变更日志/发件箱 → 独立 Cron Worker → 既有邮件/Web Push。

变更日志 → 登录后的 `/api/sync` → Android 收齐固定上界 → 原子保存快照、游标、待提醒项及活动投影 → 提醒/小组件。

网页个人列表使用 `audience=mine` 和 `nextOffset`，管理台账沿用现有入口。`remind_people` 只写用户 ID，旧姓名仅在迁移时转换，歧义保留待处理记录。数据库由官方迁移账本管理；正式接口、配置和回滚契约以 `web/docs/数据一致性与部署.md` 为唯一来源。

## 已完成验收

- [x] 统一新库初始化与历史库迁移；新旧库结构一致、迁移可重复；孤儿提交归档，联动任一步失败全批回滚。
- [x] 用户 ID 受众、歧义迁移记录、个人列表先筛选后分页；超过一页的其他人内容不会挤掉自己的内容。
- [x] 事务发件箱、定时消费者、渠道/收件人状态、租约、重试及幂等；断网与进程中断可恢复，永久错误收敛。
- [x] 单调序号同步、固定上界、删除标记与规则版本；Android 完整分页后原子持久化，首次基线不补推旧通知。
- [x] 真实 SQLite、状态序列及四项关键 SQL 变异验证；网页 DOM 交互、Android 本地单测及调试构建。
- [x] 更新部署、迁移、回滚说明与评分报告；具备提交到既有 PR 的本地验收证据。

上下文充分性检查：相似实现、接口契约、可复用模块、风格、测试方法、无重复实现及集成点均有上述证据。最终测试结果和验证范围见 `verification-report.md`，发布状态以 PR #98 为准。

## 工具、来源与边界

sequential-thinking、shrimp-task-manager、desktop-commander、context7 与 github.search_code 未提供，采用显式分析/本计划、PowerShell/rg、gh API 与官方文档替代；不虚构工具调用。所有验收在本地完成。

- D1 batch 事务：https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
- 官方迁移账本：https://developers.cloudflare.com/d1/reference/migrations/
- 请求 waitUntil 时限：https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil
- 触发器返回时恢复 last_insert_rowid：https://www.sqlite.org/c3ref/last_insert_rowid.html
- SQLite UPSERT 的 SELECT 语法约束：https://www.sqlite.org/lang_upsert.html
- Node 标准库 SQLite：https://nodejs.org/api/sqlite.html

历史姓名歧义不能猜测；投递为至少一次，不能保证端到端恰好一次。初始化只下载各条目最后版本，但服务端日志仍累积，需观察 D1 容量与读取行数。Android SDK 已在项目本地补齐，中文路径通过临时盘符映射解决，61 项 JVM 测试及调试构建通过。生产邮件/推送和真机闹钟未在本次执行；全仓 TypeScript/checkJs 迁移不在交付范围内。
