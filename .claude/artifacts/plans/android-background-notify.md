# 安卓端后台常驻接收通知 · 实施方案

- 状态：已评审，实施中
- 日期：2026-09-14
- 前置决策（已与项目主确认）：**走「系统限制 + 前台服务」两条腿，不做推送通道**；轮询 3 分钟；常驻通知设最低重要级且点击回通知页；服务**一直挂着**（不随前后台切换）；个人中心给「后台常驻」开关

---

## 一、需求与目标

现状：App 被杀掉、或手机放着不动一段时间之后，收不到通知。目标是让**消息到达与 App 是否在前台无关**。

现状下的两个来源要分开看，病因不同：

| 来源 | 机制 | 为什么现在会漏 |
|---|---|---|
| **到点提醒**（活动开始前 30 分钟、上课前 N 分钟） | `AlarmManager.setWindow(RTC_WAKEUP)`，系统到点拉起进程投递广播 | 本该与 App 状态无关。漏了就是被系统/ROM 掐了（后台限制、自启动未放行） |
| **内容提醒**（有人发了新通知 / 新活动 / 待填表单） | `SyncWorker` 每 15 分钟轮询一次，比对基线后弹通知 | **必须有人去拉**。进程没了就没人拉；进 Doze 后 15 分钟会被推迟到维护窗口（可能几小时） |

这也是「只有刚用过 App 的时候才收得到」的成因：刚用过 → 应用在 ACTIVE 桶、WorkManager 跑得勤；放着不动 → Doze 把网络和任务一起压住。

### 明确不做

- **推送通道（FCM / MiPush）**：FCM 是唯一能穿透 Doze 的东西，但国内网络下长连接经常不通，推送一旦静默失效极难排查；分发环境也不保证每台机器都有可用的 GMS。**留作将来的备选，本轮不做**。
- **鸿蒙端**：本轮不动。
- **升 `targetSdk`**：保持 34。升到 35+ 会带来 edge-to-edge 等一批行为变更（WebView 布局要跟着改），而下面第 6 节的类型选择已经把我们在意的限制绕开了，没必要蹚。

### 已接受的代价（必须让用户知道）

- 状态栏会**有一条常驻通知**。Android 不允许真正「静默」的前台服务 —— 最低重要级只是让它不响、不弹、不进锁屏，那一行还在。
- **从最近任务划掉 App**，应用进入 stopped 状态，前台服务会被杀、开机广播也收不到，**必须再打开一次 App** 才能恢复。这条绕不过去。
- 首次安装后从没打开过 → 收不到 `BOOT_COMPLETED`，什么都起不来。

---

## 二、为什么是「前台服务」而不是推送（ADR）

### 决策驱动

| 驱动 | 权重 | 说明 |
|---|---|---|
| 及时性 | 高 | 通知是本项目核心价值 |
| 可维护性 | 高 | 无外部依赖、无厂商账号、无密钥分发 |
| 跨设备一致性 | 高 | 用户手机版本与 ROM 各不相同，方案不能绑在某一家 |
| 耗电与后端成本 | 中 | 轮询间隔要能算得清 |
| 省电策略兼容 | 高 | 必须在 Doze 下仍然可用 |

### 已排除的方案

| 方案 | 排除理由 |
|---|---|
| FCM | 国内网络下长连接常不通，且失败是静默的；需要 Firebase 项目 + 服务账号密钥 + CI 注入 |
| 小米推送 | 系统级最可靠，但只覆盖小米设备，且要开发者账号；班里机型不统一 |
| 多厂商推送聚合 | 工程量与账号成本远超收益 |
| Web Push 复用现有通道 | WebView 里的 Service Worker 在 App 进程死后不运行，拿不到推送；除非改用「装 PWA 到桌面」那套（已有 iOS 方案），那是另一条产品线 |
| 只靠 `WorkManager` 加密轮询 | 周期任务下限就是 15 分钟（见下），Doze 下更慢 —— 这正是现在的问题 |
| `START_STICKY` 硬扛 | 只对「进程被内存回收」有效；ROM 的「一键清理」是强停，救不回来。照写但不依赖 |

### 决定性事实

