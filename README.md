# Class Assistant —— 基于 AI Agent 的班级助理

一个面向「班长」角色的 AI 助理系统：把转发通知、活动提醒、同学答疑、材料催收等机械化的班级事务，逐步交给 AI 与自动化流程完成。

目前状态：**Web 门户与安卓端、鸿蒙端已可用**（账号体系 / 通知与活动管理 / 移动端适配 / 系统日历订阅 / 安卓与鸿蒙的本地提醒、桌面小组件），并已完成一轮安全加固；Go 常驻调度进程已跑通封存自检骨架，Agent / 爬虫 / 知识库等模块在逐步建设中。

## 项目背景

班长的大量日常工作是结构化、可自动化的重复劳动。本项目通过「本地服务器 + Agent 编排 + RAG 知识库 + Web 门户」的组合，让 Agent 承担通知流转、日程提醒与常见问题答疑，既为同学提供更好的服务，也作为个人全栈与 Agent 开发的实践项目。

## 功能规划

- 通知抓取与归档：轮询班级工作群，拉取新通知并结构化归档（规划中）
- 智能转发：根据通知内容判断是否需要转发到班级群，并支持人工复核（规划中）
- 知识库问答：爬取学生手册、教务处文件等归档进 RAG，群内 @ 助手即可答疑（规划中）
- 日程与提醒：✅ 已落地两条路径 —— 系统日历订阅（全平台通用）、安卓 / 鸿蒙本地到点提醒
- 个性化门户：✅ Cloudflare 网站 + 账号体系，按职位/角色展示内容与权限
- 教务数据同步：✅ 同步个人课表与学业达成（学分看板）；绑定支持 App 一键、学号密码代登录、手动粘贴 Cookie 三条路径
- 移动端：✅ 安卓原生套壳（WebView + 本地提醒 + 桌面小组件）、鸿蒙原生套壳（ArkWeb + 系统提醒 + 服务卡片）；iOS 通过 Web + 系统日历订阅覆盖

## 技术架构

| 模块 | 技术选型 |
| --- | --- |
| 门户网站（已完成） | Cloudflare Pages（静态前端 + Functions 后端 + D1 数据库） |
| 鉴权 / 权限 | JWT（HS256）+ PBKDF2 密码哈希；按职位 + 自定义职位分级权限 |
| 测试 | Web：Node 原生 `node --test`（`web/backend/test/`）；Go：标准库 `testing`（`internal/` 下各包单测）；移动端暂无自动化测试（安卓改动靠 CI 构建校验，鸿蒙需用 DevEco 手动构建） |
| 移动端 — 安卓（已完成） | Kotlin + WebView 套壳，WorkManager 定期同步 + AlarmManager 到点提醒 + AppWidget 桌面小组件 |
| 移动端 — 鸿蒙（已完成） | ArkTS + ArkWeb 套壳，workScheduler 周期同步 + reminderAgentManager 到点提醒 + 服务卡片（Form） |
| 多端提醒（已完成） | 日历订阅 `.ics`（iOS / 鸿蒙 / Android / 桌面通用，无需安装 App） |
| 常驻调度（骨架已跑通） | Go 1.22 进程（`cmd/scheduler` + `internal/`）：与 Worker 共用 Cookie 封存 / 学号比对 / 职位白名单 / 限流规则 |
| Agent 编排 | OpenClaw（规划中） |
| 消息通道 | 微信本地 API（企业微信 / 个人微信方案待定） |
| 知识库 | 向量数据库 + RAG（规划中） |
| 本地模型 | 轻量模型（OCR / 上下文压缩 / 查询，规划中） |

## 目录结构

```
class-assistant/
├── agent/          # Agent 编排与提示词（规划中）
├── crawler/        # 通知抓取（复用根模块 internal，尚未接真实群）
├── rag/            # 向量化与检索（规划中）
├── scheduler/      # 调度进程说明（代码在 cmd/scheduler + internal）
├── cmd/scheduler/  # 调度进程入口（run / once / vault-seal / vault-open / student-id）
├── internal/       # 与 Worker 对齐的 Go 规则（vault / identity / roles / ratelimit）
├── go.mod          # Go 模块（go 1.22，模块路径 github.com/AJiang233/Class-Assistant）
├── web/            # Cloudflare Pages 门户（前端 + Functions 后端 + D1，已上线）
├── android/        # 安卓端（Kotlin，WebView + 本地提醒 + 桌面小组件）
└── HarmonyOS/      # 鸿蒙端（ArkTS，ArkWeb + 系统提醒 + 服务卡片）
```

