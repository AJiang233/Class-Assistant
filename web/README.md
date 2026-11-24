# Class Assistant · Web 模块

「班级助理」的 Web 门户。**Cloudflare Pages 一体部署**：同一域名下既是静态前端，也是后端 API，数据落 D1。

前端是原生 HTML / CSS / JS，没有构建步骤、没有框架、没有前端依赖；后端零运行时依赖，只用 Web Crypto、D1 绑定与 Service Binding。

---

## 1. 运行形态

| 层 | 实现 | 说明 |
| --- | --- | --- |
| 静态前端 | `web/` 下的 HTML / CSS / JS | Pages 直接托管，不做打包 |
| API | `functions/api/[[path]].js` → `backend/src/index.js` | 只接管 `/api/*`，其余交给静态托管 |
| 数据库 | Cloudflare D1，绑定名 `DB` | 表结构与迁移见第 5 节 |
| 教务 / 学习通 / MOOC | Service Binding `ACADEMIC_API` / `CHAOXING_API` → 私有 Worker | 本仓库只做鉴权与转发 |
| 邮件 / 推送投递 | `backend/src/deliveryWorker.js`（独立 Cron Worker） | 扫发件箱按订阅发信；同一分钟任务也扫待办到点提醒 |

几个结构上的前提：

- **前后端同域**，`API_BASE` 为空串，不涉及 CORS 跨域；`cors.js` 只保留预检处理。
- **应用壳 + iframe**：`index.html` 是唯一有侧栏/底栏的文档，其余页面都跑在同源 iframe 里。子页各自一份 `app.js`、各自一份 `apiRenderers`，所以跨页的数据回填要显式转发（见第 7 节）。
- **Service Worker 在前**：页面壳与静态资源走 `sw.js` 的缓存策略；`/api/*` 刻意不进 SW（数据与登录态必须走网络）。网页版另有一层 JS IndexedDB 缓存，只在断网 / 网络层失败时回放只读 GET（见第 8 节）；App 里由原生层兜底。
- **一份样式表**：所有样式在 `assets/css/style.css`，CSP 不允许内联样式（见第 7 节）。

---

## 2. 目录结构

```
web/
├── index.html                  应用壳：侧栏 + 内容区（iframe 嵌入子页）；小屏改为底部导航
├── affairs/                    班级事务（一份文档、两个视图，靠页内标签切换）
│   ├── index.html              通知 + 活动列表 / 详情（/affairs/，活动视图是 ?tab=activities）
│   └── forms.html              表单填写页（/affairs/forms.html），不在导航中
├── todos/index.html            我的待办（/todos/）
├── academic/index.html         学业：课表 / 学业达成 / 成绩（/academic/）
├── account/
│   ├── index.html              个人中心（/account/）
│   └── admin.html              管理员面板（/account/admin.html）
├── legal/                      隐私政策 / 用户协议 / 免责声明（站内静态页）
├── assets/
│   ├── css/style.css           共享样式（令牌 + 组件 + 响应式 + 降级）
│   ├── js/
│   │   ├── theme.js            主题：首帧前写 data-theme，防浅色闪一下
│   │   ├── app.js              API 客户端 + 会话 + 权限判断 + 工具 + 事件委托 + 原生桥
│   │   └── <页面>.js           各页逻辑：index / notices / activities / todos / academic / forms / account / admin
│   └── icons/                  PWA 图标
├── backend/
│   ├── src/
│   │   ├── index.js            fetch 入口：分发顺序见第 3 节
│   │   ├── deliveryWorker.js   发件箱投递 Worker（Cron 触发）
│   │   ├── routes/             notices / activities / forms / todos / auth / calendar / settings / academic / chaoxing / mooc
│   │   ├── handlers/           业务逻辑：认证 / 通知 / 活动 / 表单 / 待办 / 日历 / 推送 / 同步 / 审计 / 设置
│   │   ├── models/             D1 数据访问，一表一模型
│   │   ├── middleware/         auth（authenticate / withAuth / withPermission）/ cors / logger
│   │   ├── services/           outbox（投递事件展开与占用）、todoReminders（待办到点提醒）
│   │   └── utils/              响应信封 / PBKDF2 / JWT / 权限 / 可见性 / 时间 / ICS / 邮件 / Web Push / 链接白名单
│   └── test/                   用 node:test 直接跑真实 SQL 与前端源码的回归用例
├── functions/api/[[path]].js   Pages Functions 入口（薄壳，复用 backend/src）
├── db/
│   ├── migrations-v2/          迁移账本（0001…0010），wrangler 的 migrations_dir 指向这里
│   ├── migrations/             2026-09 的历史增量，已归档、不再执行
│   └── schema.sql              完整新库快照，与账本顺序执行后的结构逐字一致
├── sw.js                       Service Worker
├── manifest.json               PWA 清单
├── _headers                    全站安全响应头与缓存策略
├── _redirects                  旧地址 → 新地址（分文件夹之前的写法）
├── version.json                各端最新版本号与安装包直链（「关于软件」读取）
├── wrangler.toml               Pages 本地开发绑定（DB + 两条 Service Binding）
├── wrangler.delivery.toml      投递 Worker 的配置与 Cron 触发
└── package.json                脚本与唯一 devDependency（wrangler）
```