1. **AOSP 能给的后台定时下限就是 15 分钟** —— `JobScheduler` 与 `WorkManager` 一致。所以在原生世界里，「比 15 分钟更及时」只有两个出口：**前台服务**或**推送**。这是本方案选前台服务的根本原因。
2. **Doze 会挂起网络访问**（Light Doze 就开始，Deep Doze 连射频都关），而**前台服务抵抗不了 Doze** —— 免电池优化白名单才是唯一确定的豁免。所以「前台服务」与「系统限制」两条腿必须一起走，缺一条在手机放着不动时都没用。

### 结论

前台服务（买「进程活着」）+ 系统限制放行（买「Doze 下能联网」）+ 平台调度原语兜底（保证任何一层挂了功能只会变慢、不会消失）。

---

## 三、设计原则（跨版本、跨 ROM）

用户手机的系统版本与 ROM 各不相同，所以方案按这四条来定：

1. **判断只看 AOSP 公开 API；厂商差异只影响「引导入口」，绝不影响「判断逻辑」。**
   这样「如实显示」的部分是全设备一致的；厂商那一层永远只是「给一个方便入口」，不是功能的依赖项。
2. **版本分支要覆盖 minSdk 24 → 36，不是只覆盖某一台设备。** 见第 5 节的版本矩阵。
3. **不赌「服务能活」，可靠性分层。** 用平台给的调度原语逐层降级，任一层失效功能不消失。
4. **厂商入口做成一张表 + 兜底，文案不写死菜单名。** 各家把它藏在哪、叫什么名字都不同，硬写菜单名隔几个月就过期。

---

## 四、A：系统限制

### 能读 / 不能读

| 想知道 | 原生读法 | 能用性 |
|---|---|---|
| 是否免电池优化 | `PowerManager.isIgnoringBatteryOptimizations()` | 全版本公开 API，有明确后果 —— **主要依据** |
| 是否被系统压制 | `UsageStatsManager.getAppStandbyBucket()`（API 28+） | 公开 API。RARE / RESTRICTED 会压 job 与闹钟，这是**跨 ROM 通用**的解释力 |
| 前台服务是否在跑 | 服务自己维护静态标记 + `onDestroy` 清掉 | 比 `getRunningServices`（已废弃且受限）可靠，全版本一致 |
| 后台运行 op | `AppOpsManager.checkOpNoThrow("android:run_in_background", …)`（用字面量，不碰隐藏常量） | **best-effort**：存在就读，读不到当未知，不作为判断依据 |
| 厂商「自启动」 | **没有标准 API** | 如实写「这一项我们读不到」，只给入口 |

### 做法

