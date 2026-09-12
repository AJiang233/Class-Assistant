# forms Implementation Plan

> Status: APPROVED
> Source: user request（2026-09-12 讨论，6 项决策已确认）
> Mode: --deliberate（触发高风险信号：鉴权 / 数据迁移 / PII 导出）
> Iterations: 2 / 3
> Author: AJiang233
> Last updated: 2026-09-12

## Requirements summary

班委（`content:write`）可下发自定义表单，同学填写。表单发布时可选择同时下发一条通知，通知里提供「去填写」跳转。导出的表格自带学号、姓名，同学无需重复填写。表单可配置是否允许修改、是否匿名，并提供「已交 / 未交名单」用于催交。入口只在首页待办露出，不占底部导航。

### 已确认决策（本次讨论结论）

| 议题 | 结论 |
|---|---|
| 表面入口 | 只在首页待办露出；`forms.html` 作为承载页，无导航项 |
| 通知联动 | `notices` 加 `link` 字段，列表与详情出「去填写」按钮 |
| 匿名 | 支持开关，语义取**弱匿名**：存 `user_id`，班委能看到「谁交了」，看不到「谁答了什么」 |
| 催交 | 做，含未交名单 + 一键复制 |
| 班委管理面板 | 创建 / 结果 / 导出 / 未交名单全部放 `admin.html` 卡片区 |

## Acceptance criteria

- AC-1 未登录调 `GET /api/forms/:id` 返回 401；已登录但无 `content:write` 调 `POST /api/forms` 返回 403。
- AC-2 提交请求体中伪造 `student_id` / `name` 不生效：落库值与 JWT 对应用户一致（本地起两条不同用户验证）。
- AC-3 `edit_policy='none'` 时重复提交返回 409；`before_deadline` 且未过期时允许覆盖，覆盖后 `created_at` 不变、`updated_at` 变化。
- AC-4 导出 CSV 前 3 字节为 UTF-8 BOM（`EF BB BF`）；列顺序为 `学号,姓名,提交时间,<字段…>`。
- AC-5 匿名表单的 `GET /api/forms/:id/submissions` 与导出**不含** `student_id` / `name`；但 `GET /api/forms/:id/progress` 仍返回未交名单。
- AC-6 建表单时勾选下发通知 → `notices` 新增一条记录且 `link='/forms.html?id=<id>'`；`link` 为 `//evil.com`、`http://...` 或 `javascript:` 时创建被拒（400）。
- AC-7 未交名单 = 应交集合（`remind_people`，空视为全班）− 已提交集合；输出 `张三、李四` 形式文本，可一键复制。
- AC-8 首页待办对同一用户同时渲染「待填」与「已填可修改」两类条目。
- AC-9 字段值以 `=` `+` `-` `@` 开头时，导出 CSV 仍为纯文本（不被 Excel 当公式执行）。
- AC-10 表单一旦存在提交，修改字段定义的请求返回 409；改标题 / 描述 / 截止时间不受影响。

## RALPLAN-DR

### Principles

1. 跟随 baseline「最小代码」：不做未被请求的可配置项（如多次提交、文件上传）。
2. 跟随既有架构：`routes → handlers → models → D1` 四层，权限复用 `content:write`，不新增权限点。
3. 与现有通知/活动的界面口径保持一致：卡片样式、`stateHTML`/`skeletonHTML`、`remindMe()` 语义都复用。
4. 学号姓名的注入点只有一个：服务端。前端传什么一律忽略。
5. 外科手术式：`notices` 只加一列 `link`，不改其既有查询语义。

### Decision drivers

1. **不污染核心模块** —— `notices` 是全班在用、刚改过的路径，改坏代价高。
2. **PII 安全** —— 导出的是全班学号姓名，越权与注入风险必须前置处理。
3. **用户路径最短** —— 同学只感知「首页待办」和「通知里的按钮」，不感知模块边界。

### Viable options