---

## 3. 请求链路

```
页面 → app.js 的 api(path) → fetch('/api/…')   （自动带 Bearer token，401 清会话回登录页）
     → functions/api/[[path]].js
     → backend/src/index.js
         ├─ OPTIONS            → 预检
         ├─ GET /api/sync      → syncHandler（安卓增量快照）
         ├─ 依次询问各 routes   → 认领则返回，否则 null
         │    auth → settings → notices → activities → forms → calendar → todos → push
         │    → academic / chaoxing / mooc（转发私有 Worker）
         └─ 无人认领           → 404
```

- **响应信封**：成功 `{ "success": true, "data": … }`；失败 `{ "success": false, "error": "中文文案", "code": "MACHINE_CODE" }`，HTTP 状态码同时给出（400/401/403/404/409/412/429/500/503）。
- **分发约定**：每个 routes 文件是 `(request, env, ctx) => Response | null`，按路径前缀或精确路径认领；`index.js` 只按顺序问一遍。
- **鉴权位置**：代理类路由（`/api/academic/*`、`/api/chaoxing/*`、`/api/mooc/*`）在本仓库完成 JWT 校验与用户载入，再把用户 id / 学号与 `INTERNAL_TOKEN` 通过请求头交给私有 Worker；私有 Worker 没有公网入口。
- **代理路径与信封保持不变**：私有 Worker 监听的正是这三组前缀，错误码（`ACADEMIC_EXPIRED` / `ACADEMIC_UNREACHABLE` / `NOT_BOUND` 等）与本站一致，前端不必区分是哪一侧回的。

---

## 4. 认证与权限

### 凭据

- 密码哈希：PBKDF2-SHA256，10 万次迭代，64 字节派生密钥，16 字节随机盐，存成 `salt:hash`。
- JWT：HS256，密钥来自 `JWT_SECRET`，载荷是最小用户信息 + `iat` / `exp`，有效期由 `JWT_EXPIRES_IN` 决定（默认 7 天）。
- **改密即全局失效**：改密 / 重置会写 `users.password_changed_at`，后续校验要求 token 的 `iat` 不早于它，此前签发的令牌一律作废（含多设备）。
- 前端把 `ca_token` / `ca_user` 放 localStorage；收到 401 时清会话并回登录页。

### 中间件三层

| 名称 | 作用 |
| --- | --- |
| `authenticate` | 解析并验证 JWT，从库里载入最新用户（权限、职位、改密时间都以库里为准，不信 token 里的旧权限） |
| `withAuth(fn)` | 已登录即可访问；把用户对象交给业务处理 |
| `withPermission(point)(fn)` | 在此基础上要求某个权限点 |

### 权限点与职位

| 权限点 | 含义 |
| --- | --- |
| `content:write` | 发布 / 取消 通知与活动、创建表单、管理表单 |
| `user:manage` | 注册账号、管理成员、增删自定义职位、操作日志、功能开关 |
| `class:exclude` | 不计入班级管理：提醒对象为空（默认全班）时不算全班一员，只有被点名才收到 |

- 预设职位映射写在 `utils/permissions.js`：班长 / 团支书 → `content:write` + `user:manage`；学习委员 → `content:write`。
- `users.positions` 支持串或 JSON 数组，**多职位取权限并集**；无职务一律存 `学生`（唯一写法），它不带任何权限，只作兜底文案与分组名。
- 自定义职位存 `roles` 表，只允许上面三个权限点；预置职位（含 `学生`）禁止写进 `roles`，否则等于给全班提权。
- **内容归属**：改 / 删 / 看结果限创建者本人，或持 `user:manage` 的班委；三者同一口径（`utils/audience.js` 的 `canManageItem`）。