## 当前状态

### Web 门户（`web/`，已上线 `class.qxwkstudio.top`）

- **账号与权限**：学号 + 密码登录（PBKDF2 加盐哈希）、JWT 鉴权；班长/团支书/学习委员等预设职位 + 自定义职位权限，支持一人多职位（权限取并集）；成员管理、修改密码、个人资料（联系方式）自助修改
- **内容管理**：通知与活动的发布 / 编辑 / 删除（统一弹窗表单）、通知过期自动隐藏与归档查看、提醒对象选择（支持按职位一键全选，如「通知所有团员」）
- **界面体验**：液态玻璃设计（浅色 / 深色双主题）、响应式布局（小屏隐藏侧栏、改为底部导航，并针对手机做字号密度适配）、班级主页（日历 + 当日通知/活动 + 详情弹窗）、折叠式管理员面板（左栏发布内容 / 右栏管理成员）、个人中心（资料 / 偏好设置 / 日历订阅 / 安装到桌面 / 修改密码 / 退出登录）与「关于软件」卡片（版本号 / 检查更新 / 项目仓库 / 开发者）
- **日历订阅**：一键生成 `.ics` 订阅链接，可自定义「提前提醒时间 / 包含过去与未来的范围 / 是否包含班级通知」，并支持重置密钥
- **课表与学业**：绑定教务系统后展示个人课表（节次网格、当前周高亮）、未安排课程与学业达成学分看板；数据经后端代理抓取并缓存进 D1。绑定有三条路径：App 内一键绑定、学号 + 密码代登录（复刻金智 CAS，密码用完即弃）、手动粘贴 Cookie
- **安全加固**：登录 / 注册 / 改密统一校验密码长度（6–72 位）；系统预置职位（学生 / 班长 / 团支书 / 学习委员）不允许写入 `roles` 表（否则等于给全班提权），自定义职位只接受 `content:write` / `user:manage` 两个白名单权限点；教务绑定强制「教务学号 = 门户学号」；多因子验证码错满 5 次即作废本次中间态；教务会话 Cookie 与 MFA 中间态均 AES-GCM 封存
- **测试与迁移**：`cd web && npm test`（Node 原生 `node --test`，覆盖鉴权与权限边界）；表结构见 `schema.sql`，增量变更见 `migrations/`，脚本为 `npm run db:migrate` / `db:migrate:mfa`
- **离线**：页面壳由 Service Worker 缓存（`sw.js`，含预热的各页面与静态资源），断网也能打开；`/api/*` 刻意不走 Service Worker —— 数据与登录态必须走网络。App 里数据另有原生层兜底（见安卓端「离线可用」），浏览器里没有这一层，所以断网提示分两种文案（见 `web/README.md`）

### 安卓端（`android/`）

