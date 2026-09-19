# iOS 端（PWA）实施方案

- 状态：待评审（未写任何功能代码）
- 日期：2026-09-13
- 前置决策（已与项目主确认）：**走 PWA，不做原生**；不购买 $99/年 Apple Developer；班里 iPhone 用户 ≤5 人；有 Mac + Xcode 但不打算用

---

## 一、需求与目标

让班里 iPhone 同学获得接近安卓 App 的体验，且**不花钱、不经过商店审核、不涉及备案**：

1. 桌面有独立图标，点开全屏运行（无 Safari 地址栏）
2. 能收到通知（锁屏 / 通知中心 / Apple Watch）
3. 点通知能跳到对应的通知或活动详情
4. 尽量复用现有 Web 资产，不重写界面

### 明确不做（PWA 做不到，或本阶段不值得）

- **桌面小组件**：WidgetKit 必须原生 App，安卓那个 `TodayWidgetProvider` 无法对应
- **不装到主屏就能收通知**：iOS 硬限制，见下
- 原生性能优化、原生手势、原生分享等

### 运营成本（必须让同学知道）

- iOS 用户**必须手动「添加到主屏」**，否则 PWA 收不到任何通知（普通 Safari 标签页里 `window.PushManager` 是 `undefined`，申请权限会静默失败）
- 需要 **iOS / iPadOS 16.4 及以上**（2023 年 3 月后）。低于此版本的设备在 PWA 内完全没有通知能力，只能靠群消息兜底。
  **待确认**：班里那几位 iPhone 同学的系统版本是否都 ≥ 16.4

---

## 二、为什么是 PWA（ADR）

### 决策驱动

| 驱动 | 权重 | 说明 |
|---|---|---|
| 预算 | 高 | 项目主明确不花 $99/年 |
| 用户规模 | 高 | ≤5 人，投入产出比是首要约束 |
| 合规成本 | 中 | App Store 中国大陆区新 App 需 ICP 备案强校验 |
| 复用现有资产 | 高 | Web 端功能已完整，安卓端本身就只是 WebView 壳 |
| 推送可达性 | 高 | 通知是本项目核心价值，不能砍 |

### 已排除的方案