- 申请 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`，弹系统标准窗让用户点「允许」。
- 个人中心加「后台通知」卡片：如实显示上面能读到的三项 + 一个「去允许」按钮。
- 厂商入口：先跳 AOSP 标准的电池优化页（所有设备都有意义），再按 ROM 给厂商页（小米 / 华为 / OPPO / vivo / 魅族 / 三星… 逐个 try），全失败退到应用详情页。文案只说「找到『自启动 / 后台运行 / 无限制』这类开关」。

> 一个反面教材：我最初是拿一台 HyperOS 机器上的 `cmd appops get` 输出（只 grep 了 `AUTO_START|auto`）就下结论「自启动读不到」。补测后 `RUN_IN_BACKGROUND` / `RUN_ANY_IN_BACKGROUND` 两个 op 都在，默认 allow。**结论不该由一台机器得出。**

---

## 五、B：前台服务

### 版本矩阵

manifest 声明 `foregroundServiceType="dataSync|specialUse"`（`specialUse` 的值只在 API 34+ 存在，低版本解析成未知位无害），运行时按 `SDK_INT` 分支，统一走 `ServiceCompat.startForeground`：

| SDK | 传的类型 | 说明 |
|---|---|---|
| ≥ 34 | `FOREGROUND_SERVICE_TYPE_SPECIAL_USE` | 无时长上限；将来升 `targetSdk` 也不会被「BOOT_COMPLETED 禁启」名单命中 |
| 29–33 | `FOREGROUND_SERVICE_TYPE_DATA_SYNC` | 该值自 API 29 起存在。此时还没有 6 小时上限（那条只对 `targetSdk` ≥ 35 生效） |
| < 29 | 不传类型 | 那时还没有「必须声明类型」的要求 |

### 为什么不选 `dataSync`

- `targetSdk` ≥ 35 时，`dataSync` **24 小时内累计只能跑 6 小时**，超时系统回调 `onTimeout` 强制停 —— 与「常驻」直接冲突。
- `targetSdk` ≥ 35 时，`BOOT_COMPLETED` 接收器**不能**启动 `dataSync` / `camera` / `mediaPlayback` / `phoneCall` / `mediaProjection` / `microphone` 这 6 种。`specialUse` **不在名单里**，所以「开机自己起来」只有它能走。

### 设计要点

- **服务内直接跑同步**，不转手丢给 WorkManager —— Android 16（**不看 targetSdk**）规定「从前台服务里启动的后台任务要受各自配额限制」。
- 把 `SyncWorker.doWork()` 的身体抽成 `SyncRunner.run(ctx)`，Worker 与服务共用。**必须复用「首轮只记基线、不补推历史」那套** —— 3 分钟一轮如果不复用，会把一屏旧通知全弹出来。
- `START_STICKY`；`MainActivity` 启动时挂上；`BOOT_COMPLETED` 与 `MY_PACKAGE_REPLACED` 里也挂一次（这两条是「后台启动前台服务」的合法豁免项）。
- 通知单独一条渠道、`IMPORTANCE_MIN`、点击回 `?view=notices`（复用现有深链机制）。
- 个人中心给「后台常驻」开关：关掉 → 停前台服务，退回纯 15 分钟轮询。

### 可靠性分层

| 层 | 机制 | 受谁影响 | 这一层挂了会怎样 |
|---|---|---|---|
| L1 | `AlarmManager` 到点提醒 | 系统闹钟策略 | 功能不消失，最坏晚到 |
| L2 | 前台服务 3 分钟轮询 | 任何 ROM 都可能杀 | 退到 L3 |
| L3 | `WorkManager` 15 分钟 | Doze 推迟、待机桶 | 退到「下次打开 App 时同步」 |

---

## 六、Pre-mortem：这个方案可能怎么失败

| 失败形态 | 判断依据 | 处置 |
|---|---|---|
| 用户划掉任务卡片后再也没通知 | MIUI 等把应用置为 stopped | 已知边界，只能靠用户再打开一次；文案里说清 |
| 关屏静置后网络仍被挂起 | Doze 生效而白名单没开 | 卡片里如实显示「未免电池优化」并引导；验收第 4 步专门测这个 |
| 开机后服务没起来 | 自启动未放行 / 首次安装未打开过 | 卡片里给入口；验收第 3 步测 |
| 3 分钟一轮把后端打满 | Cloudflare Workers 免费额度 10 万请求/天 | 一个班几十人 × 每人每天约 900 次仍在额度内；实现时服务端不动 |
| 用户嫌那条常驻通知碍眼 | —— | 已给开关；并在文案里说明这是系统要求，不是我们想留 |
| 重复弹通知 | 高频轮询没复用基线逻辑 | 复用 `SyncRunner`，并把基线判定补单测 |

---

## 七、验收

1. `dumpsys activity services` 看到服务在跑，通知栏有一条（点它跳通知页）
2. 划掉任务卡片 → 等 10 分钟 → **大概率被杀掉**，记录现象（这是 ROM 边界，不是 bug）
3. 重启手机 → 服务自动挂上（验开机豁免 + 自启动放行）
4. 关屏静置 1 小时，期间**让同学发一条真实通知** → 看几分钟内是否弹出（最真实的一条验收）
5. 个人中心开关关掉 → 服务停止、通知消失；打开 → 重新挂上

---

## 八、实施清单

- [x] 本方案
- [x] `SyncRunner`（从 `SyncWorker` 抽出），`SyncWorker` 变薄壳
- [x] `Notifier`：常驻通知渠道 + 服务通知
- [x] `BackgroundSyncService`：前台服务 + 3 分钟轮询 + `START_STICKY`
- [x] `BackgroundMode`：开关读写、服务启停（App 启动 / 登录态变化 / 开机 / 覆盖安装）
- [x] `Store`：常驻开关
- [x] `AndroidManifest`：权限与 service 声明
- [x] `HostBridge`：状态读取与操作（电池优化 / 待机桶 / 服务在跑 / 跳设置 / 开关）
- [x] Web：个人中心「后台通知」卡片
- [x] 单测 + 构建
- [x] 真机验证（CI 出正式签名 0.2.4 覆盖升级，结果见第九节）
- [x] 深 Doze 兜底闹钟（`SyncAlarmReceiver`，真机验出来的缺口）
- [x] README

---

## 九、实施记录（2026-09-14）

### 交付

| 文件 | 变更 |
|---|---|
| `sync/SyncRunner.kt` | 新增。从 `SyncWorker` 抽出的同步逻辑 + `pickFresh` 判定 + `logOutSession` / `pushTestNotification` |
| `sync/SyncWorker.kt` | 变薄壳，只把 `SyncRunner` 的结果翻译成 WorkManager 的说法 |
| `sync/BackgroundSyncService.kt` | 新增。前台服务，3 分钟一轮（`deep = false`），`START_STICKY` |
| `sync/BackgroundMode.kt` | 新增。开关、启停、免电池优化与待机档读取、厂商入口表、深 Doze 兜底闹钟 |
| `sync/SyncAlarmReceiver.kt` | 新增。深 Doze 兜底：被闹钟叫醒时跑一轮（只在 `isDeviceIdleMode` 时真干活） |
| `notify/Notifier.kt` | 新增 `CHANNEL_BACKGROUND`（`IMPORTANCE_MIN`）+ `ongoingNotification()` |
| `data/Store.kt` | 新增 `backgroundAlwaysOn`（默认开，不随退出登录清） |
| `MainActivity.kt` | 桥方法 ×5（状态 / 开关 / 申请免电池优化 / 电池设置 / 自启动设置）+ 设置页跳转助手 |
| `AndroidManifest.xml` | 4 个权限 + `BackgroundSyncService`（`dataSync\|specialUse` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`） |
| `BootReceiver` / `WidgetRefreshReceiver` | 开机、覆盖安装时重新挂上服务 |
| `web/account.html` | 「后台通知」卡片（仅 App 壳）：开关 + 三项状态 + 两个按钮 + 如实说明 |
| `SyncRunnerTest.kt` | 新增 7 条基线判定用例（安卓单测合计 27 条） |