- WebView 套壳加载线上门户：登录态持久化、下拉刷新（仅在页面置顶时触发）、返回键回退；站内与教务域留在 WebView，其它外链（含 APK 下载）交给系统浏览器
- **系统栏配色**：状态栏 / 导航栏跟随网页底色（浅色 / 深色各自适配，图标明暗自动切换）
- **本地提醒**：WorkManager 每 15 分钟后台同步活动 / 通知 / 待填表单（15 分钟已是系统下限），回到前台时再同步一次 —— 距上次成功同步不足 60 秒就跳过，避免切来切去反复拉；AlarmManager 在活动开始前 30 分钟发通知（App 未打开也能收到）；同步到新通知、新表单时各提醒一条（首次同步只记基线，不把历史内容补推一遍），通知与活动提醒都只发给 `remind_people` 点名的对象（空 = 全班，名单里可写姓名或用户 id）—— 与网页列表的 `remindMe()`、服务端「推给谁」同一口径；只在活动那一支判一次的话，通知就会「没被点名也弹」，所以两处共用 `SyncWorker.isMine`。待填表单不用客户端再判：`/api/forms/mine` 服务端已按提醒对象滤过
- **通知渠道**：两条都是「重要」级别，系统会以横幅（浮动通知）弹出 —— 活动提醒是 `activity_reminder`，通知与表单待办是 `class_notice_v2`。**id 里的 v2 不能去掉**：渠道重要性只在创建时生效，之后应用只能下调、不能上调（用户手动改的更是永远优先），老的 `class_notice`（默认级别，不弹横幅）改不动，只能换新 id 重建；建完顺手把老渠道删掉，否则系统设置里会永远多一条不弹横幅的渠道，用户分不清该关哪条。用户在系统设置里仍可单独把某条渠道调成静音 —— 这是他的最终权利，代码不跟它抢
- **本机状态可在网页查**：个人中心经 JS 桥取「本机通知开没开 + 上次同步时间」——同步时间跟在资料卡的「更新时间」下面，通知开关留在「偏好设置」卡片里「App 端通知」的推送测试上面（整块仅 App 壳内显示，网页版没有桥就隐藏）；通知被系统关掉时，推送测试不再回「已推送」而是直接说明原因（否则用户对着通知栏找不到东西，只会以为推送坏了）
- **通知深链**：点提醒直达对应活动 / 通知详情，App 未打开（冷启动读启动 Intent）与已在运行（`onNewIntent`）都生效；表单在 App 里没有列表页，通知直接开网页填写页（`forms.html?id=`，与 Web Push 同一个落地页）
- **离线可用**：断网时课表、通知、活动照常能看。原生层在 `WebViewClient.shouldInterceptRequest` 里接管本站 `/api/` 的只读请求（`sync/OfflineApi.kt`）：在线时自己拉一份（用本机 token，不依赖 WebView 的请求头）、顺手按 URL 存一份（`data/OfflineCache.kt`），断网就把上次的响应原样回给页面。单条详情的请求（`/api/notices/{id}`）从缓存过的列表里按 id 拼回来 —— 后端列表项与详情返回的是同一行数据，所以字段一个不少，也不必为每条详情单独存文件（否则文件数随「点开过多少条」无限涨）。后台同步每轮还会照 `OfflineApi.PREWARM` 预热一遍**网页真正请求的那几个 URL**，于是离线数据的新鲜度跟着同步走，而不是「上次打开那个页面时」。两条边界：写操作（POST / PUT / DELETE）一律不接管，断网就该失败；服务端**答了**（401 / 500 / `success:false`）时原样透传、绝不退回缓存，否则「登录态失效了」会被一份旧数据盖住，页面既不会提示重新绑定，用户也看不出自己看的是哪天的东西。退出登录时随 `Store.clearSession` 一起清空（否则换账号后断网能翻到上一个账号的课表）
- **桌面小组件**：两个 —— 「今日活动」显示今天的班级活动；「课表」显示今天要上的课。课表组件今天还有课就显示今天（正在上的那节也算，已上完的整行变灰），今天的课上完了、或今天根本没课，就往前找**下一个真有课的日子**并在标题里标出来（「明日课程」/「周五 10-09 课程」）—— 跳过周末与单双周没课的日子，否则一到周末它就一片空白；没绑教务时说的是「还没同步到课表」而不是「今日无课」，这两种空态的区别写在 `CoursesWidgetProvider` 里
- **小组件换天**：两个组件的内容都按**设备本地日期**算，但原来的刷新时机只有「后台同步成功」与 `updatePeriodMillis`（系统夹到最少 30 分钟，Doze 下更久）：过了零点没人叫它们，桌面就一直挂着昨天那一屏。现在按本机零点排一个 `RTC` 闹钟（`AlarmManager.RTC` 不唤醒设备，睡着就等醒来再刷）专门刷新这两个组件，接收方刷完自己再排下一次；系统时间/时区变更、覆盖安装、打开 App 时各补一次。`DATE_CHANGED` 特意没有注册 —— 它不在系统的隐式广播豁免名单里，清单注册的接收器收不到，换天只能靠零点闹钟，理由写在 `WidgetRefreshReceiver` 的注释里
- **课程提醒**：按本地课表在上课前提醒，在「个人中心 → 偏好设置 → 课程提醒」里可设提前多久（不提醒 / 5~60 分钟，默认 15）与是否在开课时再提醒一次（默认开）。设置存在原生 SharedPreferences，网页只经 `CAHost` 读写，改完**立刻**重排闹钟、不用等下次后台同步（否则用户会以为没保存上）。闹钟只排未来 7 天、按「绝对日期 + 课程序号 + 类型」编号 —— 用「今天往后第几天」的话同一个闹钟每过一天就换号，天天被当成新闹钟取消重排；窗口给 1 分钟，比活动提醒的 5 分钟紧，上课时间是精确的。课程提醒单独一条通知渠道，可以和班级活动/通知分开静音
- **教务绑定**：门户内一键打开教务登录页（固定桌面 UA，规避教务系统的手机端兼容问题），登录后由原生读出会话 Cookie 上报后端。教务系统的登录页至今是 **http**（安卓端打开 `https://szjw.njau.edu.cn`，门户自己会跳到 `http://szjw.njau.edu.cn/login/login.html`），所以 `res/xml/network_security_config.xml` 里给教务链路上的三个主机单独开了明文，其余仍全禁（`base-config` = false）—— 不开就是 `net::ERR_CLEARTEXT_NOT_PERMITTED`。**逐个点名、别改成 `njau.edu.cn` 通配**（见 `MainActivity.inAppHosts` 同款取舍），每个 `<domain>` 还必须显式写 `includeSubdomains="false"`（与不写等价，只匹配主机本身；缺了它 lint 的 `NetworkSecurityConfig` 规则判 **Fatal**，`lintVitalRelease` 会让整个 release 构建失败），别改成 `true` —— 那等于把明文放行扩到这几个主机的全部子域；代价是这几个主机上的流量可能以明文传输，这是校方服务器只提供 http 造成的，客户端没法单方面改成 https
- 构建：`cd android && ./gradlew assembleDebug`（产物在 `app/build/outputs/apk/debug/`）
- 测试：`cd android && ./gradlew testDebugUnitTest` —— 覆盖课表的日期逻辑（开学第几周、下一个有课的日子、跨零点下课、闹钟编号）。这类代码算错了不会崩，只会悄悄显示错的那一天，所以说不出错不等于对。CI 在打包前跑这一步（`build-android.yml`），红了就不发版
- 签名：正式 keystore 不进仓库（`.gitignore` 挡了 `*.jks` / `*.keystore`），只以 base64 存在仓库 Secrets：`KEYSTORE_BASE64`（keystore 的 base64）、`KEYSTORE_PASSWORD`、`KEY_ALIAS`、`KEY_PASSWORD`；密钥与口令务必另行备份，丢了就只能改包名、让所有人重装一次
- 生成 keystore：`keytool -genkeypair -v -keystore release.jks -alias class-assistant -keyalg RSA -keysize 2048 -validity 10000`，再 `base64 -w0 release.jks`（PowerShell：`[Convert]::ToBase64String([IO.File]::ReadAllBytes("release.jks"))`）填进 `KEYSTORE_BASE64`
- 发版：CI（`build-android.yml`）注入 `version_name`、从 Secrets 还原 keystore 后产出已签名的 release 包；发布 Release 后需同步更新 `web/version.json` 的 `android` 段（版本号 + APK 稳定直链），否则个人中心「检查更新」读不到，维护细节见 `web/README.md` 的部署一节

