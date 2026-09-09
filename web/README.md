# Class Assistant · Web 模块

「班级助理」项目的 Web 门户：**Cloudflare Pages 一体部署**（静态前端 + Functions 后端 + D1），纯 HTML/CSS/JS。

- 前端：根目录静态文件 — 原生 HTML/CSS/JS，应用壳布局（左侧固定栏 + 右侧内容区 iframe 嵌入）
- 后端：`backend/src/` — 经 `functions/api/[[path]].js` 接入 Pages Functions，JWT + PBKDF2 认证，通知/活动 CRUD，**运行时零依赖**（Web Crypto / 原生 fetch）
- 数据库：Cloudflare D1（SQLite）

---

## 目录结构

```
web/                            # Cloudflare Pages 项目根目录（直接部署本层）
├── functions/
│   └── api/
│       └── [[path]].js         # Pages Functions 入口：仅接管 /api/*，复用 backend/src 的 fetch handler
├── index.html                  # 应用壳：左侧固定栏 + 右侧内容区（iframe）
├── notices.html                # 通知列表/详情（iframe 内容页）
├── activities.html             # 活动列表/详情（iframe 内容页）
├── account.html                # 个人中心（iframe 内容页）
├── assets/
│   ├── css/style.css           # 共享样式（主题变量 + 组件）
│   └── js/app.js               # API 封装 + 会话管理 + 工具
├── backend/
│   └── src/                    # 后端源码（被 functions 引入，同域运行）
│       ├── index.js            # fetch 入口（CORS 预检 + 路由分发 + 404）
│       ├── routes/             # 路由分发：auth / notices / activities
│       ├── handlers/           # 业务逻辑：认证 / 通知 / 活动
│       ├── models/             # D1 数据访问（users / notices / activities）
│       ├── middleware/         # CORS / JWT 认证 / 日志
│       └── utils/              # 统一响应 / PBKDF2 / JWT
├── schema.sql                  # D1 表结构
├── wrangler.toml               # 本地开发绑定（DB / JWT_SECRET，生产绑定在 Pages 面板配置）
├── package.json                # wrangler devDependency + 脚本（dev / deploy / db）
└── README.md
```

---

## 后端 API 文档

### 基础信息

- **内容类型**：请求/响应均为 `application/json`
- **认证**：JWT（HS256），登录后获得 token，请求头携带 `Authorization: Bearer <token>`
- **Token 有效期**：默认 7 天

### 统一响应格式

```jsonc
// 成功
{ "success": true, "data": { ... } }

// 失败
{ "success": false, "error": "错误信息", "code": "ERROR_CODE" }
```

### 错误码

| 状态码 | 错误码 | 说明 |
| --- | --- | --- |
| 400 | `MISSING_FIELDS` | 必填字段缺失 |
| 400 | `INVALID_ID` | 无效的 ID |
| 401 | `UNAUTHORIZED` | 未登录或 token 过期/无效 |
| 401 | `INVALID_CREDENTIALS` | 学号或密码错误 |
| 404 | `NOTICE_NOT_FOUND` / `ACTIVITY_NOT_FOUND` | 记录不存在 |
| 404 | `NOT_FOUND` | 接口不存在 |
| 409 | `STUDENT_ID_EXISTS` | 学号已注册 |
| 500 | `REGISTER_FAILED` / `LOGIN_FAILED` 等 | 服务器内部错误 |

---

### 认证接口

#### 1. 注册 `POST /api/auth/register`（无需登录）

```jsonc
// 请求体
{
  "student_id": "2024001",        // 必填，学号（唯一）
  "name": "张三",                 // 必填，姓名
  "password": "123456",           // 必填，至少 6 位
  "positions": ["班长", "学习委员"], // 选填，职务（数组或逗号分隔字符串，存为 JSON 字符串）
  "contact": "13800000000"        // 选填，联系方式
}

// 响应 201
{ "success": true, "data": { "message": "注册成功" } }
```

#### 2. 登录 `POST /api/auth/login`（无需登录）

```jsonc
// 请求体
{ "student_id": "2024001", "password": "123456" }

// 响应 200
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",   // JWT，后续请求头携带
    "user": { "id": 1, "student_id": "2024001", "name": "张三", "positions": "[\"班长\"]", "contact": "13800000000" }
  }
}
```

#### 3. 获取当前用户 `GET /api/auth/me`（需登录）

```jsonc
// 响应 200
{ "success": true, "data": { "id": 1, "student_id": "2024001", "name": "张三", "positions": "[\"班长\"]", "contact": "13800000000", "update_time": "2026-08-22 04:16:31" } }
```

---

### 通知接口（均需登录）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/notices` | 发布通知 |
| GET | `/api/notices?limit=&offset=` | 通知列表（按发布时间倒序） |
| GET | `/api/notices/:id` | 通知详情 |
| PUT | `/api/notices/:id` | 更新通知（部分字段） |
| DELETE | `/api/notices/:id` | 删除通知 |