### 与方案的偏离（2 处，都是实施时算出来的）

1. **服务那一轮只拉核心 3 个接口**（`SyncRunner.run(deep = false)`）。
   方案只写了「3 分钟一轮」，实施时核了一下请求量：完整一轮是 8 个接口（3 个主流程 + 5 个离线预热），
   3 分钟一轮 = 每人每天约 3840 次；一个班几十号人就能把 Cloudflare 免费额度（10 万次/天）啃穿，
   而额度一破是**所有人一起用不了**。拆开之后是每人每天约 1440 次，预热那 5 个仍归 15 分钟的周期任务
   —— 反正那一路本来就在跑，而且进程活着反而让它更准时。
2. **基线判定抽成了纯函数 `pickFresh`**，两个提醒入口（通知 / 待填表单）共用。
   方案里只写「补单测」，但原实现散在两处、各自直接读写存储，不抽出来根本测不了。

### 实施中补的两处防御（方案未预见）

- `BackgroundMode.start()` 吞掉 `startForegroundService` 的异常。它在 `BootReceiver` / `WidgetRefreshReceiver`
  里被调用，抛出去就是**后台崩溃**；而最坏的结果其实只是「没挂上常驻」，15 分钟的周期任务还在。
- `BackgroundSyncService.startInForeground()` 失败就 `stopSelf()` 并返回 `START_NOT_STICKY`。
  硬撑下去会在 5 秒后被判 `ForegroundServiceDidNotStartInTimeException`（应用级崩溃），
  而这条路径的触发条件（类型声明不被某个系统接受、通知权限、后台启动限制）恰恰是我们无法逐一测到的。

### 验证