### 鸿蒙端（`HarmonyOS/`）

- **套壳与登录态**：ArkWeb 组件加载线上门户；网页 localStorage 里的 token 由注入脚本经 JS 桥 `CAHost` 回传到本地首选项，网页里退出登录会同步清掉本地凭据、已排提醒与卡片缓存
- **外链**：站内与教务域留在 ArkWeb，其它 http(s) 外链（含 APK 下载）交给系统浏览器；教务登录期间一律不外跳（认证会跨主机，跳走就断了），系统协议（`tel` / `sms` / `mailto`）同样拦下不加载 —— 与安卓端 `shouldOverrideUrlLoading` 同一套判断
- **JS 桥**：`CAHost` 与安卓端对齐 —— `setPullRefreshReady` / `setToken` / `startAcademicLogin` / `setTheme`，外加 `platform()`（网页据此读 `version.json` 自己那段）、`appVersion()`、`appStatus()`（本机通知开关 + 上次同步时间，对应安卓端同名桥）、`testNotification()`；所有桥方法都先校验调用方是本应用页面，教务系统这类外部站点调不动，避免外部页面改本地 token 或触发教务绑定。其中 `testNotification()` 有个已知的有损点：桥必须同步返回而拉数据要发请求，所以它只能在「本地没有 token」和「通知权限没开」这两个分支同步回一句提示，其余结果一律返回空串、由网页显示兜底文案（安卓端的桥能同步阻塞，拿得到完整结果）
- **通知深链**：点提醒 / 通知直达对应活动、通知详情（`?view=activities&id=` / `?view=notices&id=`），App 未打开（冷启动读启动 `want`）与已在运行（`onNewWant`，对应安卓端 `onNewIntent`）都生效；表单没有壳内详情页，直接开网页填写页（`forms.html?id=`）；通知 id 与安卓端同规则 —— 表单用 `200000 + 表单 id`、通知用 `100000 + 通知 id`，活动提醒直接用活动 id
- **下拉刷新**：门户是「固定外壳 + 内层滚动」结构，ArkWeb 组件拿不到真实滚动位置，改由页面内探针脚本判断「主页 + 无弹窗 + 已置顶」，再决定这次手势是刷新还是交还页面滚动
- **系统栏配色**：状态栏 / 导航栏图标明暗跟随网页主题（探针回传页面底板明暗）
- **本地提醒**：`workScheduler` 周期任务每 30 分钟后台同步（已经是系统下限，需网络可用）；活动开始前 30 分钟用 `reminderAgentManager` 发布系统日历提醒，App 未打开或设备重启后仍能触发；同步到「已经进入提前量窗口」的活动会补一条立即提醒；活动被改期时会撤掉旧时间的提醒、按新时间重排（账本里记着当初排的触发时刻，只有时刻真的变了才动系统提醒）；同步发现新通知、新待填表单时逐条提醒（首次同步只记基线，不把历史内容补推一遍），各带自己的详情深链（不再聚合）；活动提醒与新通知都只发给 `remind_people` 点名的对象（空 = 全班），与安卓端 `SyncWorker.isMine`（本端 `SyncService.isMine`）、网页 `remindMe()` 同一口径，待填表单由 `/api/forms/mine` 在服务端滤过。活动提醒与新通知分属两个通知槽位，可分别开关（表单与通知共用后者），两条槽位都显式设成 `LEVEL_HIGH`（横幅 / 弹窗 + 响铃）—— 系统给槽位的默认级别只会在通知栏里静默堆着，用户注意不到。这里有个**待真机确认**的点：文档说 `addSlot` 对已存在的槽位是「更新」，但级别能不能往上调没实测过（安卓那边是只能在创建时定死、之后只能下调）；若老用户升上来仍不弹横幅，只能 `removeSlot` + `addSlot` 重建，代价是该槽位里用户改过的偏好被一并重置，所以没验证前不改成重建
- **回到前台补同步**：`onForeground` 触发一次同步（对应安卓端 `MainActivity.onResume`），带 60 秒节流、且上一轮没跑完就跳过；节流判据取「上次同步**完成**时间」而不是「上次触发时间」，所以同步一直失败时不会被卡住，下次回前台照常重试。原来只在 `onWindowStageCreate` 里同步，而 App 从后台切回来时它不会再执行，会出现「用户明明开着 App、新通知却还躺在服务端」；冷启动 `onCreate → onWindowStageCreate → onForeground` 是紧挨着的，所以 `onForeground` 这一处也覆盖了原来那次「打开就同步」。登录成功（`Index.handleToken`）与卡片手动刷新（`EntryFormAbility` 的 `sync` 消息）传 `force` 绕过节流
- **服务卡片**：名为「今日活动」，显示当天最多 3 条班级活动（「现在及以后」的排在前面，还空着才补当天更早的），支持 2×2 / 2×4 两种尺寸，点击直接打开 App；数据由同步任务写入本地缓存后推送，卡片渲染时不联网
- **教务绑定**：与安卓同一条路径 —— 固定桌面 UA 打开教务登录页，登录完成后读教务域 Cookie 上报后端，成功则回到门户课表页
- 适配 phone / tablet / 2in1；权限只申请 `INTERNET` / `GET_NETWORK_INFO` / `PUBLISH_AGENT_REMINDER`
- 构建：用 DevEco Studio 打开 `HarmonyOS/` 目录构建（compatibleSdkVersion `5.0.0(12)`，runtimeOS HarmonyOS；仓库未带 hvigor wrapper 脚本，走 IDE 内置的 Hvigor）；签名材料由各开发者本地生成，`build-profile.json5` 的 `signingConfigs` 留空不入库
- 与安卓端的差异：后台同步与提醒周期由系统调度（`workScheduler` / `reminderAgentManager`），不保证准点；活动提醒走系统「日历类」提醒，只精确到分钟，因此进入提前量窗口的补排会取「下一分钟整点」（安卓端 `AlarmManager` 可到毫秒）；`testNotification()` 只能同步回「没登录 / 通知权限没开」这两类提示（见上）；其余行为（通知 id、深链拼法、缓存下限、卡片排序、回前台的 60 秒同步节流、外链交给系统浏览器、退出登录清理、按新时间重排改期活动）都已与安卓端对齐（通知槽位级别能否对已存在的槽位上调是例外，见上，尚待真机验证）

