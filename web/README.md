# Class Assistant · Web 模块

「班级助理」项目的 Web 门户：**Cloudflare Pages 一体部署**（静态前端 + Functions 后端 + D1），纯 HTML/CSS/JS，登录后按职位提供不同权限。

- 前端：`web/` 根目录静态文件 — 原生 HTML/CSS/JS，应用壳布局（左侧固定栏 + 右侧内容区 iframe 嵌入）
- 后端：`backend/src/` — 经 `functions/api/[[path]].js` 接入 Pages Functions，JWT + PBKDF2 认证，通知/活动 CRUD、按职位鉴权，运行时零依赖
- 数据库：Cloudflare D1（SQLite）

---

## 目录结构

```
web/                            # Cloudflare Pages 项目根目录（直接部署本层）
├── functions/
│   └── api/
│       └── [[path]].js         # Pages Functions 入口：仅接管 /api/*，复用 backend/src 的 fetch handler
├── index.html                  # 应用壳：侧边栏 + 内容区（iframe 嵌入子页）；小屏改为底部导航
├── notices.html                # 通知列表/详情（iframe 内容页）—— 发布/编辑/删除/过期归档/提醒对象
├── activities.html             # 活动列表/详情（iframe 内容页）—— 发布/编辑/删除/提醒对象
├── academic.html               # 课表与学业（iframe 内容页）—— 教务课表 / 未排课程 / 学分达成
├── account.html                # 个人中心 —— 资料（联系方式自助修改）/ 个性化（主题）/ 日历订阅 / 修改密码 / 强制刷新 / 退出登录
├── admin.html                  # 管理员面板 —— 左栏 添加通知·添加活动，右栏 添加成员·管理成员（折叠区块，按权限显示）
├── assets/
│   ├── css/style.css           # 共享样式（液态玻璃主题变量 + 组件 + 响应式）
│   └── js/app.js               # API 封装 + 会话管理 + 权限判断 + 工具
├── backend/
│   └── src/                    # 后端源码（被 functions 引入，同域运行）
│       ├── index.js            # fetch 入口（CORS 预检 + 路由分发 + 404）
│       ├── routes/             # 路由分发：auth / notices / activities / calendar / academic
│       ├── handlers/           # 业务逻辑：认证 / 通知 / 活动 / 日历订阅 / 教务数据
│       ├── models/             # D1 数据访问（users / notices / activities / roles / academic）
│       ├── middleware/         # CORS / JWT 认证 / 权限 / 日志
│       └── utils/              # 统一响应 / PBKDF2 / JWT / 权限映射 / 时间处理 / iCalendar 生成 / 教务接口客户端 / CAS 代登录
├── schema.sql                  # D1 表结构
├── wrangler.toml               # 本地开发绑定（DB / JWT_SECRET，生产绑定在 Pages 面板配置）
├── package.json                # wrangler devDependency + 脚本（dev / deploy / db）
└── README.md
```

---

## 权限体系（按职位）

用户 `positions` 字段决定权限，**支持多个职位**（单值字符串或 JSON 数组，如 `["班长","团员"]`）。多职位时权限取**各职位权限的并集**。预设职位：

| 职位 | 内容权限（发布/编辑/删除 通知·活动） | 管理权限（注册账号·成员管理） |
| --- | :---: | :---: |
| 班长 / 团支书 | ✅ | ✅ |
| 学习委员 | ✅ | ❌ |
| 其它成员 | ❌（只读） | ❌ |

- **自定义职位**：可在「注册成员」表单里新建自定义职位并勾选权限（可发布内容 / 可管理成员），存入 `roles` 表持久化；注册时用 `role_name` 指定该职位的名称。无权限要求的自定义职位（如「团员」）直接写进 `positions` 即可，无需建 `roles`。注册 / 编辑成员时，可选项会自动包含**预设职位 + `roles` 表已定义的自定义职位 + 成员表中已在用的自定义职位**。
- **按职位一键选择提醒对象**：发布 / 编辑 通知·活动时，提醒对象选择区顶部会按成员职位生成快捷标签，点击即全选该职位的成员（最终保存为成员姓名快照）。
- 登录 / `me` 接口会返回当前用户的 `permissions` 数组，前端据此显隐发布/编辑/删除/成员管理入口。
- 读取（通知/活动列表、详情）对任意已登录用户开放。