```jsonc
// 发布通知 POST /api/notices
{
  "title": "班会通知",              // 必填
  "content": "周六晚上 7 点开会",     // 必填
  "publish_time": "2026-08-25 19:00:00", // 必填，格式 "YYYY-MM-DD HH:MM:SS"
  "remind_people": ["张三", "李四"]  // 选填，提醒对象（存为 JSON 字符串）
}
// 发布人 publisher 自动取当前登录用户名；来源 source 默认 "manual"

// 列表 GET /api/notices?limit=50&offset=0 → 响应
{ "success": true, "data": { "list": [ { "id": 1, "title": "...", "content": "...", "publish_time": "...", "publisher": "张三", "remind_people": "[\"张三\"]", "source": "manual", "created_at": "..." } ], "total": 1 } }
```

---

### 活动接口（均需登录）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/activities` | 发布活动 |
| GET | `/api/activities?limit=&offset=` | 活动列表（按开始时间倒序） |
| GET | `/api/activities/:id` | 活动详情 |
| PUT | `/api/activities/:id` | 更新活动（部分字段） |
| DELETE | `/api/activities/:id` | 删除活动 |

```jsonc
// 发布活动 POST /api/activities
{
  "title": "班级秋游",               // 必填
  "content": "一起去公园野餐",        // 选填
  "location": "西湖",                // 选填
  "start_time": "2026-09-05 09:00:00", // 必填
  "end_time": "2026-09-05 16:00:00",   // 选填
  "remind_people": ["张三"]          // 选填
}
```

---

## 数据库表结构

`backend/schema.sql`（Cloudflare D1 / SQLite）：

```sql
-- 用户表（注意：无 created_at，有 auth_key 预留字段）
CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,            -- "盐值:PBKDF2哈希"（hex）
  auth_key       TEXT,                     -- 预留（如 Agent/Webhook 认证）
  positions      TEXT DEFAULT '学生',       -- JSON 数组字符串
  contact        TEXT,
  update_time    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  publish_time   DATETIME NOT NULL,
  publisher      TEXT NOT NULL,
  remind_people  TEXT,                     -- JSON 数组字符串，可空
  source         TEXT DEFAULT 'manual',     -- manual / crawler / webhook
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
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

---

## 前端说明

- **纯 HTML/CSS/JS**，无构建、无框架，静态文件直接部署
- **应用壳布局**：`index.html` 登录后显示左侧固定侧边栏（主页/活动/通知 + 底部用户区），右侧内容区以 iframe 嵌入 `notices.html` / `activities.html` / `account.html`
- **登录面板**：未登录时也在应用壳内，点侧边栏「登录」在右侧显示登录表单；未登录不加载任何日程数据
- **API 封装**：`assets/js/app.js` 提供 `api(path, options)`，自动附带 `Bearer` token、401 自动回登录页、`saveSession/logout` 等
- **主题**：`data-theme` 深浅色，localStorage `theme`，iframe 内页同步
- **侧边栏折叠**：状态存 localStorage `sidebarCollapsed`

### 前端配置

`assets/js/app.js` 顶部：

```js
const API_BASE = ''; // 与后端同域部署，保持空字符串（相对路径 /api/* 走 Pages Functions）
```

---

## 生产部署（Cloudflare Pages，前后端一体）

### 1. 创建 Pages 项目并绑定资源

- Pages 项目构建根目录设为 `web/`（或本地直接 `npm run deploy`）
- Dashboard → **Settings → Functions**：
  - **D1 database bindings**：变量名 `DB`，选择 `class-assistant-db`
  - **Environment variables**：`JWT_SECRET`（强随机值，如 `openssl rand -hex 32`）
- 全新库建表：`npm run db:remote`

### 2. 自定义域名（仅需 CNAME，无需域名转入账户）

Pages → **Custom domains** → 添加域名，按提示在域名商把 CNAME 指向 `<项目名>.pages.dev`，Cloudflare 自动签发证书。

### 3. 部署

```bash
cd web
npm install
npm run deploy          # wrangler pages deploy .
```

或关联 git 仓库后 push 自动构建。

### 说明

- `/api/*` 由 `functions/api/[[path]].js` 接管，静态页面与后端同域，**无需 CORS / 反向代理**
- `API_BASE` 保持 `''`；`_redirects` 不再需要
- 本地开发：`npm run dev`（`wrangler pages dev .`），首次运行前 `npm run db:local` 建本地 D1 库

---

## 安全说明

- 密码使用 Web Crypto PBKDF2（10 万次迭代 + 随机盐），不存明文
- JWT 密钥存放在 Pages 项目环境变量 `JWT_SECRET`，生产请更换为强随机值
- 所有受保护接口（通知/活动/个人）均需有效 JWT
- 前端所有用户输入经 `esc()` 转义，防止 XSS