**Option A：独立表单模块（chosen）**
- 实现思路：新增 `forms` + `form_submissions` 两张表，新增独立 route/handler/model 三层；`notices` 仅加一列 `link` 做单向跳转；前端新增 `forms.html` 承载填写，首页待办加第三块列表，班委管理进 `admin.html`。
- 改动文件：`web/schema.sql`、`web/migrations/2026-09-12-forms.sql`、`web/backend/src/models/formModel.js`、`web/backend/src/handlers/formHandler.js`、`web/backend/src/routes/forms.js`、`web/backend/src/index.js`、`web/backend/src/models/noticeModel.js`、`web/backend/src/handlers/noticeHandler.js`、`web/forms.html`、`web/index.html`、`web/notices.html`、`web/admin.html`、`web/backend/test/forms.test.js`
- Pros：语义清晰，表单特有的状态（已交/未交、匿名、字段锁）不会挤进通知；不动通知的写路径；后续要加字段类型或统计都有地方放。
- Cons：多一套 CRUD 与页面；首页待办的提醒口径要再实现一遍（用共用函数缓解）。

**Option B：把表单做成通知的一种形态（rejected）**
- 实现思路：`notices` 加 `kind`/`fields`/`edit_policy`/`deadline`/`anonymous` 等列，表单即 `kind='form'` 的通知，复用列表 / 详情 / 提醒 / 日历 / 归档；提交另建一张表。
- Pros：UI 与提醒逻辑零新增；同学在通知流里直接看到表单。
- Cons：`notices` 现有 9 列会膨胀到 15+，一半列对普通通知恒为 NULL；`list()` 必须加 `kind` 过滤否则表单混进通知列表，而"待填表单"需要的是「已交/未交 + 截止」这套与通知生效窗口不同的逻辑；最重要的是**要改通知的核心写路径**，回归面覆盖全班。
- Rejected rationale：省下的代码量集中在 UI 层，而代价是核心表语义混杂 + 改高风险路径，不划算。

**Option C：不改代码，用第三方问卷外链（rejected）**
- 实现思路：通知里贴腾讯问卷/金数据链接。
- Rejected rationale：第三方不认识本站用户，**拿不到学号姓名**，直接违背「导出自带学号」与「未交名单」两个核心需求。列此仅作基线对照。

### Synthesis path（由 Architect 提出，已采纳进 Option A）

独立建表，但**前端不重复实现提醒逻辑**：首页待办复用现有 `remindMe(raw)`（`web/index.html:562`）的"空=全班"口径与卡片样式，`notices.link` 只做单向跳转。这样既避免 `notices` 膨胀，也不重写已跑通的过滤与渲染。

## Implementation steps

### 阶段 1 — 表单本体（可单独上线）

1. **建表** — `web/schema.sql` 末尾追加 `forms`、`form_submissions` 两张表；同步新建 `web/migrations/2026-09-12-forms.sql`（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE notices ADD COLUMN link TEXT`），写法对齐 `web/migrations/2026-09-12-mfa-attempts.sql`。
2. **package.json** — `web/package.json` 的 scripts 块新增 `db:migrate:forms`，命名对齐现有 `db:migrate:mfa`。
3. **模型** — 新建 `web/backend/src/models/formModel.js`：`create` / `findById` / `list` / `listMine` / `update` / `remove` / `submit`(upsert) / `findMySubmission` / `listSubmissions` / `countByForm`，SQL 写法对齐 `web/backend/src/models/noticeModel.js:13-98`。
4. **字段校验** — `web/backend/src/handlers/formHandler.js` 内实现 `validateFields(schema)` 与 `validateAnswers(fields, answers)`：类型白名单 `text|textarea|radio|checkbox|number|date`；必填；`radio/checkbox` 的取值必须落在 `options` 内；单字段长度上限 2000 字符；字段数上限 50。**校验只在服务端生效**。
5. **handler** — 同文件实现 `handleCreateForm` / `handleListForms` / `handleGetForm` / `handleUpdateForm` / `handleDeleteForm` / `handleSubmitForm` / `handleListSubmissions` / `handleFormProgress` / `handleExportForm` / `handleListMyForms`。响应统一走 `web/backend/src/utils/response.js` 的 `success/error/jsonResponse`。
6. **学号注入** — `handleSubmitForm` 中 `student_id` / `name` 取自 `user`（由 `withAuth` 注入），**不读请求体**。
7. **字段锁** — `handleUpdateForm`：若该表单已有提交且请求要改 `fields`，返回 409 `FORM_FIELDS_LOCKED`（满足 AC-10）。
8. **导出** — `handleExportForm`：CSV + UTF-8 BOM；每格做 CSV 转义（含 `"`→`""`、含分隔符加引号），并对以 `=` `+` `-` `@` 开头的值前置 `'`（满足 AC-9）；`Content-Type: text/csv; charset=utf-8`，`Content-Disposition: attachment`。
9. **未交名单** — `handleFormProgress`：应交集合来自 `forms.remind_people`（空=全部用户），减去 `form_submissions` 的 `user_id` 集合，返回 `{total, submitted, pending:[{name,student_id}]}`。
10. **路由** — 新建 `web/backend/src/routes/forms.js`，写法对齐 `web/backend/src/routes/notices.js:20-57`；在 `web/backend/src/index.js:41-43` 之后插入 `formRoutes` 分发。
11. **路由权限** — `GET /api/forms`、`GET /api/forms/:id`、`POST /api/forms/:id/submit`、`GET /api/forms/mine` 用 `withAuth`；`POST/PUT/DELETE /api/forms/:id`、`submissions`、`export`、`progress` 用 `withPermission('content:write')`，并在 handler 内二次校验调用者是 `creator_id`。
12. **填写页** — 新建 `web/forms.html`：从 `?id=` 读表单，渲染字段、提交、显示「我的提交」；复用 `web/assets/js/app.js` 的 `api()` / `esc()` / `stateHTML()` / `skeletonHTML()` / `requireAuth()`。**顶层变量禁止用 `status` / `name` / `top` / `length` 等 window 属性同名**（课表页刚因此出过故障）。
13. **班委面板** — `web/admin.html` 新增「表单管理」卡片（列表 + 新建 modal + 结果 / 导出 / 未交名单入口），渲染写法对齐 `web/admin.html:381-403`。