---

## 后端 API 文档

### 基础信息

- 内容类型：请求/响应均为 `application/json`
- 认证：JWT（HS256），登录后获得 token，请求头携带 `Authorization: Bearer <token>`
- Token 有效期：默认 7 天

### 统一响应格式

```jsonc
// 成功
{ "success": true, "data": { ... } }
// 失败
{ "success": false, "error": "错误信息", "code": "ERROR_CODE" }
```

### 认证接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | `user:manage` | 注册账号（需班长/团支书） |
| POST | `/api/auth/login` | 公开 | 登录，返回 `token` + `user`（含 `permissions`） |
| GET | `/api/auth/me` | 登录 | 当前用户信息（含 `permissions`） |
| POST | `/api/auth/change-password` | 登录 | 修改自己密码 |
| PUT | `/api/auth/profile` | 登录 | 修改自己的联系方式（仅本人） |
| GET | `/api/auth/users` | `user:manage` | 班级成员列表 |
| PUT | `/api/auth/users/:id` | `user:manage` | 编辑成员（姓名/职务/联系方式） |
| DELETE | `/api/auth/users/:id` | `user:manage` | 删除成员 |
| GET | `/api/auth/members-pick` | 登录 | 成员精简列表（id/name/positions，供提醒对象按职位一键选择） |
| GET | `/api/auth/roles` | `user:manage` | 自定义职位列表（含 id/name/permissions） |
| POST | `/api/auth/roles` | `user:manage` | 新增/更新自定义职位（同名则覆盖权限） |
| DELETE | `/api/auth/roles/:id` | `user:manage` | 删除自定义职位 |

```jsonc
// 注册 POST /api/auth/register（body，需 user:manage）
{ "student_id":"2024001", "name":"张三", "password":"123456",
  "positions":["班长","团员"], "contact":"13800000000" }   // positions 可为字符串或数组（多职位）
// 自定义职位并配权限时额外传（role_name 指定该自定义职位名）：
{ "role_permissions": ["content:write","user:manage"], "role_name": "文艺委员" }

// 登录 POST /api/auth/login → 200
{ "success":true, "data":{
    "token":"eyJ...",
    "user":{ "id":1, "student_id":"2024001", "name":"张三",
             "positions":"[\"班长\"]", "contact":"", "permissions":["content:write","user:manage"] } } }

// 编辑成员 PUT /api/auth/users/:id（body，需 user:manage）
{ "name":"张三", "positions":["班长","学习委员"], "contact":"13800000000" }

// 修改自己的联系方式 PUT /api/auth/profile（body，需登录，仅能改本人）
{ "contact":"13800000000" }        // 留空字符串表示清空，最多 60 字符
```

### 通知接口（均需登录）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/notices` | `content:write` | 发布通知 |
| GET | `/api/notices` | 登录 | 通知列表（默认只返回「当前生效」，支持 `scope`/`date`，见下） |
| GET | `/api/notices/archive` | `content:write` | 归档列表（含已过期，供管理员查看） |
| GET | `/api/notices/:id` | 登录 | 通知详情 |
| PUT | `/api/notices/:id` | `content:write` | 编辑通知 |
| DELETE | `/api/notices/:id` | `content:write` | 删除通知 |

```jsonc
// 发布通知 POST /api/notices
{ "title":"班会通知", "content":"周六晚上 7 点开会",
  "publish_time":"2026-09-10 19:00:00",
  "expire_time":"2026-09-12 19:00:00",   // 选填，到期自动从列表隐藏
  "remind_people":["张三","李四"] }        // 选填，提醒对象（存为 JSON 字符串）
// 发布人 publisher 取当前登录用户名；source 默认 "manual"
```