### 可见性

- 通知 / 活动 / 表单用 `remind_people` 表达「谁该看到」：`null` / 空串 / `[]` 都表示全班；否则按用户 id 或姓名精确匹配。
- `class:exclude` 的人不会因为「默认全班」而收到，必须被明确写进名单。
- 日历订阅（`.ics`）与网页列表共用同一套判定：key 只证明「你是谁」，不代表能看全班内容，所以仍逐条过滤；key 无效返回 403（鉴权失败而非路由不存在）。

### 防护

- **登录限流**：按学号指数退避（`login_attempts`）叠加按 IP 的失败限流（`login_ip_failures`），超限返回 `429` + `Retry-After`。
- **防账号枚举**：忘记密码对「邮箱不存在 / 未验证」回同一句文案。
- **协议同意**：`user_consents` 记录同意版本与两个可选授权，登录时版本落后返回 `412 CONSENT_REQUIRED` 并要求重新勾选。
- **多因子中间态**：教务代登录的验证码错误累计 5 次即作废本次中间态。
- **第三方会话**：教务 Cookie 与 MFA 中间态由私有 Worker 用 AES-GCM 封存，`COOKIE_SECRET` 不在本仓库。

---

## 5. 数据层

### 表（`db/schema.sql`，28 张）

| 分组 | 表 |
| --- | --- |
| 账号 | `users`、`roles`、`user_consents`、`email_codes`、`email_subscriptions`、`login_attempts`、`login_ip_failures`、`audit_logs` |
| 内容 | `notices`、`activities`、`content_changes`、`architecture_versions` |
| 表单 | `forms`、`form_submissions`、`form_submissions_v2`、`form_notice_links`、`orphan_submission_archive` |
| 待办 | `todos`、`content_todos`、`todo_prefs`、`todo_sync_state`、`todo_reminder_prefs` |
| 投递 | `outbox_events`、`outbox_deliveries`、`todo_reminder_deliveries`、`push_subscriptions` |
| 其他 | `app_settings`（功能开关）、`audience_migration_issues`（受众迁移留痕） |

### 触发器（17 个）

两类，都写在 `schema.sql` 里：

- **内容变更留痕**：通知 / 活动 / 表单 / 提交的增删改写 `content_changes`（含 `seq` 递增与版本号），`/api/sync` 的增量协议靠它取数。
- **级联与清理**：删表单删联动通知、删通知清表单链接、删成员清订阅、删通知 / 活动清待办模板。

### 迁移

- `db/migrations-v2/` 是**唯一表结构来源**，按 `0001`…`0010` 顺序执行；wrangler 的 `migrations_dir` 指向它。
- `db/schema.sql` 是完整新库快照，等价于账本顺序执行后的结构 —— `architecture.test.js` 会逐字核对两者，任何只改一边的改动都会失败。
- `0008` / `0009` 用 `ALTER TABLE` 追加列，因此快照末尾按同样顺序重复这几条语句。`0010` 新建待办提醒偏好与提醒投递两张表；迁移文件与 `schema.sql` 的 DDL 必须逐字一致（含行尾），否则 `architecture.test.js` 的 `sqlite_master` 深比较会失败。
- `db/migrations/` 是 2026-09 的六份历史增量（表单、推送、内容归属、学生职位、删教务表、邮箱），只在旧库演进里用过，现已归档。

---

## 6. 接口一览

`权限` 一列写「登录」表示任意已登录用户，其余为所需权限点。

### 认证与账号 `/api/auth/*`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/login` | 公开 | 学号 + 密码；未同意协议返回 412 |
| POST | `/register` | user:manage | 注册账号 |
| GET | `/me` | 登录 | 当前用户（含 `permissions`） |
| PUT | `/profile` | 登录 | 改联系方式 |
| POST | `/change-password` | 登录 | 改密并作废旧令牌 |
| GET / POST | `/consent` | 登录 | 读 / 写协议同意与两项授权 |
| POST | `/email/send-code` `…/verify` `…/unbind` | 登录 | 邮箱绑定三连（解绑连带清订阅） |
| GET / POST | `/email/subscriptions` | 登录 | 读 / 写邮件订阅开关 |
| POST | `/forgot/send` `/forgot/reset` | 公开 | 找回密码（防枚举） |
| GET | `/users` | user:manage | 成员列表 |
| PUT / DELETE | `/users/:id` | user:manage | 改 / 删成员 |
| GET | `/members-pick` | 登录 | 成员精简列表（提醒对象选择） |
| GET | `/roles` | 登录 | 自定义职位（只读，供管理卡片展示） |
| POST / DELETE | `/roles`、`/roles/:id` | user:manage | 增 / 删自定义职位 |
| GET | `/audit-logs` | user:manage | 操作日志（可按动作 / 操作人 / 日期筛选） |