- 安卓单测 **27/27**（`SyncRunnerTest` 7 + `CourseScheduleTest` 17 + `OfflineCacheTest` 3），`assembleDebug`、`lintDebug` 通过
- Web 单测 **86/86**
- 真机（Redmi 24117RK2CC / Android 16 / HyperOS V816）装 CI 出的正式签名 0.2.4（`adb install -r` 覆盖升级，登录态保留）：

| 验收项 | 结果 |
|---|---|
| 服务挂起来 | ✅ `dumpsys` 里 `isForeground=true foregroundId=300000 types=0x40000000` —— **类型正是 `specialUse`**，版本分支选对了 |
| 常驻通知 | ✅ `foregroundNoti=Notification(channel=background_running flags=ONGOING_EVENT\|NO_CLEAR\|FOREGROUND_SERVICE)`，通知栏可见、静默、点它进 App |
| 3 分钟节奏 | ✅ 连续三轮 03:03:04 → 03:06:06 → 03:09:09（间隔 182 / 183 秒） |
| 个人中心卡片 | ✅ 三项状态如实：「运行中；还没允许后台运行 —— 手机放着不动时系统会掐掉网络；系统把它当「活跃应用」」 |
| 开关 | ✅ 关掉 → 服务与通知一起消失；再打开 → 服务回来 |
| 厂商入口 | ✅ 在这台机器上真的跳到了 `com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity`（表里第一条就命中了） |
| **深 Doze** | ❌ **一轮都没有**（此时还没有兜底闹钟）。`dumpsys deviceidle force-idle` 后 `mState=IDLE`，服务记录仍在（没被杀），但计时器不跑；`unforce` + 唤醒后立刻补上一轮 |

### 深 Doze 那条是这次验证最有价值的发现

原因不神秘：**深 Doze 会把 CPU 一起挂起**，Java 的 `ScheduledExecutorService` 定时器是进程内的，没有任何办法把 CPU 叫醒 —— 它只能等下一次醒来继续。
所以现实里的表现分两段：

- 屏幕亮着、或手机在动（走路时不会进深 Doze）→ 3 分钟一轮正常
- 手机搁在桌上不动、进了深 Doze → 轮询冻住，且**没进白名单的话连网络都不通**，那时任何机制都拉不到数据。用户拿起手机的那一刻，Doze 结束、立刻补上一轮

这正好从实证角度支持了第 6 节「A 与 B 必须配套」那条结论，而且暴露出**当前实现还缺一块**：
即便用户开了免电池优化白名单（网络通了），只要 CPU 睡着，进程内的定时器还是不会跑。
要让「手机放在桌上也能在几分钟内收到」，还差一个**能唤醒 CPU 的原生闹钟**。

### 补齐：深 Doze 兜底闹钟（同日实现）

`sync/SyncAlarmReceiver.kt` + `BackgroundMode.scheduleDozeWake`：

- `AlarmManager.setAndAllowWhileIdle`，间隔 9 分钟。Doze 下允许触发、但被系统限流到约 9 分钟一次，
  所以**深 Doze 里最快就是 9 分钟**，做不到前台服务那 3 分钟。
- 用不精确的那种而不是 `setExactAndAllowWhileIdle`：精确闹钟在 Android 12+ 要单独申请
  「闹钟与提醒」特殊权限（默认拒绝），为一条后台同步把用户拉去授权页不值得；而且 Doze 下两种都被限流，精确也快不了。
- 接收器里**先判断 `PowerManager.isDeviceIdleMode`**：不在深 Doze 就直接返回。
  定时器那时是准的，闹钟再插一脚纯属白耗请求 —— 这条判断让这个机制在 Doze 外几乎零成本。
- 接收器直接跑同步（`goAsync()` + 后台线程），**不去拉前台服务**：
  Android 12+ 禁止从后台启动前台服务，而不精确的闹钟不在豁免名单里（只有精确闹钟才算），拉服务会被拒。
- 闹钟由服务启动时起头，之后每轮自己续上；关掉开关时连同服务一起撤销。
- 另给 `SyncRunner.run` 加了一次性闸门（`AtomicBoolean`）：两条触发链撞上时直接跳过，
  免得白跑一轮请求、基线还被两边各写一次。