### 活动接口（均需登录）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/activities` | `content:write` | 发布活动 |
| GET | `/api/activities` | 登录 | 活动列表（默认只返回「当前生效」，支持 `scope`/`date`，见下） |
| GET | `/api/activities/:id` | 登录 | 活动详情 |
| PUT | `/api/activities/:id` | `content:write` | 编辑活动 |
| DELETE | `/api/activities/:id` | `content:write` | 删除活动 |

```jsonc
// 发布活动 POST /api/activities
{ "title":"班级秋游", "content":"一起去公园野餐", "location":"西湖",
  "start_time":"2026-09-12 09:00:00", "end_time":"2026-09-12 16:00:00",
  "remind_people":["张三"] }
```

### 列表筛选参数（通知与活动一致）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `scope` | `active` | `active` 只返回「当前生效」的条目；`all` 返回全部（含未开始/已结束），供「全部」页按 进行中/将要开始/已结束 分类 |
| `date` | 不传 | `YYYY-MM-DD`，只返回时间窗口覆盖该日的条目，用于主页按日历选中日期展示 |
| `limit` / `offset` | `50` / `0` | 分页 |

时间窗口按「天」比较、两端都含：通知为 `[publish_time, expire_time]`，活动为 `[start_time, end_time]`。
不传 `date` 时以「今天」为目标日；结束时间为空时，通知视为永不失效，活动视为仅开始当天。

### 日历订阅接口

把班级日程同步到手机系统日历（iOS / 鸿蒙 / Android / 桌面通用，无需安装 App）。
系统日历无法携带 `Authorization` 头，因此订阅源用 URL 里的长期密钥鉴权。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/calendar/token` | 登录 | 取（首次访问则生成）本人订阅密钥与订阅地址 |
| POST | `/api/calendar/reset` | 登录 | 重置订阅密钥（旧链接立即失效） |
| GET | `/api/calendar.ics` | `?key=` 密钥 | `.ics` 订阅源，返回 `text/calendar` |

```jsonc
// GET /api/calendar/token → 200
{ "success":true, "data":{
    "key":"1b5b14a3...",                                          // 32 位十六进制
    "url":"https://class.qxwkstudio.top/api/calendar.ics?key=1b5b14a3...",
    "webcal":"webcal://class.qxwkstudio.top/api/calendar.ics?key=1b5b14a3..." } }   // 供 iOS/macOS 一键订阅
```

订阅源可选参数（未传时用默认值，前端「个人中心 → 日历订阅」会自动拼好）：

| 参数 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `remind` | 30 | 0–1440 | 活动开始前多少分钟提醒；`0` 表示不提醒。通知（全天事件）固定在当天 09:00 提醒 |
| `past` | 30 | 0–365 | 包含过去多少天的日程 |
| `future` | 365 | 1–730 | 包含未来多少天的日程 |
| `notices` | 0 | 0/1 | `1` 时把班级通知也作为当天全天事件加入 |

- 活动导出为 `VEVENT`，时间使用**浮动本地时间**（不带 `Z`/`TZID`，由日历客户端按本机时区解释，与服务端存储的本地时间一致）
- 未填结束时间的活动按 1 小时处理；通知的 `DTEND` 为次日（RFC 5545 全天事件约定）
- 密钥泄露时可在个人中心「重置密钥」一键作废旧订阅链接

---

### 教务系统接口（均需登录）

课表与学分来自教务系统（数智教学微服务平台）。前端与教务系统跨域，且会话 Cookie 为 HttpOnly，
浏览器里拿不到也调不通，因此统一由后端带着上报的 Cookie 代拉，并缓存进 D1。

绑定有三条路径，按体验排序：

1. **App 内一键绑定**：安卓端用 `CookieManager` 读出教务域 Cookie 上报给后端（教务对手机 UA 有兼容问题，登录全程固定桌面 UA）
2. **学号 + 密码代登录**：后端复刻统一身份认证（金智 CAS）登录链路，密码用完即弃（不落库、不打日志、不返回前端）
3. **手动粘贴 Cookie**：用户在电脑浏览器登录教务后自行复制，适合不愿交出密码的同学（页面内有分步指引）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/academic/status` | 绑定状态 + 已缓存学期 |
| POST | `/api/academic/login` | 学号+密码代登录后绑定，body `{ "student_id", "password" }`；需要验证码时返回 409，账号开了多因子认证时返回 `{ mfaRequired, token, contact, method }` |
| POST | `/api/academic/mfa/send` | 下发二次验证码（短信/邮箱），body `{ "token" }` |
| POST | `/api/academic/mfa/verify` | 提交验证码完成绑定，body `{ "token", "code" }` |
| POST | `/api/academic/bind` | 用会话 Cookie 绑定，body `{ "cookies": "..." }`（先调 sessionUserInfo 校验） |
| DELETE | `/api/academic/bind` | 解绑并清空该用户的教务缓存 |
| GET | `/api/academic/timetable` | 课表，`?xnxq=2026-2027-1` 指定学期，`?refresh=1` 强制重抓 |
| GET | `/api/academic/credits` | 学业达成 / 学分，`?refresh=1` 强制重抓 |