### 内容

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/notices` | 登录 | 列表：`audience=mine`、`date=`、`scope=`、分页 |
| POST | `/api/notices` | content:write | 发布（可挂表单链接、可附待办模板） |
| GET | `/api/notices/archive` | content:write | 归档（含已过期） |
| GET / PUT / DELETE | `/api/notices/:id` | 登录（改删限归属） | 详情 / 编辑 / 删除 |
| — | `/api/activities`、`/api/activities/:id` | 同上 | 活动与通知同构，多 `location` / `start_time` / `end_time` |
| GET | `/api/calendar/token` | 登录 | 读订阅链接与密钥 |
| POST | `/api/calendar/reset` | 登录 | 重置订阅密钥 |
| GET / HEAD | `/api/calendar.ics` | key（查询串） | iCalendar 订阅源，逐条按可见性过滤；`remind` / `past` / `future` / `notices` / `courses` / `todos` 控制范围，`courses` / `todos` 缺省为开、传 `0` 关闭 |

### 表单

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/forms` | content:write | 创建（可同时下发通知） |
| GET | `/api/forms` | content:write | 管理列表，每行带 `can_manage` |
| GET | `/api/forms/mine` | 登录 | 我的：待填 / 已提交 |
| GET / PUT / DELETE | `/api/forms/:id` | 登录（改删限归属） | 详情 / 编辑 / 删除 |
| POST | `/api/forms/:id/submit` | 登录 | 提交（服务端重校验字段、名单、截止、编辑策略；状态变了返回 409 `FORM_CHANGED`） |
| GET | `/api/forms/:id/submissions` `/progress` `/export` | 登录（限归属） | 明细 / 进度与未交名单 / 导出 |

### 待办

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET / POST | `/api/todos` | 登录 | 列表（`status=open|history`、`tag=`）/ 新建 |
| PUT / DELETE | `/api/todos/:id` | 本人 | 编辑 / 删除（超时件只读） |
| POST | `/api/todos/:id/status` | 本人 | 完成 / 重新打开 |
| POST | `/api/todos/:id/hide` | 本人 | 从历史里隐藏 |
| GET / PUT | `/api/todos/prefs` | 本人 | 红 / 黄提醒阈值 |
| GET / PUT | `/api/todos/reminder-prefs` | 本人 | 网页版待办推送：`enabled`、`lead_minutes`（0–10080，默认关闭 / 60） |
| POST | `/api/todos/delegate` | content:write | 给多个成员代加 |
| POST | `/api/todos/from-source` | 登录 | 从通知 / 活动加入（重复加入返回 `duplicate`） |
| POST | `/api/todos/sync-chaoxing`、`/sync-mooc` | 登录 | 分批同步外部作业与考试（`{cursor,batch}` → `next_cursor/done`） |