于是「手机放着不动」这条链变成：**白名单（用户点一下，网络）+ 闹钟（代码，CPU）**，缺一条都不行。

### 第二轮机验（0.2.5）

装 0.2.5（同一套 CI 流程）后分两块验：

**① 端到端：新通知真的会弹出来 —— 通过**

用 `wrangler d1 execute --remote --file=...` 往生产库插一条**只点名本人**的测试通知（验完即删，别人的列表里看不到），
然后什么都不做，等应用自己发现它：

| 时刻 | 事件 |
|---|---|
| 04:05:39 | 插入通知（`publish_time = datetime('now')`，`remind_people = '["刘科江"]'`） |
| 04:10:19 之前 | 通知栏出现它：`pkg=com.classassistant.app id=100007 channel=class_notice_v2 importance=4 flags=AUTO_CANCEL` |

`id=100007` 正是 `NOTICE_ID_BASE + 7`，`importance=4` 是 HIGH（会弹横幅），渠道也对。
**3 分钟那一轮真的发现了新内容并弹了出来**，`pickFresh` 那套基线判定在真机上也对。

> 中间差点误判成 bug：先插的第 6 条一直没弹。实际是我随后跑了一次 `am force-stop` ——
> **强停应用会连它的通知一起清掉**，第 6 条其实弹过了。这一条值得记着，以后别自己制造假故障。

**② 深 Doze 的闹钟 —— 部分通过，还有一个没查清的疑点**

| 场景 | 结果 |
|---|---|
| 不在 Doze（屏幕亮着） | ✅ 闹钟到点投递成功，日志有「闹钟到了，但设备不在深 Doze」，接收器按预期跳过（定时器此刻是准的） |
| `force-idle` 深 Doze | ⚠️ **闹钟排上了、到点却凭空消失**：没有接收器日志、没有续排、`dumpsys alarm` 里也没了；全程开着 `adb logcat *:V` 落盘，**没有任何一行 AlarmManager 提到我们这个包**，Alarm Stats 里也没有我们的 uid —— 说明它不是在投递时失败，而像是被撤掉了 |

同一条 `setAndAllowWhileIdle` 在 Doze 外能投递、在 `force-idle` 下消失，所以**先怀疑是 `force-idle` 这个人为状态的特殊性**
（它是 adb 强制的 IDLE，和自然进 Doze 未必等价），但**没有证据**，不能就这么下结论。

因此补了两处（都已提交，等下一轮验）：
- 接收器入口**无条件**打一行日志（`闹钟到了：action=… 深Doze=…`）。原来只在「不在 Doze」那一支有日志，
  于是「投递了但什么都没干」和「压根没投递」在日志里长得一模一样 —— 这次就吃了这个亏。
- `scheduleDozeWake` 从 `if (!loopStarted)` 里挪出来，**每次 `onStartCommand` 都续排一次**。
  原来只在服务首次启动时排一次，闹钟一旦被系统撤掉就再也没人补上。

下一步要确认的：让设备**自然**进入 Doze（不 `force-idle`，即关屏静置半小时以上）再看一次闹钟投递；
若仍然消失，就得换机制 —— 候选是 `setExactAndAllowWhileIdle`（要引导用户开「闹钟与提醒」特殊权限），
或者干脆承认「深 Doze 期间不保证」，把力气花在「用户拿起手机那一刻立刻补上」这条已经成立的路径上。

### 发布

- **v0.2.6**（`versionCode 206`，tag 指向 `16656ee`）：APK
  `https://github.com/AJiang233/Class-Assistant/releases/download/v0.2.6/ClassAssistant-0.2.6.apk`
- `web/version.json` 的 `android` 段已同步指向它（否则「个人中心 → 关于软件 → 检查更新」读不到）
- release 说明里**如实写了已知问题**（深 Doze 未查清、划掉任务卡片会失效、自启动状态读不到、到点提醒不受影响），
  口径是「让同学知道遇到什么该反馈」，不是宣传
- 0.2.4 / 0.2.5 是内部验证构建（未发布），所以对外是从 0.2.3 直接到 0.2.6
- 顺带产出一份给鸿蒙协作者的交接文档：`HarmonyOS/ANDROID-PARITY.md`





