# 仓库审查与修复报告

审查时间：2026-10-01 17:39 +08:00。

仓库：`AJiang233/Class-Assistant`；基线：`1baac85d17c6fd88cc913c0d94d921c81760ecf8`；分支：`codex/review-data-consistency`；交付：[PR #98](https://github.com/AJiang233/Class-Assistant/pull/98)。

## 结论与范围

**建议通过，提交代码审阅。** 本轮完成数据生命周期、稳定受众、可靠投递及 Android 增量同步改造，并保留第一轮班务时间、提交竞争和日历分页修复。Web 283 项、Android 61 项本地测试通过，调试 APK、Pages 和投递 Worker 构建通过，真实本地 D1 迁移与事务冒烟通过。

目标是消除已定位的部分写入、名单漂移、列表漏项和后台执行中断丢失，交付源码、行为回归、升级说明与审查证据。结论覆盖下列改动，不代表线上投递、真实手机行为或全仓所有功能已验收；未部署、未操作生产数据库、未发送真实邮件或推送。

## 修复与交付映射

| 问题及触发方式 | 最终行为 | 主要代码与测试 |
| --- | --- | --- |
| 表单联动通知中途失败；删除产生孤儿提交或订阅 | D1 batch 同批提交；外键/触发器统一删除关系，历史孤儿答案先归档 | `models/formModel.js`、`models/userModel.js`、`migrations-v2/`、`architecture.test.js` |
| 姓名重复或改名导致名单漂移；其他人的记录占满前页 | 名单写入稳定 ID；旧歧义留待修订；个人查询在 LIMIT 前筛选，网页消费后续页 | `utils/recipients.js`、三类 model/handler、`assets/js/`、受众与分页回归 |
| 请求结束或进程退出丢失广播，重试覆盖其他消费者结果 | 业务与发件箱同事务；逐目标状态、原子租约、退避、失败上限及带租约确认 | `services/outbox.js`、`deliveryWorker.js`、投递恢复与改绑回归 |
| 发布时间游标漏同秒写入、修改、删除；端侧只保存游标造成漏提醒 | 单调序号、固定上界、最后版本快照、删除标记和规则重建；Android 完整分页后原子保存 | `handlers/syncHandler.js`、`SyncSnapshot.kt`、`SyncRunner.kt`、`Store.kt` 及 JVM 协议测试 |
| UTC Worker 错解班务时间；同时首次提交覆盖答案；日历先截断导致漏项 | 固定 UTC+8；条件 SQL 检查提交策略/字段/状态；日历先限定日期再分页 | 第一轮 `datetime.js`、表单提交、日历模型与 `dataConsistency.test.js` 回归继续覆盖 |

Web 后端路径相对 `web/backend/src/`，测试在 `web/backend/test/`。正式迁移、接口、配置和回滚说明见 `web/docs/数据一致性与部署.md`；Web/Android README 已同步。过程记录和上下文摘要在本目录。

## 本地验证结果

| 验证 | 结果与证据 |
| --- | --- |
| `npm --prefix web test` | **283/283 通过**，无跳过；`web-final.log` |
| Android `testDebugUnitTest assembleDebug` | **61 项 JVM 测试通过**、调试 APK 构建成功；`android-final.log` 及 JUnit XML |
| SQL 变异验证 | 受众等号、租约 token 条件、同步序号边界、级联删除四项变异均被行为断言捕获 |
| 状态序列模型 | 固定种子 233，160 步创建/编辑/删除/受众变化/分页，与独立 Map 模型收敛一致 |
| 官方本地 D1 迁移 | 两份迁移成功；再次执行无待迁移项；`d1-migrations.log`、`d1-repeat.log` |
| 本地 workerd D1 冒烟 | 联动创建、批次失败回滚、级联删除、快照同步通过；`d1-smoke.log` |
| Pages Functions 编译 | 成功；`pages-build.log` |
| 投递 Worker dry-run | 编译成功，未部署；`worker-build.log` |
| JavaScript 语法 | 67 个文件 `node --check` 通过 |
| Go 测试/静态检查 | `go test ./...`、`go vet ./...` 通过 |
| 网页 DOM 验收 | 同名成员精确选择、创建/编辑名单、普通成员完整个人列表均通过；1280/390 宽度无横向溢出、无控制台错误 |
| 差异格式检查 | `git diff --check` 通过 |

SQLite 测试直接执行真实 schema、约束、触发器和 SQL，D1 适配层只转换调用接口；真实 workerd 冒烟另行验证 batch 与 last_insert_rowid。故障注入覆盖多个事务写入点、过期租约接管、退订/设备改绑、网络恢复和永久失败。原有 Web Push 订阅、加密与发送测试保留；删除旧广播编排后，其替身测试由持久投递行为测试替代，测试总数不宜解释为简单的新增数量。

浏览器仅使用本地虚拟数据及 DOM 交互，无真实用户数据。第一轮三时区回归结果留在操作日志；本轮未把旧结果冒充新执行。SDK 缺失已补足，替代了旧报告中的 Android 未验证状态。

### 可重复验证

从仓库根目录执行（Node 22.13+，本次 Node 24；JDK 17、Android SDK 34）：

```powershell
npm --prefix web ci
npm --prefix web test
go test ./...
go vet ./...
git diff --check
Push-Location web
try {
  npx wrangler d1 migrations apply class-assistant-db --local --persist-to ../.Codex/d1-review
  npx wrangler pages functions build functions --outdir ../.Codex/pages-build
  npx wrangler deploy --dry-run --config wrangler.delivery.toml --outdir ../.Codex/worker-build
} finally { Pop-Location }
node .Codex/d1-smoke.mjs
```

Android 使用项目原有 Gradle 入口：配置 `JAVA_HOME` 与 `ANDROID_HOME` 后执行 `android/gradlew.bat -p android testDebugUnitTest assembleDebug '-Pandroid.overridePathCheck=true' --console=plain`。本机中文路径会影响 Java 工作进程解码，已用临时 `subst R:` 映射验证；具体命令见部署说明。SDK、构建产物和原始日志均只保留本地。

## 依赖、部署与限制

- 不新增 Web 运行时依赖，锁定既有 Wrangler 开发依赖；Android 仅增加 JVM 测试用真实 `org.json`，没有新运行时依赖。协议有 JSDoc 和运行时断言，未执行全仓 TypeScript/checkJs 迁移。
- 上线顺序为数据库迁移 → Pages/新版客户端 → 独立 Cron Worker。受众从姓名改成 ID 是破坏性接口变更；更早于文档基线的库先补旧 ALTER；歧义名单需管理员重新选择。回滚须停写并恢复升级前数据库备份及对应代码，不能只回退 Pages。
- Cron 每分钟执行，默认批量要求 Workers 付费套餐的 1000 子请求额度。Pages 的 Secrets 不自动继承到独立 Worker。缺配置暂存待投递，永久错误或八次失败进入待处理状态。
- 投递是至少一次。邮件幂等受供应商保留窗口约束；Web Push tag/Android 稳定通知 ID 不能消除所有确认前中断导致的重复。没有声称端到端恰好一次。
- 变更日志当前不自动清理；初始化只返回条目最后版本，日志容量与提交投影写入量仍需观察。个人列表有每页 100、偏移 10000 上限；日历保留既有每类 200 上限。
- 本地 SQLite/workerd 不替代生产配额及网络环境。供应商真实投递、真机通知权限/闹钟/厂商后台策略未执行，不作为已通过的证据；上线前按部署说明在目标环境做配置验收。

## 审查评分

缺失 sequential-thinking 工具，以需求、数据写入、接口、恢复、测试和发布影响逐项结构化审查替代。评分是本次改动的审查判断，不是整个产品的质量测量。

| 维度 | 评分 / 100 | 依据 |
| --- | --- | --- |
| 技术：代码质量 | 92 | 事务集中处理关系，复用现有模型和发送器；SQL 触发器需随迁移维护 |
| 技术：测试覆盖 | 94 | 真实 SQLite、workerd、失败注入、状态模型、SQL 变异及 Android 协议回归 |
| 技术：规范遵循 | 93 | 中文说明、项目既有构建与测试、上下文及工具替代留痕 |
| 战略：需求匹配 | 94 | 审查意见落为源码与可复验交付，沿用已授权 PR |
| 战略：架构一致 | 92 | 保持 Pages/D1 与既有端侧同步入口，投递职责单独部署 |
| 战略：风险评估 | 90 | 明确迁移门槛、部署顺序、配额、至少一次和真机验证边界 |

**综合评分：92/100；建议：通过，提交审阅。**

检查清单：目标、范围、交付物与审查要点完整；已覆盖约定的修复意图；代码/测试/文档映射明确；依赖与风险已评估；结论与时间戳已留痕。