### 阶段 2 — 通知联动

14. **通知模型** — `web/backend/src/models/noticeModel.js`：`create`(:13-20)、两处 `SELECT` 列清单、`findById`(:59-65)、`update`(:70-88) 共 5 处加 `link`。
15. **通知 handler** — `web/backend/src/handlers/noticeHandler.js`：`handleCreateNotice`(:9-34) 与 `handleUpdateNotice` 接收 `link`；新增 `isSafeLink()`：必须匹配 `^\/[A-Za-z0-9._\-\/?=&%#]*$`（站内相对路径），显式拒绝 `//`、`http(s):`、`javascript:`、`data:`（满足 AC-6）。
16. **建表单时下发通知** — `handleCreateForm` 若 `notice=true`：先建表单，再调 `NoticeModel.create` 写入 `link='/forms.html?id=<formId>'`，成功后回写 `forms.notice_id`；任一步失败则删除刚建的表单做补偿（D1 无事务）。
17. **通知渲染** — `web/notices.html:151-160`（列表卡片）与 `:246-266`（详情）在有 `link` 时渲染「去填写」按钮；`web/index.html:580-607`（首页通知列表）同样处理。
18. **明确不动** — ICS 日历订阅（`web/backend/src/utils/ics.js`、`web/backend/src/handlers/calendarHandler.js:37`）本次不带 `link`。

### 阶段 3 — 首页待办

19. **接口** — `handleListMyForms` 对应 `GET /api/forms/mine`：返回该用户「待填」（未提交且 `status='open'`）与「已填可修改」（已提交且 `edit_policy != 'none'` 且未过截止）两组。
20. **首页渲染** — `web/index.html:132` 的 `#activityList` 之后加 `#formList`；脚本区新增 `loadForms()`，过滤口径复用 `remindMe(raw)`(:562)，卡片样式沿用通知条目。

### 阶段 4 — 测试

21. **单测** — 新建 `web/backend/test/forms.test.js`，风格对齐 `web/backend/test/security.test.js`（`node --test`）：字段校验、CSV 转义与 BOM、匿名脱敏、`isSafeLink` 白/黑名单。`web/package.json` 的 `test` 脚本已是 `node --test backend/test/*.test.js`，无需改。

## Workspace setup

- 实施前运行 `git status --short` 与 `git branch --show-current`（当前：`main`，干净）。
- 本 plan 会新增表、改后端与多张页面，**且当前分支是 `main`（推送即自动部署生产）**，默认建议先建 worktree：
  `git worktree add -b codex/forms ../Class-Assistant-forms`