### 常驻调度进程（`cmd/scheduler` + `internal/`）

门户继续跑在 Cloudflare Functions 上；Go 常驻进程只承接「必须一直活着」的事：轮询、抓取、对外限流。

- **与 Worker 共用同一套规则**：Cookie 封存格式 `v1.<iv>.<ciphertext>`（AES-256-GCM；密钥取 `COOKIE_SECRET`，缺省回退 `JWT_SECRET` 派生，解密时两个都试，避免后加密钥把旧记录锁死），与 `cookieVault.js` 交叉验证；学号比对、预置职位白名单、权限白名单与 `permissions.js` 同源，不另起一套
- **当前只做封存自检**：`run` 每小时验一次「能封能解」，确认进程活着、密钥没配坏。课表 / 通知的真实轮询抓取还没接进来，跑它不会替任何人拉数据
- 命令：`go test ./...`、`go run ./cmd/scheduler once`（跑一轮自检后退出，给 CI / 手工验证）、`go run ./cmd/scheduler run`（长期运行）；封存类命令读环境变量 `COOKIE_SECRET` / `JWT_SECRET`，与 Pages Secrets 同一套
- 细节见 `scheduler/README.md`

### 规划中

⏳ Agent 编排、微信消息通道、通知抓取、RAG 知识库、本地轻量模型