代登录走「统一身份认证（CAS）」，链路与两个关键约束见 `utils/casLogin.js`：

- **入口必须是教务侧的 SSO 地址**（`SsoUrl`，取自教务公开配置接口 `POST /api/qsmart/common/sysConfig/white`），
  由教务生成 CAS 的 `service`；若直接以登录页为 `service`，ticket 会落到一个不处理 ticket 的静态页，永远换不到会话。
  完整链路：`szjw/api/login/sso/cas/login` → `workflow/cas/login` → `authserver`（密码 + 多因子）→
  `workflow/sso/login` → `szjw/api/login/sso/cas/DEF_CAS/callback`（**换会话**）→ `szjw/`
- **多因子认证只支持短信/邮箱验证码**，且提交时固定 `skipTmpReAuth=false`（页面上的「仅本次登录」）。
  选「信任此设备」时 CAS 要登记设备指纹，服务端代登录场景会静默失败，表现为提交回「认证成功」
  但随后 `/login` 又被要求二次验证、流程永远走不完

```jsonc
// GET /api/academic/timetable → 200
{ "success":true, "data":{
    "xnxqId":"2026-2027-1",
    "terms":[{"id":"2026-2027-1","name":"2026-2027-1","current":true}],
    "periods":[{"index":3,"name":"第三节","start":"09:50","end":"10:35","block":"上午","code":"03"}],
    "firstDate":"2026-08-31", "weekCount":19,
    "courses":[{ "id":"1099331250402893824", "name":"马克思主义基本原理", "code":"MARX1021",
                 "teacher":"吴国清", "room":"公共教学楼A102", "campus":"滨江校区",
                 "weekday":5, "start":"09:50", "end":"12:15",
                 "weeks":[1,2,3], "weekText":"1-14", "credit":3,
                 "category":"公共必修课", "nature":"必修", "className":"生物育种[251-252]班" }],
    "unscheduled":[{ "name":"生物统计与试验设计Ⅲ", "code":"CROP4208", "credit":1, "hours":16,
                     "teacher":"[2020081]贺建波", "className":"生物育种251班", "category":"专业课程" }],
    "fetchedAt":"2026-09-10T16:14:43.245Z", "fromCache":false, "stale":false } }

// GET /api/academic/credits → 200
{ "success":true, "data":{
    "profile":{"grade":"2025","college":"农学院","major":"生物育种科学","className":"生物育种251",
               "plan":"2025级生物育种科学","matchRate":"82.76%"},
    "rows":[{"level":1,"name":"通识课程","leaf":false},
            {"level":3,"name":"思想政治理论必修课","required":18,"obtained":6,"current":8,
             "remaining":4,"achieved":false,"leaf":true}],
    "summary":{"required":173.5,"obtained":57,"current":25,"remaining":92.5,"achievedCount":9,"totalCount":23} } }
```

- **缓存策略**：命中且 6 小时内未过期直接回缓存；`refresh=1` 或已过期则重新抓取。
  教务不可达时回退旧缓存并置 `stale: true`（页面提示「显示的是缓存数据」）