| 方案 | 排除理由 |
|---|---|
| App Store 正式上架 | $99/年 + **ICP 备案强校验**（Apple 已对新 App 强制校验，[官方说明](https://developer.apple.com/tw/help/app-store-connect/reference/app-information/app-information)）+ 纯网页壳会撞 4.2 最低功能条款 |
| 原生 + TestFlight | $99/年；构建 90 天过期需反复重传；5 个用户不值得 |
| Ad-hoc 描述文件签名 | $99/年 + 需 Mac + 每年最多 100 台 UDID 且每年重签 |
| 自签（AltStore 等） | 免费但 **7 天过期**，让 5 个同学每周重签不可维护 |
| Flutter / RN 跨端 | 为 5 个用户重写一套 UI，且要重做推送/深链；与现有 Web 资产完全重复 |

### 决定性事实

**iOS Web Push 不需要加入 Apple Developer Program。** Apple 官方文档原话：*"You don't need to join the Apple Developer Program to send web push notifications."*（[Apple 文档](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers/)、[WebKit 博客](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)）

这一条把「零预算」和「要有推送」两个约束同时满足了，是整个决策的支点。

**顺带解决的合规问题**：PWA 是网站而非商店分发的 App，且后端在 Cloudflare（境外），ICP 备案与 App 备案都不适用。

### 结论

选 **PWA（manifest + Service Worker + Web Push）**，分三阶段推进，每阶段可独立上线、独立回滚。

---

## 三、现状盘点（已核实）

| 项 | 现状 | 对本方案的影响 |
|---|---|---|
| `viewport-fit=cover` | ✅ 已有（各页 `<head>`） | 阶段一省一步 |
| safe-area 适配 | ✅ 已全面应用（`--safe-*` 变量 + 底部导航/弹层/main 内边距） | 刘海屏与 Home Indicator 已处理 |
| 主题色 meta | ✅ 已有，含 light/dark 双 media 查询 | 直接可复用 |
| 应用图标 | ⚠️ 只有内联 SVG data-URI favicon | 需补 PNG（iOS 的 `apple-touch-icon` 不接受 SVG） |
| `manifest.json` | ❌ 无 | 阶段一新建 |
| Service Worker | ❌ 无 | 阶段二新建，**必须放 `web/` 根**（作用域限制） |
| `_headers` | ✅ 已有，覆盖 `/assets/*`、`/*.html`、`/` | **需补 `/sw.js`、`/manifest.json` 规则**，否则 SW 会被缓存住、更新不生效 |
| 登录态存储 | `localStorage`（token + user），见 `web/assets/js/app.js:47-60` | SW 不得缓存带鉴权的接口响应 |
| 页面结构 | 7 个独立 HTML（index / notices / activities / academic / forms / admin / account） | 多页应用；SW 需按导航请求处理 |
| 后端入口 | `functions/api/[[path]].js` catch-all → Worker，签名 `fetch(request, env, ctx)` | **`ctx.waitUntil` 可用**，推送可异步发 |
| 鉴权包装 | `withAuth` / `withPermission`（`middleware/auth.js`） | 新接口直接复用 |
| 通知对象口径 | 队友已建 `utils/audience.js` 作为「谁算全班」唯一判定口（含 `class:exclude`） | **推送必须复用同一判定口**，不能另写一套 |
| 通知深链 | 通知/活动已有 `link` 字段与深链支持 | 推送点击的目标可直接复用 |
| 现有推送测试入口 | `web/account.html:327-340`「开发功能」卡片，目前仅安卓壳的 `CAHost` 桥可用 | iOS 订阅入口就放这里，替换掉「仅安卓」的提示 |
| 后端推送设施 | ❌ 无设备/订阅表，无推送接口 | 阶段三新增 |

---

## 四、分阶段交付

### 阶段一：可安装（风险最低，收益最直接）

**改动**

1. 新建 `web/manifest.json`：`name` / `short_name` / `start_url: "/"` / `display: "standalone"` / `background_color` / `theme_color` / `icons`（192、512，`purpose` 含 `any` 与 `maskable`）
2. 生成图标 PNG 到 `web/assets/icons/`：180（`apple-touch-icon`）、192、512。图形沿用现有 favicon 那个对话气泡标记，配色沿用主题蓝 `#2196f3`
   - 生成方式：用 `@resvg/resvg-js` 一次性把 SVG 渲染成 PNG，**只提交产物、不把渲染器留在依赖里**，避免引入构建期依赖
3. 各页 `<head>` 补 iOS 专用 meta：`apple-mobile-web-app-capable`、`apple-mobile-web-app-status-bar-style`、`apple-mobile-web-app-title`、`<link rel="apple-touch-icon">`
4. `_headers` 补两条：
   ```
   /sw.js
     Cache-Control: no-cache
   /manifest.json
     Cache-Control: no-cache
   ```
5. **「添加到主屏」引导**：iOS 上（`/iPad|iPhone|iPod/.test(navigator.userAgent)` 且 `!matchMedia('(display-mode: standalone)').matches`）在「开发功能」卡片里显示图文引导；安卓 Chrome 走 `beforeinstallprompt` 原生安装按钮
   - 沿用现有原则：**不做假的成功反馈**，做不到就明确说清怎么做到

**验收标准**

- AC-1：`curl -I https://class.qxwkstudio.top/manifest.json` 返回 200 且 `Content-Type` 为 `application/manifest+json`
- AC-2：iOS Safari 分享菜单出现「添加到主屏幕」，添加后桌面图标是自定义图标（不是网页截图）
- AC-3：从主屏图标启动，无地址栏/工具栏；底部导航不被 Home Indicator 遮挡，顶部不被刘海遮挡（与 Safari 内对比截图）
- AC-4：`curl -I https://class.qxwkstudio.top/sw.js` 返回 `Cache-Control: no-cache`
- AC-5：安卓 Chrome 访问时出现原生安装提示，安装后同样全屏运行

### 阶段二：Service Worker（离线壳 + 缓存策略）

**这一步是本方案最需要克制的地方** —— 加 SW 会引入「用户被旧缓存卡住」这一类问题，**项目上已经踩过一次**（课表页 `status` 事件、以及「完全刷新了还是不行」的排查过程）。策略必须保守。

**缓存策略（逐条明确）**

| 请求类型 | 策略 |
|---|---|
| `/api/*` | **完全不拦截**（直接放行，不进缓存） |
| 导航请求（HTML） | network-first，失败回退缓存（离线壳） |
| `/assets/*`、`/manifest.json`、图标 | cache-first，缓存名带版本号 |
| `/sw.js` 自身 | 不缓存（靠 `_headers` 的 no-cache 保证更新） |

**要点**

1. SW 注册新版本后调用 `skipWaiting()` + `clients.claim()`，避免用户长期停在旧版本
2. 缓存名带版本常量（简陋但够用），旧缓存于 `activate` 阶段清理
3. **`forceRefresh()` 必须与 SW 协同**：现有「清除缓存并刷新」需要同时清空 SW 缓存并触发 SW 更新，否则用户点了没效果、更困惑
4. 离线时给出明确提示，不要假装有新数据

**验收标准**

- AC-6：首次访问后断网重开（从主屏图标），能看到应用壳并有明确离线提示，而不是浏览器错误页
- AC-7：**断网后调接口必须报网络错误，而不是返回上一次的旧数据**（证明 API 没被缓存）
- AC-8：发布一次前端改动 → 用户刷新即拿到新版本，**不会卡在旧版本**（这条要专门测，是本阶段最大的风险点）
- AC-9：个人页「清除缓存并刷新」后，SW 缓存被清空且注册更新到最新

### 阶段三：Web Push（带可行性验证 gate）

#### 3.0 可行性验证（必须先做，做完再决定是否继续）

在正式实现前，用一个最小闭环验证两件不确定的事实：

1. **Workers 能否直接 POST 到 Apple 的 web push 端点**。Apple 文档写了 *"APNs supports both HTTP/1.1 and HTTP/2.0. The default protocol is HTTP/1.1."*，即理论上可以，但这是文档结论，**未实测**。
2. **能否在 Workers 内完成 payload 加密**。Web Push 需要 ECDH P-256 + HKDF + AES-128-GCM，而常用的 `web-push` npm 包依赖 Node 的 `crypto` 模块，**在 Workers 里跑不了**。需用 WebCrypto 自行实现，或改用专为 Workers 写的库。

**gate 判定**：若第 2 点走不通，本阶段退回「iOS 端不做推送」（阶段一二的收益不受影响），而不是硬做或偷偷降级。

#### 3.1 后端

1. 新迁移 `web/migrations/2026-09-XX-push.sql`：
   ```sql
   CREATE TABLE IF NOT EXISTS push_subscriptions (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id     INTEGER NOT NULL,
     endpoint    TEXT NOT NULL UNIQUE,
     p256dh      TEXT NOT NULL,
     auth        TEXT NOT NULL,
     ua          TEXT,
     created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
     last_ok_at  DATETIME
   );
   CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
   ```
   `endpoint` 全局唯一 —— 同一浏览器/设备重复订阅是同一条，**换账号登录时必须改绑 user_id**，否则旧用户会继续收到推送
2. VAPID 密钥对放 Pages Secrets（`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`），**私钥绝不进仓库**；前端通过 `GET /api/push/config` 取公钥，便于将来轮换而不用改前端
3. 接口（复用 `withAuth`）：
   - `GET  /api/push/config` — 返回 VAPID 公钥与是否启用
   - `POST /api/push/subscribe` — 落库/改绑
   - `POST /api/push/unsubscribe` — 按 endpoint 删行
4. 发送逻辑：`utils/push.js` 提供 `sendPushToUsers(env, ctx, userIds, payload)`
   - **收件人必须用现有 `utils/audience.js` 判定**，与通知/活动/表单列表口径一致（含 `class:exclude`），不得另写一套
   - 在 `ctx.waitUntil()` 内发送，**不阻塞发通知的响应**
   - 端点返回 **404/410 → 立即删行**（订阅已死）
   - 同一事件同一用户只发一次；按 endpoint 去重
5. 接入三个触发点：`handleCreateNotice`、`handleCreateActivity`、`handleCreateForm`

#### 3.2 前端

1. `web/sw.js` 加 `push` 与 `notificationclick` 处理
   - **Safari 不允许「隐形推送」**：收到推送必须立刻 `showNotification`，否则权限会被撤销 —— 这是硬要求
   - `notificationclick` 用通知的 `link` 深链跳转，复用现有深链能力
2. `web/account.html:327-340` 的推送卡片改造：
   - 已装到主屏的 iOS PWA / 支持的安卓浏览器 → 「开启通知」按钮，**在用户点击手势里**申请权限并订阅（iOS 要求必须在手势内）
   - iOS 普通 Safari 标签页 → 不给死按钮，直接显示「请先添加到主屏」的引导
   - 沿用现有注释所写的原则：不支持的场景不做假的成功反馈

**验收标准**

- AC-10：订阅成功后 D1 的 `push_subscriptions` 出现该用户记录（endpoint / p256dh / auth 齐全）
- AC-11：班委发一条通知 → 该用户 iPhone 锁屏收到通知，标题与通知一致
- AC-12：点击通知跳到该通知的详情（深链生效）
- AC-13：制造一次 410 响应 → 对应订阅行被删除，后续发送不再尝试该端点
- AC-14：**同一台设备换另一个账号登录并订阅后，推送发给新账号，不再发给旧账号**
- AC-15：被 `class:exclude` 排除的人**不收到**推送（与通知列表口径一致）
- AC-16：发通知接口的响应时间不因推送而变长（推送在 `waitUntil` 内）
- AC-17：在 Safari 普通标签页（未装到主屏）点「开启通知」→ 给出明确引导，不产生任何错误状态

---

## 五、Pre-mortem：这个方案可能怎么失败

1. **加了 SW 后用户被旧缓存卡住**（历史踩坑的同类问题）。缓解：HTML 走 network-first、`skipWaiting`、`_headers` 给 `/sw.js` 加 no-cache、AC-8 专测、`forceRefresh` 协同清 SW 缓存
2. **Workers 里做不出 aes128gcm 加密**。缓解：阶段 3.0 先验证，失败就退回不做推送，不硬做
3. **iPhone 用户系统低于 16.4 或不愿加主屏**。缓解：明确引导 + 群消息兜底；**不要让他们以为开了但收不到**
4. **VAPID 私钥泄露**。缓解：只放 Pages Secrets，仓库与前端都不出现
5. **推送风暴 / 重复推送**。缓解：按 endpoint 去重、同一事件同一用户只发一次、`waitUntil` 内并发但设上限
6. **订阅表膨胀**（反复订阅产生死行）。缓解：410/404 即删；`endpoint` 唯一约束天然收敛
7. **Safari 静默撤销权限**（收到推送未展示）。缓解：SW 的 `push` 处理里无条件 `showNotification`
8. **SW 作用域放错**（放子目录导致管不到页面）。缓解：必须放 `web/` 根，AC-4 验证可访问性
9. **推送绕过了 `class:exclude` 口径**，导致被排除的人收到通知。缓解：强制复用 `utils/audience.js`，AC-15 覆盖

---

## 六、Follow-ups（本方案明确不做，留观察）

- 桌面/锁屏小组件（必须原生 App，需 $99，本阶段不做）
- Safari 18.4+ 的 **Declarative Web Push**（服务端直接发 JSON、浏览器渲染，可省掉 SW 里的 push 处理）—— 值得将来简化
- 离线填写表单草稿、后台同步（Background Sync 在 iOS 支持有限）
- 安卓端收敛：PWA 就绪后，安卓壳是否还需要保留（壳目前额外提供桌面小组件与 `CAHost` 推送桥，短期不建议动）

---

## 七、风险排序与推进建议

| 阶段 | 风险 | 收益 | 建议 |
|---|---|---|---|
| 一：可安装 | 极低 | 立即可见的体验提升 | **先做** |
| 二：Service Worker | 中（缓存类 bug 有前科） | 离线壳 + 为推送做准备 | 做完一之后单独评审 |
| 三：Web Push | 高（含一个未验证的技术前提） | iOS 通知能力 | 先做 3.0 验证 gate |

三个阶段互不阻塞，可在任一步停下来，已上线的部分不受影响。

---

## 八、实施记录（2026-09-13）

分支 `codex/ios-pwa`，worktree `Class-Assistant-ios`。

### 阶段一、二：已完成

- `manifest.json`（`display: standalone`、`scope: /`、192/512 + maskable 图标）、PNG 图标（含 180 的 `apple-touch-icon`）、7 个页面的 iOS meta
- `sw.js`：接口不拦截、页面 network-first + 断网回退、静态资源成功即刷缓存、`skipWaiting` + `clients.claim`
- `_headers` 给 `/manifest.json`、`/sw.js` 加 `no-cache`；`forceRefresh()` 追加 SW 更新检查
- 安装引导（iOS 文案引导 / 安卓 `beforeinstallprompt` / 已装或已关闭则隐藏）
- 本机浏览器实测通过；AC-1、AC-4、AC-5 已验（`manifest.json` 的 `Content-Type: application/manifest+json` 与两条 no-cache 已在 `wrangler pages dev` 下确认）；AC-2、AC-3、AC-6~AC-9 待真机复核

### 阶段三 3.0 可行性 gate：**通过**

| 验证项 | 方法 | 结果 |
|---|---|---|
| Workers 里能否做 aes128gcm 加密 | 纯 WebCrypto 自实现（`utils/webpush.js`），用参考实现 `http_ece`（`web-push` 的底层）反向解密 | **通过**，9/9 断言（载荷长度、`rs`、`keyid`、明文一致、VAPID 头格式、ES256 头、`aud`、`exp`/`sub`、公钥验签） |
| 同款运行时能否跑通 | 本地 `wrangler dev`（同为 workerd）跑探针，真做一次 ECDH + HKDF + AES-128-GCM 与 ES256 签名 | **通过**（载荷 143 字节与预期一致、`rs=4096`、`keyid` 65 字节、VAPID 头 338 字节） |
| 真实 Apple 推送端点 | 用真生成的 VAPID 密钥 + 真加密载荷，POST `https://web.push.apple.com/<随机 token>` | **通过**：返回 `400 {"reason":"BadWebPushToken"}` 且带 `apns-id` —— 说明 **Apple 验签通过了我们的 VAPID JWT**、接受了 `aes128gcm`，只是那个 device token 不存在（预期） |

结论：**继续做阶段三**。

残余未验证项（如实记录）：本机网络到 Cloudflare 边缘的预览会话不通（`wrangler dev --remote` 超时），所以「Cloudflare 边缘出网到 Apple」这一步没能在边缘实测。判断依据：Apple 端点从家庭网络（在墙内）都能直连，且 Workers 出网到公网 443 属常规能力，另有多个生产案例（Astro + Cloudflare Workers/D1 自实现 Web Push 并已真机验证 iOS PWA）。最终答案会在 AC-11 的真机测试里给出。

### 阶段三 3.1 / 3.2：已实现

后端：

- `migrations/2026-09-13-push.sql`：`push_subscriptions`，`endpoint` 全局唯一
- `utils/webpush.js`：RFC 8291（aes128gcm）+ RFC 8292（VAPID），纯 WebCrypto，不依赖 npm 包
- `utils/push.js`：`pushToRemindAudience()` —— 收件人走 `utils/audience.js` 的 `resolveRemindUsers()`（与列表同一口径，含 `class:exclude`），发布者本人不发，发送在 `ctx.waitUntil` 内，端点 404/410 立即删行
- `models/pushSubscriptionModel.js`：`ON CONFLICT(endpoint) DO UPDATE` 实现「同一设备换账号即改绑」
- 接口：`GET /api/push/config`、`POST /api/push/subscribe`、`POST /api/push/unsubscribe`、`POST /api/push/test`（只发本机，用于真机自检）
- 触发点：`handleCreateNotice`、`handleCreateActivity`、`handleCreateForm`；表单联动通知时只推一条，避免同一件事收到两条
- `middleware/auth.js`：`withAuth` / `withPermission` 把 `ctx` 作为第 4 个参数透传给 handler

前端：

- `sw.js` 加 `push`（**无条件立刻 `showNotification`**，载荷坏了也弹兜底）与 `notificationclick`（同源窗口导航 + 聚焦，否则新开）
- `account.html` 新增「通知」卡片，做**能力判定 + 降级**：
  - iOS < 16.4 → 直接说明「系统版本过低，收不到推送」，放弃推送这一项，其余功能不受影响
  - iOS ≥ 16.4 但没加到主屏 → 给「分享 → 添加到主屏幕」引导，不给必然失败的权限按钮
  - 有 `PushManager` 且已装主屏 / 支持的安卓浏览器 → 「开启通知」，权限申请放在点击手势内最前面
  - 服务端未配 VAPID → 直接说明，不显示死按钮

### 验证

- `npm test` **67/67 通过**（新增 `push.test.js` 19 条 + `pwa.test.js` 推送 5 条）
- 其中加密层另有一道**独立实现**的交叉校验：用 Node 内置 crypto（OpenSSL 的 HKDF + AES-GCM）按浏览器侧解密我们自实现的载荷
- 本地 D1 真实执行迁移成功（表 + 索引均在），`wrangler pages dev` 编译通过
- 带真实登录态的本地端到端 **10/10 通过**：配置读取 → 订阅落库 → `subscribed` 翻转 → 同一 endpoint 换账号 → 测试推送 → 退订 → 非法参数被拒
- AC-14 直接查库确认：同一 endpoint 换账号订阅后表里只有一行且 `user_id` 已改绑到新账号

### 生产环境配置（已完成）

- VAPID 密钥对已生成并写入 Pages Secrets（项目 `class-assistant` 的 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`；私钥未落仓库、未打印，`VAPID_SUBJECT` 用的是 `mailto:<你的邮箱>`，需要改随时可换）
- 远程 D1 已执行 `2026-09-13-push.sql`，`push_subscriptions` 表与 `idx_push_subs_user` 索引已确认存在

### 上线后发现并修复：CDN 覆盖了 `_headers`

上生产后实测发现，本域名的 CDN 会把「默认可缓存扩展名」（`.js` / `.css` / `.png`）的 `Cache-Control` 改写掉：

| 路径 | `_headers` 写的 | 线上实际 |
|---|---|---|
| `/sw.js` | `no-cache` | `max-age=14400` |
| `/assets/*` | `public, max-age=0, must-revalidate` | `public, max-age=14400, must-revalidate` |
| `/manifest.json`、`/*.html`、`/` | — | 原样生效（`.json` / `.html` 不在那类扩展名里） |

推测是该域名的 **Browser Cache TTL = 4 小时**。后果：HTML 每次校验拿到的都是新的，但 `/assets/*` 最多可能旧 4 小时 →「新页面结构 + 旧样式」。**这是本次改动之前就存在的**（老的 `/assets/*` 规则同样被改写），不是新增问题。

选择「不动 CDN 设置，在代码层解决」：

- `sw.js` 的 fetch 改成 `fetch(request, { cache: 'no-cache' })`，强制回源校验（未变即 304，代价很小），让 network-first 名副其实
- `app.js` 注册 SW 时加 `updateViaCache: 'none'`，`sw.js` 脚本本身也不吃 HTTP 缓存

边界（如实记录）：首次访问、SW 还没接管的用户仍受 CDN 的 4 小时影响；要彻底解决得把该域名的 Browser Cache TTL 改为 Respect Existing Headers。

### 后续调整（产品要求）

- **安装入口只给 iOS 与 PC**：安卓与鸿蒙都已有原生 App，再推网页版安装只会让人困惑。判定在 `app.js` 的 `shouldOfferInstall()`：壳内不给（两个 App 注入的是同名 `CAHost` 桥）、已装（standalone）不给、iOS 给，其余只有认得出是 PC 桌面浏览器才给（认不出的移动端一律当移动端）。已用 10 组 UA 在沙箱里跑**真实 app.js 源码**验证，并固化成测试。
- **安装引导从主页横幅移到个人页卡片**：主页不再挂横幅，入口收进 `account.html` 的「安装到桌面」卡片；随之删掉「不再提示」的 localStorage 逻辑与 `.install-hint-*` 样式。个人页跑在 iframe 里、而 `beforeinstallprompt` 只在顶层窗口触发，所以安装事件统一存在顶层窗口上、卡片从顶层取。
- 顺带堵掉一处误导：原生壳里网页 Push API 点不通，通知卡片原先会显示「此浏览器不支持通知」，现在直接说明「当前在 App 内，通知由 App 直接推送」，不给必然失败的按钮。
- **修掉「装好了还推安装」**：个人页跑在 iframe 里，iframe 自己问 `display-mode` / `navigator.standalone` 并不反映顶层状态（装好的 App 里点开个人页仍被判成未安装，于是又推一次）。改成以顶层窗口为准，并且放宽到 `standalone` / `minimal-ui` / `fullscreen` / `window-controls-overlay` 与 iOS 的 `navigator.standalone` —— 只要不是 `browser` 就算已在应用里。同一个坑也影响通知卡片（装好的 PWA 里会显示「还没添加到主屏幕」），一并修好。
  验证做了红绿两步：把 `isStandaloneMode()` 换回旧实现后，新增的两条 iframe 用例确实失败（`# fail 2`），换回新实现即全绿。

### 上线前仍要做

1. 合并部署后真机复核 AC-2、AC-3、AC-6~AC-9、AC-10~AC-13、AC-15~AC-17
2. 仍需向班级确认：那几位 iPhone 同学的系统版本是否都 ≥ 16.4（低于则按上面的降级路径处理）