### 其它

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/sync` | 登录 | 安卓端固定上界快照 + 增量协议（基于 `content_changes`） |
| GET | `/api/push/config` | 登录 | VAPID 公钥 |
| POST | `/api/push/subscribe` `/unsubscribe` `/test` | 登录 | Web Push 订阅三连 |
| GET / PUT | `/api/admin/settings` | user:manage | 全局功能开关 |
| ALL | `/api/academic/*` | 登录 + 教务授权 | 转发私有 Worker：状态 / 绑定 / 解绑 / 代登录 / 多因子 / 课表 / 学分 / 成绩 |
| ALL | `/api/chaoxing/*` | 登录 + 学习通授权 | 同上：绑定预览 / 绑定 / 待办与作业 / 进度 |
| ALL | `/api/mooc/*` | 登录 + MOOC 授权 | 同上：课程 / 任务点 / 作业 / 考试 |

---

## 7. 前端架构

### 页面与脚本

| 页面 | 地址 | 脚本 |
| --- | --- | --- |
| 应用壳 + 主页 | `/` | `index.js` |
| 班级事务（通知 / 活动） | `/affairs/`（活动视图为 `?tab=activities`） | `notices.js` + `activities.js` |
| 表单填写 | `/affairs/forms.html` | `forms.js` |
| 待办 | `/todos/` | `todos.js` |
| 学业 | `/academic/` | `academic.js` |
| 个人中心 | `/account/` | `account.js` |
| 管理员面板 | `/account/admin.html` | `admin.js` |

每个页面都是独立的 HTML 文档，引入顺序固定为 `theme.js`（head，同步）→ `app.js` → 自己的脚本。

### 壳与导航

- 桌面：固定侧栏 + 内容区；手机（≤768px 或矮视口 + 粗指针）：隐藏侧栏，改底部导航 5 项。
- 视图切换只翻 iframe 的 `hidden`，`FRAME_KEYS`（iframe id）与 `FRAME_URLS`（子页地址）两张表分开管。
- **深链**：`?view=notices&id=3` 这类地址在壳上原样保留，壳负责把子页 `src` 指到带 `id` 的地址，子页自己开详情。
- **视图历史**：每次切视图写一条 `?view=` 记录，安卓返回键据此回上一个视图，栈底停在主页才退出。
- **侧滑切页**：手机端左右滑动按固定顺序切换，落在可横向滚动区域（如课表）时不拦截。
- 子页在 iframe 里各自成一棵树，所以「未登录」与「网络断了」两种壳级状态都得在壳和各子页各显一次。

### 数据层

- `api(path, options)`：自动附 Bearer token、30s 兜底超时、401 清会话回登录页、`options.raw` 直接拿 `Response`（CSV 导出用）。只读 GET 还带一层网页离线缓存：断网先回缓存，在线仅在网络层失败 / 超时时回退；服务端答的 401、5xx、`success:false` 一律原样抛出，不拿旧数据掩盖错误。
- `onApiData(key, render)`：按「请求 URL 一字不差」注册回填函数，供 App 壳的原生离线层在拿到新数据后重绘（网页版注册了也不会被调用）。
- `window.__caApiUpdated`：原生推回数据的入口，先喂本窗口，再转发给同源 iframe；iframe 各自一份注册表，不转就收不到。

### 渲染约定

- 不用框架，列表一律 `innerHTML` 重绘 + 事件委托：`delegate(root, 'click', '[data-act="x"]', fn)`，参数走 `data-arg` / `data-id`。
- 转义：文本用 `esc()`，插进属性值用 `escAttr()`（`esc` 不转义引号）。
- 显隐统一 `hidden` 属性（样式表里有 `[hidden]{display:none!important}`），不用行内样式。
- 空态 / 错误态 / 加载态复用 `stateHTML(text, isError, icon)` 与 `skeletonHTML(rows)`，图标取自 `DETAIL_ICONS`。

### 主题

`data-theme="light|dark"` 挂在 `<html>` 上；`theme.js` 在首帧前按 `localStorage('theme')` 或系统偏好写入，避免浅色闪一下。手动切换时同步改 `meta[name=theme-color]`，应用壳与 iframe 子页通过 `storage` 事件保持一致。

### 样式体系

只有一个 `assets/css/style.css`，按层组织：

| 层 | 内容 |
| --- | --- |
| 令牌 | 颜色 / 背景层级 / 文字层级 / 描边 / 强调与语义色 / 圆角 / 间距 / 材质 / 阴影 / 字体 / 动效 / 安全区 / 命中区，深浅两套 |
| 基元 | 按钮、图标按钮、列表与列表行、徽章、分段控件、表单、弹窗、骨架屏、空态 |
| 结构 | 应用壳、侧栏、底栏、页头、区块、首页分栏与日历、个人中心、管理员面板、教务课表 |
| 响应式 | `900`（窄桌面单列）→ `768` 或「矮视口 + 粗指针」（手机：底栏、密度、命中区）→ `400`（小屏）→ 横屏矮视口 |
| 降级 | `prefers-reduced-motion` / `prefers-reduced-transparency` / `prefers-contrast` |

材质规则：`backdrop-filter` 只出现在导航与浮层（侧栏、底栏、弹窗）这一层，内容层用不模糊的标准材质，玻璃不叠玻璃；正文滚动区不加模糊层。

### CSP 约束

`_headers` 对全站下发，`script-src` 与 `style-src` 都只放行 `'self'`，因此：

- 页面里不能有内联 `<script>`、内联 `onclick`、内联 `style="…"`，也不能有 `<style>` 块 —— 写了会被浏览器整条丢掉，表现是「按钮点了没反应 / 样式莫名消失」，只有控制台有提示。
- 页面逻辑全部外置到 `assets/js/`；动态生成的 DOM 走事件委托。
- JS 里用 CSSOM 写的值（`el.style.width`、`setProperty`）不受限制，滑块定位、进度条宽度这类动态值仍留在 JS。
- `img-src` 额外放行 `data:`（下拉箭头内嵌 SVG）与 `https://weavatar.com`（QQ 邮箱头像）；`connect-src` / `script-src` 对 Cloudflare Web Analytics 的 beacon 有精确主机放行。

---

## 8. 离线与 PWA

### Service Worker

- **预热**：安装时抓一份应用壳清单 —— 8 个页面（文件夹首页用目录地址，如 `/todos/`）、`style.css`、全部页面脚本、`manifest.json`、法务三页。单条失败不影响整体。
- **缓存优先 + 后台回源**：命中缓存先出首帧，同时用 `cache: 'no-cache'` 回源（绕开 CDN 那份 4 小时的 HTTP 缓存）；回源发现页面文档真的变了，就整份重取并通知页面刷新。
- **规范地址**：写入与查找都走 `canonical()` —— 文件夹首页归一成目录形式（`/todos/index.html` → `/todos/`），分文件夹之前的旧地址查别名表（`/notices.html` → `/affairs/`），保证旧书签、旧推送在离线时也能命中。
- **去跳转标记**：跟过 308 的响应带 `redirected`，规范禁止用它应答导航请求，所以落缓存前复制一份干净的。
- **边界**：只接管导航与静态资源，`/api/*` 一律走网络；非导航请求缺缓存时如实失败，不用主页壳顶替（拿 HTML 顶替 JS 只会更难排查）。接口数据的离线段在页面 JS 里，见下一节。
- **刷新与跳转**：`ca-shell-updated` 触发重载（页面里有未提交输入则跳过），`ca-shell-navigate` 给不支持 `client.navigate` 的旧内核做兜底。

### 网页版离线 API 缓存

浏览器（含 iOS 主屏 PWA）里没有安卓的原生拦截层，所以 `app.js` 在 `api()` 里补了一份 IndexedDB 缓存，语义与安卓 `OfflineApi` 对齐：

- **只接管只读 GET**：路径白名单为通知、活动、教务 status / timetable / credits / grades、表单 `mine` 与表单详情、待办、`auth/me`；写请求与 `options.raw`（导出二进制）完全不走这一层。
- **详情不单独落盘**：`/api/notices/:id`、`/api/activities/:id` 离线时从列表缓存里按 id 拼回 `{success:true,data:item}`，避免缓存条数随“点开过多少条”增长。
- **键与账号隔离**：键是规范化后的「路径 + 查询串」，`refresh=1` 从键里去掉；每条记录带当前用户 id，换账号不命中，登录成功清掉其它账号、退出登录清空全部。
- **上限与持久化**：单条响应 ≤512KB，最多 60 条，按 `savedAt` 淘汰最旧；启动时申请 `navigator.storage.persist()`，降低被系统清掉的概率。
- **预热**：顶层窗口在首屏空闲后串行请求与安卓同口径的固定键（通知 / 活动列表、当天列表、教务四项、表单、`me`、待办）——用户没打开过的页面，断网也能直接看到上次数据。
- **提示文案**：断网提示条在确认有缓存时显示「当前无网络，显示的是上次缓存的数据」，没有缓存仍显示「部分内容可能无法加载」，不把“没缓存”说成“有缓存”。

### App 壳内的离线

安卓端在 `shouldInterceptRequest` 里接管 `/api/` 的只读请求：在线时自己取一份存本地，断网时把上次响应原样回给页面；页面侧只需用 `onApiData` 注册「拿到数据 → 渲染」的函数，就能在原生推回新数据时重绘。写操作（POST / PUT / DELETE）一律不接管。网页版的等价能力见上一节，两层不会同时生效（`inNativeShell()` 时网页层不预热）。

### iOS PWA 与提醒

- **安装**：iOS 只能通过 Safari「分享 → 添加到主屏幕」安装，网页无法用代码弹安装提示；个人中心只给出口头引导。
- **推送**：iOS 16.4+ 且必须已添加到主屏，权限申请必须在用户点击手势内；Safari 不允许静默推送，`sw.js` 收到 `push` 必定 `showNotification`，否则系统会撤销订阅。iOS 不会派发 `pushsubscriptionchange`，所以每次打开个人中心都会重新上报订阅。
- **本地定时不可用**：iOS PWA 关闭后没有 Background Sync / 本地闹钟，课程与待办的“到点提醒”不能在本机排期。待办走服务端 Cron + Web Push（需在个人中心显式开启）；课程走系统日历订阅。
- **日历订阅**：个人中心的订阅源已包含活动、通知（可选）、课程与待办；iOS / macOS 用 `webcal:` 直接打开「日历」App，其它平台保留 https 下载 `.ics`。每个事件带稳定 `UID`，`VALARM` 同时带 `UID` / `X-WR-ALARMUID`，尽量满足 iOS 对订阅日历闹钟的字段要求；但系统日历的刷新频率由 iOS 决定（可能一天一次），不能当作实时提醒。
- **限制说明卡**：iOS 主屏 PWA 的个人中心会显示一张说明卡，明确“关闭后不会本机提醒、请用推送或日历、通知权限在系统设置里改”，避免用户把网页通知开关当成系统闹钟。

### 上线前置

1. `cd web && npm test` 全量通过；
2. 远端库执行 `npx wrangler d1 migrations apply class-assistant-db --remote`（`0010` 建待办提醒两张表）；
3. 部署 Pages（静态前端 + Functions）；
4. 给独立的 Delivery Worker 配好 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` 并部署 —— Pages 的环境变量不会继承给这个 Worker。待办提醒默认关闭，用户不开启就不会产生任何推送。

---

## 9. 原生桥 `CAHost`

App 壳通过注入的 `CAHost` 提供网页拿不到的能力；网页侧全部做特性探测，桥不存在就隐藏对应入口（纯网页版照常可用）。

| 类别 | 方法 |
| --- | --- |
| 身份与环境 | `platform`、`appVersion`、`appStatus`、`setTheme` |
| 通知 | `testNotification`、`backgroundStatus`、`setBackgroundAlwaysOn` |
| 提醒 | `courseReminderSettings` / `saveCourseReminderSettings`、`todoReminderSettings` / `saveTodoReminderSettings`、`todoChanged` |
| 系统设置跳转 | `openAutoStartSettings`、`openBatterySettings`、`requestIgnoreBatteryOptimizations` |
| 绑定 | `startAcademicLogin` / `startAcademicLoginFor`、`startChaoxingLogin`、`startMoocLogin` |

绑定类桥的特点是「原生打开真实登录页 → 用户自己完成人机验证 → 原生把 Cookie 经 `window.__ca*Cookies(...)` 交回网页 → 网页调 `POST /api/*/bind` 落库」，原生不代填、不代登录、不做上报；取消走 `window.__ca*Cancel()`。MOOC 只有这一条与「网页版粘贴 Cookie」共存的路径 —— 账号密码代登录要过设备指纹 + 滑块验证码 + IP 信誉三道门，Worker 出口是数据中心 IP，必然更容易被要求验证码，所以没做（详见 `android/README.md` 的「中国大学MOOC 绑定」）。

---

## 10. 安全设计要点

- 凭据：PBKDF2 加盐哈希，不存明文；JWT 密钥与前缀配置只在环境变量 / Secrets 里，不进仓库。
- 会话：改密即作废全部旧令牌；401 统一清会话。
- 越权：内容归属逐条判定（创建者或 `user:manage`），提醒对象可见性在服务端过滤而不是前端隐藏。
- 表单：提交时重新校验字段定义、提交名单、关闭状态与截止时间，期间状态变化返回 409 让前端刷新后重提。
- 第三方：教务 / 学习通 / MOOC 的实际访问（含 CAS 代登录、字段归一化、缓存）都在私有 Worker，本仓库不含这部分实现；调用走 Service Binding，另带 `INTERNAL_TOKEN` 双保险。
- 邮件与推送：发信走 Resend（`EMAIL_API_KEY`），Web Push 走 VAPID；两者缺配置时相关能力降级而不是把主流程拖垮。
- 响应头：`_headers` 下发 CSP、`X-Content-Type-Options`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy`、HSTS；页面与资源均为 no-cache / must-revalidate，避免「新页面结构配旧样式」。