- **登录态失效**：教务对未登录请求返回 401，据此把绑定标记为 `expired`，页面提示重新绑定
- **两处教务接口的坑**：`sessionUserInfo` 用 GET 且返回裸对象（无 `data` 包装）；
  「学业达成」返回的树末尾另有一条名为「总计」的叶子，按叶子累加会翻倍，须以它为准
- **代登录细节**：CAS 密码加密复刻自 authserver 的 `encrypt.js`（明文 = 随机 64 位串 + 密码，
  key = 登录页里的 `pwdEncryptSalt`，iv = 随机 16 位串，AES-CBC/Pkcs7 → Base64），
  并按页面行为一并提交明文 `passwordText` 兜底；登录链路的三级跳转按域分别记 Cookie
- **验证码**：由服务端按账号风控决定（`checkNeedCaptcha.htl`），实测正常登录不触发，
  同一账号连续失败数次后才要求验证码；触发时代登录无法继续，接口返回 409 引导用户改用手动绑定
- 学分接口需要「当前执行计划 id」，由 `detailBhzxjh` 返回的 `zxjhid` 提供，链路见 `handlers/academicHandler.js`
- 教务接口清单、请求体与固定桌面 UA 见 `backend/src/utils/schoolApi.js`

---

## 数据库表结构

`schema.sql`（Cloudflare D1 / SQLite）：