- 迁移必须在推送前先在生产 D1 执行（`npm run db:migrate:forms`），否则新代码引用 `link` 列会 500 —— 与 `attempts` 列同类的坑。
- 若工作区已 dirty，先隔离现有改动再开始。

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| 迁移未先执行 → 生产 500 | 部署前强制跑 `db:migrate:forms`；`link` 的读取路径在缺失列时报错，需在验证清单里逐项确认 |
| 导出接口越权（IDOR）拿到全班学号 | 路由用 `withPermission('content:write')`，handler 内二次校验 `creator_id === user.id`；不做公开链接 |
| CSV 注入（Excel 执行公式） | 以 `=` `+` `-` `@` 开头的值前置 `'`；AC-9 覆盖 |
| 匿名表单实际不匿名 | 匿名时 `submissions` 与导出不输出 `student_id`/`name`；AC-5 覆盖；并在文档与界面文案写明"仍会记录谁已提交" |
| 班委改字段导致旧答案悬空 | 有提交后锁 `fields`（AC-10），只允许改标题/描述/截止时间 |
| 重复提交 / 并发覆盖 | `UNIQUE(form_id, user_id)` + upsert；`edit_policy='none'` 时先查后拒（409） |
| 截止时间时区错位 | 沿用 `web/backend/src/utils/datetime.js` 的 `toLocalDateTime` / `parseLocalDateTime` 本地时间口径 |
| 答案长度撑爆 D1 | 单字段 2000 字符、字段数 50 上限（步骤 4） |
| 顶层变量撞 window 属性再次致故障 | 步骤 12 显式约定禁用名单 |
| 一次提交过大的请求体 | handler 内限制请求体解析后的总体积上限 |

## Verification steps

- **AC-1**：本地 `npx wrangler pages dev . --port 8788`，用无 token / 普通学生 token 分别调 `GET /api/forms/1` 与 `POST /api/forms`，断言 401 / 403。
- **AC-2**：用两个本地种子用户登录，提交时请求体带伪造的 `student_id`；查 D1（`wrangler d1 execute --local --command "select student_id,name from form_submissions"`）断言与 JWT 用户一致。
- **AC-3**：同一用户对 `edit_policy` 三种取值各提交两次，断言状态码与 `created_at`/`updated_at` 变化。
- **AC-4 / AC-9**：`curl -s .../export | xxd | head -1` 断言首字节 `efbbbf`；构造 `=1+1` 开头的字段值，断言导出为 `'=1+1`。
- **AC-5**：建匿名表单、两人提交，断言 `submissions` 与导出响应体不含学号姓名，`progress` 仍返回未交名单。
- **AC-6**：建表单时带 `link` 为 `/forms.html?id=1`（成功）与 `//evil.com`、`javascript:alert(1)`（400）。
- **AC-7**：`progress` 输出与手工计算的未交集合一致；前端一键复制写入剪贴板。
- **AC-8**：同一用户首页待办同时出现「待填」「已填可修改」两类条目。
- **AC-10**：有提交后 `PUT /api/forms/:id` 改 `fields` 返回 409，改 `title` 返回 200。
- **回归**：`cd web && npm test`（现有 12 项 + 新增用例）全绿；通知列表/详情/首页提醒在未加 `link` 的记录上行为不变。
- **部署顺序**：跑迁移 → 推送 → 轮询线上 `forms.html` 出现 → 用真实账号跑一遍建表单 + 填写 + 导出。

## Pre-mortem (deliberate)

1. **Scenario**：匿名表单实际可关联到人，班委在群里被质疑。
   **Trigger**：匿名判断写在 handler 的某个分支里，导出与 `submissions` 两条路径漏改其中一条。
   **Mitigation**：脱敏逻辑收敛到 model 层单一出口（`listSubmissions` 内部按 `anonymous` 决定是否 `SELECT student_id,name`），而非在两个 handler 里各写一遍；AC-5 同时覆盖两条路径。

2. **Scenario**：部署后所有表单接口 500，全班用不了。
   **Trigger**：表或 `link` 列未迁移，而代码已上线。
   **Mitigation**：推送前先跑 `db:migrate:forms`；验证清单第一步就是线上探接口；`link` 的读取集中在 `noticeModel` 的列清单，回滚只需还原一处。

3. **Scenario**：全班学号姓名被非班委拿到。
   **Trigger**：导出或 `submissions` 只校验了登录、漏了 `content:write` / `creator_id`。
   **Mitigation**：路由层 `withPermission` + handler 层 `creator_id` 双校验；AC-1 之外补一条"他人创建的 content:write 用户读取被拒"的用例；不提供公开分享链接。

## Expanded test plan (deliberate)

