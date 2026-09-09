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
├── index.html                  # 应用壳：左侧固定栏 + 右侧内容区（iframe）
├── notices.html                # 通知列表/详情（iframe 内容页）—— 发布/编辑/删除/过期归档/提醒对象
├── activities.html             # 活动列表/详情（iframe 内容页）—— 发布/编辑/删除/提醒对象
├── account.html                # 个人中心 —— 资料 / 修改密码 / 成员管理（注册·编辑·删除）
├── assets/
│   ├── css/style.css           # 共享样式（主题变量 + 组件）
│   └── js/app.js               # API 封装 + 会话管理 + 权限判断 + 工具
├── backend/
│   └── src/                    # 后端源码（被 functions 引入，同域运行）
│       ├── index.js            # fetch 入口（CORS 预检 + 路由分发 + 404）
│       ├── routes/             # 路由分发：auth / notices / activities
│       ├── handlers/           # 业务逻辑：认证 / 通知 / 活动
│       ├── models/             # D1 数据访问（users / notices / activities / roles）
│       ├── middleware/         # CORS / JWT 认证 / 权限 / 日志
│       └── utils/              # 统一响应 / PBKDF2 / JWT / 权限映射
├── schema.sql                  # D1 表结构
├── wrangler.toml               # 本地开发绑定（DB / JWT_SECRET，生产绑定在 Pages 面板配置）
├── package.json                # wrangler devDependency + 脚本（dev / deploy / db）
└── README.md
```

---

## 权限体系（按职位）

用户 `positions` 字段决定权限（可为单值或 JSON 数组）。预设职位：

| 职位 | 内容权限（发布/编辑/删除 通知·活动） | 管理权限（注册账号·成员管理） |
| --- | :---: | :---: |
| 班长 / 团支书 | ✅ | ✅ |
| 学习委员 | ✅ | ❌ |
| 其它成员 | ❌（只读） | ❌ |

- **自定义职位**：可在「注册成员」表单里新建自定义职位并勾选权限（可发布内容 / 可管理成员），存入 `roles` 表持久化。
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
| GET | `/api/auth/users` | `user:manage` | 班级成员列表 |
| PUT | `/api/auth/users/:id` | `user:manage` | 编辑成员（姓名/职务/联系方式） |
| DELETE | `/api/auth/users/:id` | `user:manage` | 删除成员 |
| GET | `/api/auth/members-pick` | 登录 | 成员精简列表（id/name，供提醒对象选择） |

```jsonc
// 注册 POST /api/auth/register（body，需 user:manage）
{ "student_id":"2024001", "name":"张三", "password":"123456",
  "positions":"班长", "contact":"13800000000" }   // positions 可为字符串或数组
// 自定义职位时额外传：
{ "role_permissions": ["content:write","user:manage"] }

// 登录 POST /api/auth/login → 200
{ "success":true, "data":{
    "token":"eyJ...",
    "user":{ "id":1, "student_id":"2024001", "name":"张三",
             "positions":"[\"班长\"]", "contact":"", "permissions":["content:write","user:manage"] } } }

// 编辑成员 PUT /api/auth/users/:id（body，需 user:manage）
{ "name":"张三", "positions":["班长","学习委员"], "contact":"13800000000" }
```

### 通知接口（均需登录）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/notices` | `content:write` | 发布通知 |
| GET | `/api/notices` | 登录 | 通知列表（自动过滤已过期） |
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
| GET | `/api/activities` | 登录 | 活动列表 |
| GET | `/api/activities/:id` | 登录 | 活动详情 |
| PUT | `/api/activities/:id` | `content:write` | 编辑活动 |
| DELETE | `/api/activities/:id` | `content:write` | 删除活动 |

```jsonc
// 发布活动 POST /api/activities
{ "title":"班级秋游", "content":"一起去公园野餐", "location":"西湖",
  "start_time":"2026-09-12 09:00:00", "end_time":"2026-09-12 16:00:00",
  "remind_people":["张三"] }
```

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
  positions      TEXT DEFAULT '学生',        -- JSON 数组字符串（职位）
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
```

> 新库直接用 `schema.sql` 建表；已有库需执行迁移：`ALTER TABLE notices ADD COLUMN expire_time DATETIME;` 并创建 `roles` 表。

---

## 前端说明

- **应用壳布局**：`index.html` 登录后显示左侧侧边栏（主页/活动/通知 + 底部用户区），右侧以 iframe 嵌入 `notices.html` / `activities.html` / `account.html`
- **权限显隐**：`app.js` 提供 `canContentWrite()` / `canManageUsers()`（依据登录返回的 `permissions`），控制发布/编辑/删除/成员管理入口的显示
- **通知页**：`content:write` 用户可发布/编辑/删除，并可用「查看过期」切到归档列表；
- **发布/编辑表单**：可选「提醒对象」（从成员多选）、通知可设「存活至」（到期自动隐藏）
- **个人中心**：资料、修改密码；`user:manage` 用户额外看到「班级成员管理」（注册/编辑/删除/自定义职位）
- **API 封装**：`assets/js/app.js` 提供 `api(path, options)`，自动附带 `Bearer` token、401 自动回登录页
- **主题**：`data-theme` 深浅色，localStorage 记忆
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
- 内容写操作（发布/编辑/删除）与成员管理均按职位鉴权
- 前端所有用户输入经 `esc()` 转义，防止 XSS