```sql
CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,             -- "盐值:PBKDF2哈希"
  auth_key       TEXT,                      -- 预留（Agent/Webhook 认证）
  positions      TEXT DEFAULT '学生',        -- 职位：单个字符串或 JSON 数组字符串（可多职位）
  contact        TEXT,
  update_time    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  publish_time   DATETIME NOT NULL,
  publisher      TEXT NOT NULL,
  remind_people  TEXT,                      -- JSON 数组字符串（提醒对象）
  source         TEXT DEFAULT 'manual',      -- manual / crawler / webhook
  expire_time    DATETIME,                  -- 过期时间，到期自动隐藏
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE roles (                        -- 自定义职位及其权限
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT UNIQUE NOT NULL,
  permissions  TEXT NOT NULL,                -- JSON 数组字符串
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE activities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  content        TEXT,
  location       TEXT,
  start_time     DATETIME NOT NULL,
  end_time       DATETIME,
  publisher      TEXT NOT NULL,
  remind_people  TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE academic_bindings (            -- 教务系统绑定（每用户一条）
  user_id       INTEGER PRIMARY KEY,
  student_no    TEXT,
  real_name     TEXT,
  school_uid    TEXT,                       -- 教务用户 id（各接口的 xsid / xsxxid）
  cookies       TEXT NOT NULL,              -- 教务域会话 Cookie
  status        TEXT DEFAULT 'ok',          -- ok / expired
  bound_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  checked_at    DATETIME
);

CREATE TABLE academic_timetable (           -- 课表缓存（按用户 + 学期）
  user_id       INTEGER NOT NULL,
  xnxq_id       TEXT NOT NULL,
  payload       TEXT NOT NULL,
  fetched_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, xnxq_id)
);

CREATE TABLE academic_credits (             -- 学业达成（学分）缓存
  user_id       INTEGER PRIMARY KEY,
  payload       TEXT NOT NULL,
  fetched_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE academic_mfa_sessions (        -- 多因子认证中间态（代登录被要求二次验证时暂存 CAS 会话）
  token         TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  state         TEXT NOT NULL,              -- CAS Cookie 罐 + reAuthParams（不含密码）
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

> 新库直接用 `schema.sql` 建表；已有库需执行迁移：`ALTER TABLE notices ADD COLUMN expire_time DATETIME;`、
> 创建 `roles` 表，以及创建上表 `academic_bindings` / `academic_timetable` / `academic_credits` / `academic_mfa_sessions`。

---

## 前端说明

- **应用壳布局**：`index.html` 为侧边栏 + 内容区（iframe 嵌入子页）；**小屏（≤768px）自动隐藏侧边栏、改为底部导航**（主页 / 通知 / 活动 / 课表 / 个人中心，共 5 项，符合底部导航 ≤5 项的规范），并针对手机做字号与间距密度适配
- **管理员入口**：桌面端固定在侧边栏；手机端底栏不再放（避免变成 6 项），改由「个人中心 → 管理员面板」卡片进入（仅手机端显示，按权限出现）
- **班级主页**：日历（可「回到今天」，有活动的日期可点击）、当日通知与当日活动、点击条目弹出详情弹窗
- **权限显隐**：`app.js` 提供 `canContentWrite()` / `canManageUsers()`（依据登录返回的 `permissions`），控制发布/编辑/删除与管理员入口的显示
- **管理员面板**：`admin.html`，左栏「添加通知 / 添加活动」、右栏「添加成员 / 管理成员」四个默认折叠区块，按权限显示（内容发布与成员管理都收在这里；成员编辑用弹窗）
- **通知页**：`content:write` 用户可发布/编辑/删除，并可用「查看过期」切到归档列表；
- **发布/编辑表单**：统一弹窗形式；可选「提醒对象」（成员以标签多选）、通知可设「存活至」（到期自动隐藏）
- **列表与详情**：列表行「标题 + 徽章」、元信息带图标（发布人 / 时间 / 地点），点击条目标题弹出详情弹窗
- **个人中心**：资料（联系方式可自助修改）、主题外观、日历订阅（可自定义提醒提前量/时间范围/是否含通知，并可重置密钥）、修改密码、强制刷新（清除本地缓存并重载，用于修复样式错乱）、退出登录（红色警示卡）
- **课表与学业**：`academic.html` —— 课表按节次网格渲染（当前周高亮、非本周淡出）、未安排课程列表、学业达成学分看板（要求/已获/在修/还需 + 逐课程体系明细）；未绑定时提供三条绑定路径（App 一键 / 学号密码代登录 / 手动粘贴 Cookie 并附分步指引）；账号开了多因子认证时，学号密码代登录会自动进入第二步（下发验证码 → 回填 → 完成绑定，带 60 秒重发倒计时）
- **API 封装**：`assets/js/app.js` 提供 `api(path, options)`，自动附带 `Bearer` token、401 自动回登录页
- **主题**：`data-theme` 深浅色（液态玻璃风格），localStorage 记忆
- `API_BASE` 保持 `''`（前后端同域，走 Pages Functions）

---

## 生产部署（Cloudflare Pages，前后端一体）

1. **创建 Pages 项目**：构建根目录设为 `web/`（或本地 `npm run deploy`）
2. **绑定资源（Settings → Functions）**：
   - **D1 database bindings**：变量名 `DB` → 选择 `class-assistant` 数据库
   - **Environment variables**：`JWT_SECRET`（强随机值，如 `openssl rand -hex 32`）
3. **一键建表**：新库 `npm run db:remote`；已有库执行上文迁移 SQL
4. **自定义域名**：Pages → Custom domains → 添加域名，在域名商把 CNAME 指向 `<项目名>.pages.dev`
5. **部署**：`cd web; npm install; npm run deploy`（`wrangler pages deploy .`），或关联 git 仓库 push 自动构建

> `/api/*` 由 `functions/api/[[path]].js` 接管，静态页面与后端同域，无需 CORS / 反向代理。

---

## 安全说明

- 密码使用 Web Crypto PBKDF2（10 万次迭代 + 随机盐），不存明文
- JWT 密钥存放于 Pages 环境变量 `JWT_SECRET`，生产请使用强随机值
- **教务代登录**：学号密码只在单次请求内存里用于换取会话，**不落库、不打日志、不返回前端**；
  服务端只保留教务域的会话 Cookie；多因子验证码同样不落库（中间态只存 CAS 会话与流程参数，10 分钟过期）
- 内容写操作（发布/编辑/删除）与成员管理均按职位鉴权
- 前端所有用户输入经 `esc()` 转义，防止 XSS