- **Unit**（`web/backend/test/forms.test.js`）：`validateFields` 类型/必填/选项合法性；`validateAnswers` 越界与超长；CSV 转义与 BOM；CSV 注入前缀；`isSafeLink` 白名单与 `//`、`javascript:`、`data:` 黑名单；匿名脱敏的字段集合。
- **Integration**（本地 `wrangler pages dev` + 本地 D1）：建表单 → 提交 → 覆盖提交 → 导出 → progress 全链路；通知联动写入 `link` 且回写 `notice_id`；有提交后字段锁 409；他人表单读写被拒 403。
- **E2E**（jsdom 复现环境，已在课表页故障中使用过）：加载 `forms.html?id=N`，注入真实 token，断言字段渲染、提交成功提示、错误分支（截止已过 / 不允许修改）都在页面上可见而非静默；首页 `#formList` 同时出现两类条目。
- **Observability**：handler 内沿用现有 `console.error` 前缀风格；导出与 progress 调用记录 `form_id` + `user.id` 到日志（不记录答案内容）；迁移后手动确认线上 `/api/forms` 返回 200 而非 500。

## ADR

- **Decision**：表单做独立模块（`forms` + `form_submissions` 两张表 + 独立 route/handler/model），`notices` 只增加一列 `link` 做单向跳转；同学侧入口仅首页待办，班委侧管理面板进 `admin.html`。
- **Drivers**：不污染核心模块（notices 刚改过、全班在用）> PII 安全 > 用户路径最短。
- **Alternatives considered**：
  - Option A 独立模块 —— **chosen**
  - Option B 表单即通知的一种形态 —— rejected：省下的代码集中在 UI 层，代价是 `notices` 膨胀且要改核心写路径，回归面覆盖全班
  - Option C 第三方问卷外链 —— rejected：拿不到学号姓名，违背两个核心需求
- **Why chosen**：表单特有的状态（已交/未交、匿名、字段锁、截止）与通知的生效窗口语义不同，混在一张表里两边都别扭；而"复用"能拿到的收益（提醒口径、卡片样式）通过前端共用函数即可获得，不必用核心表的语义来换。
- **Consequences**：多一套 CRUD 与一个页面，维护面积增加；首页待办需要新增第三个加载函数；`notices` 多一列 `link`，其读写路径有 5 处需要同步（已列在步骤 14）。正面影响是表单后续演进（字段类型、统计、模板）不必再动通知模块。
- **Follow-ups**（本次明确不做）：
  - 文件/图片上传（需引入 R2，超出 D1 能力）
  - 选择题自动统计与图表
  - 表单模板与"复制上次表单"
  - 提交历史审计（`form_submission_revisions`）
  - Android 端本地提醒表单截止（需扩展 `SyncWorker` / `AlarmReceiver`）
  - ICS 日历订阅是否带上表单截止与链接

## Review trail

- **Planner draft v1**：Option A，4 阶段 21 步；AC 8 条；表结构含 `allow_multiple` 列。
- **Architect challenge v1**：对 Option A 提出最强反驳 —— "入口既然只在待办和通知跳转，用户根本感知不到模块边界，那为什么不直接给 notices 加 `kind`/`fields`，把列表/提醒/日历/归档全部免费复用？" 真 tension：**复用现成逻辑（少写代码、用户路径最短）vs 表语义清晰与可演进性**。若反驳成立则应改走 Option B。
- **Planner 决议**：不采纳 Option B。理由：Option B 省下的是 UI 代码，代价是改 `notices` 核心写路径（全班回归面）+ `list()` 被迫加 `kind` 过滤 + 一半列对普通通知恒为 NULL；而 Option A 的"重复实现"部分（提醒过滤）通过复用 `remindMe()` 与统一卡片样式即可消除。据此产出 **Synthesis path** 并入 Option A。
- **Critic verdict v1**：REVISE。待改项 6 条：① 缺"有提交后锁字段"的策略（旧答案会悬空）；② `allow_multiple` 是未被请求的灵活性，违反 baseline「最小代码」，应删；③ 导出缺 CSV 注入防护（Excel 会执行 `=` 开头内容），对 PII 导出是真实风险；④ `/api/forms/mine` 只出现在前端步骤，未定义在后端接口与步骤里；⑤ 未交名单的"全班"口径没写明取自 `users` 全表；⑥ 匿名表单的 `progress` 必然暴露"谁交了"，属固有代价，需在 plan 里显式声明而非默认带过。
- **Planner draft v2**：逐条修复 ①→AC-10 + 步骤 7；②→删除 `allow_multiple`；③→步骤 8 + AC-9；④→步骤 19；⑤→步骤 9 写明口径；⑥→Risks 表与 Follow-ups 显式声明。
- **Architect challenge v2**：无新增阻塞项。确认 Synthesis path 未引入新的耦合（`remindMe()` 是纯函数式过滤，不反向依赖表单模块）。
- **Critic verdict v2**：APPROVED（3 条改进已合入：AC-9/AC-10 补入验收清单、脱敏逻辑收敛到 model 单出口、迁移前置写进 Verification steps），保留 2 条 reservation 见下。
- **Final iterations**：2 / 3