## 协作分工

> 依据本仓库的提交记录整理（账号名）

| 贡献者 | 主要工作 |
| --- | --- |
| AJiang233 | 后端 API / 鉴权与权限体系 / 通知与活动数据模型、安卓端（WebView 套壳、下拉刷新、本地提醒、桌面小组件、日历订阅）、CAS 代登录的 Cookie 罐（按域 + Path 存取）与会话换取判定、课表页错误分支兜底、前端 API 超时兜底、文档 |
| TsoiTZF | Go 常驻调度（`cmd/scheduler` + `internal/`：Cookie 封存 / 学号比对 / 职位白名单 / 进程内限流，密文格式与 Worker 交叉验证）、安全审查与加固（教务越权、自定义职位提权、密码长度、MFA 次数上限） |
| TidalStarNan | 架构迁移到 Cloudflare Pages（`functions/` 接管 `/api/*`）、Web 前端主体开发与移动端布局适配修复（班级主页 / 通知 / 活动 / 账号 / 管理员页面 / 弹窗）、安卓端 GitHub Actions 打包（APK 构建与版本号注入） |
| juuuua | 鸿蒙端（ArkTS：ArkWeb 套壳与 `CAHost` JS 桥、workScheduler 后台同步、reminderAgentManager 到点提醒、服务卡片「今日活动」、教务绑定流程） |

## Roadmap

- [x] 日历 / 待办 + 网站 + 账号体系（Web 基础功能已完成）
- [x] 移动端：安卓 WebView 应用 + 本地提醒 + 桌面小组件
- [x] 移动端：鸿蒙 ArkWeb 应用 + 系统提醒 + 服务卡片
- [x] 多端提醒：系统日历订阅（iOS / 鸿蒙 / 桌面通用）
- [x] 安全加固：鉴权与提权防护 / 教务越权 / MFA 次数上限
- [x] Go 常驻调度骨架：封存自检 + 与 Worker 对齐的规则（`internal/`）
- [ ] 调度进程接入真实轮询抓取（`crawler/` 复用 `internal/`）
- [ ] 确定微信消息通道方案
- [ ] 通知抓取 + 归档 + 人工确认转发（MVP）
- [ ] RAG 知识库 + 群内答疑

## 说明

本项目用于个人学习与班级服务，请遵守各平台使用条款，并注意保护同学的个人隐私信息。教务绑定只允许本人学号，会话 Cookie 加密落库；生产环境的 `JWT_SECRET` / `COOKIE_SECRET` 必须配成 Secrets，不要写进仓库（Pages Secrets 配一次即可，Go 调度进程读同名环境变量）；本地开发复制 `web/.dev.vars.example` 为 `web/.dev.vars`。