### Critic reservations（APPROVED 前提下仍保留）

1. **弱匿名的固有信息泄露无法技术消除**：只要提供未交名单，`progress` 接口就必然暴露"谁交了"（未交名单的补集）。Plan 只能在文案上提示班委"匿名表不代表看不到谁没交"，无法从技术上同时满足"催交"与"完全匿名"。若后续收到此类质疑，应回到需求层重新取舍，而不是在代码里打补丁。
2. **"有提交即锁字段"的出口偏窄**：若班委确实需要给已有人提交的表单加一个字段，当前唯一出路是复制成新表单，Plan 未提供字段级迁移或版本化。这在真实使用中大概率会被触发；建议先按此上线，并把"表单版本化"列入 Follow-ups 观察。

---

## 实施记录（2026-09-12 落地，分支 main `e77b155`）

### 交付

新增 7 个文件：`web/backend/src/models/formModel.js`、`web/backend/src/handlers/formHandler.js`、`web/backend/src/routes/forms.js`、`web/backend/src/utils/link.js`、`web/backend/test/forms.test.js`、`web/forms.html`、`web/migrations/2026-09-12-forms.sql`。
改动 9 个文件：`schema.sql`、`package.json`、`index.js`、`noticeModel.js`（5 处加 `link`）、`noticeHandler.js`、`index.html`、`notices.html`、`admin.html`、`style.css`。

### 与方案的偏离（3 处，均为实施时的必要调整）

1. **通知列表行里没有放「去填写」按钮**。AC-6 原写"列表与详情都出按钮"，但列表行本身是 `<button onclick=showDetail>`，内部再嵌 `<a>` 属于嵌套可交互元素。改为：列表行加绿色「表单」badge 标记，真正的按钮放在详情弹窗；首页待办那一列是 `<a>`，可直接点。
2. **为可测试性导出 5 个纯函数**（`normalizeFields` / `validateAnswers` / `csvCell` / `buildCsv` / `parseFields`）。方案要求实现在 handler 内、第 21 步又要求单测，导出是同时满足两者的最小改法。
3. **单选字段用原生 `<select>`**（复用课表页已有的 `.form-input`），多选用 chip；为此新增两条 CSS：`.badge-form`、`a.list-row`。

### 实施中发现并修掉的真 bug（方案未预见）

`listMine()` 的 SELECT 未取 `f.status`，而当时的 `isOverdue()` 依赖 `form.status` —— `undefined !== 'open'` 恒真，导致**已提交的表单永远进不了「已提交可修改」、直接从待办消失**（AC-8 会残废）。已按语义拆为 `isPastDeadline()`（只看 deadline）供列表判断，status 判断留在 `submitGate`。同时修掉"已过截止的表单显示成『待填写』"，现在直接从待办排除。

### 验证证据

| 层 | 项数 | 结果 |
|---|---|---|
| `npm test` 单测（含原有 12 项） | 36 | 全过 |
| 后端接口（wrangler pages dev + 本地 D1） | 31 | 全过 |
| `forms.html` 端到端（jsdom） | 14 | 全过 |
| 首页待办 + admin 面板（jsdom） | 17 | 全过 |
| 生产环境（线上接口 + 远程 D1 内省） | 12 | 全过 |

### 部署踩坑（值得记一笔）

迁移脚本整段粘贴进 D1 Console 时**只执行了最后一条 `ALTER`**，两张 `CREATE TABLE` 未生效，代码已上线导致 `/api/forms` 500。处置：确认波及面仅限表单接口（通知/活动/成员/教务全部 200），未回滚；补跑 3 条 CREATE 后恢复。教训：手工迁移必须逐条执行并逐条确认，不要整段粘贴。

