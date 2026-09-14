# Class Assistant · 安卓端

Kotlin + WebView 套壳，加载线上门户（`web/`）。原生层只做网页做不到的事：本地提醒、桌面小组件、离线缓存、后台常驻。

`compileSdk 34` / `minSdk 24` / `targetSdk 34`，Java 17，包名 `com.classassistant.app`。

## 目录结构

```
android/
├── app/src/main/
│   ├── java/com/classassistant/app/
│   │   ├── MainActivity.kt               # 套壳入口：WebView、系统栏配色、下拉刷新、JS 桥 CAHost、教务绑定
│   │   ├── data/
│   │   │   ├── Store.kt                  # SharedPreferences：token / 上次同步时间 / 各类开关
│   │   │   └── OfflineCache.kt           # 按 URL 存只读响应，断网回放
│   │   ├── sync/
│   │   │   ├── SyncRunner.kt             # 真正的同步逻辑（WorkManager 与前台服务共用同一份）
│   │   │   ├── SyncWorker.kt             # WorkManager 侧（15 分钟）的薄壳
│   │   │   ├── BackgroundSyncService.kt  # 前台服务（3 分钟），把进程钉住
│   │   │   ├── Scheduler.kt              # 周期任务与各类闹钟的排期
│   │   │   ├── SyncAlarmReceiver.kt      # 深 Doze 兜底闹钟
│   │   │   ├── BootReceiver.kt           # 开机 / 覆盖安装后重新排期
│   │   │   ├── BackgroundMode.kt         # 免电池优化申请 + 各 ROM 自启动页跳转表
│   │   │   ├── CourseSchedule.kt         # 课表日期逻辑（第几周 / 下一个有课的日子 / 闹钟编号）
│   │   │   ├── Api.kt                    # 门户 REST 客户端（含 JWT 载荷读取）
│   │   │   ├── OfflineApi.kt             # 断网时代答本站 /api/ 的只读请求
│   │   │   └── Event.kt                  # 活动 / 通知的数据模型
│   │   ├── notify/
│   │   │   ├── Notifier.kt               # 通知渠道定义与发通知
│   │   │   └── AlarmReceiver.kt          # 活动到点提醒
│   │   └── widget/
│   │       ├── TodayWidgetProvider.kt    # 「今日活动」小组件
│   │       ├── CoursesWidgetProvider.kt  # 「课表」小组件
│   │       └── WidgetRefreshReceiver.kt  # 零点换天刷新
│   ├── res/                              # 布局 / 资源 / network_security_config / 小组件配置
│   └── AndroidManifest.xml
└── app/src/test/java/…                   # JVM 单测
    ├── sync/CourseScheduleTest.kt        # 课表日期逻辑
    ├── sync/EventTest.kt                 # 活动「哪天算在办」（与网页主页同口径）
    ├── sync/SyncRunnerTest.kt            # 同步去重（首轮只记基线）
    ├── data/OfflineCacheTest.kt          # 离线缓存
    └── ReleaseShrinkTest.kt              # R8 keep 规则没被关掉
```

`app/` 之外是标准 Gradle 骨架（`build.gradle.kts` / `settings.gradle.kts` / `gradle.properties` / wrapper）。

## 构建与测试

```bash
cd android
./gradlew assembleDebug          # 产物在 app/build/outputs/apk/debug/
./gradlew testDebugUnitTest      # JVM 单测
```

仓库不要求本地具备 Android SDK / JDK，**改动无法在本地编译验证**，靠 CI（`.github/workflows/build-android.yml`）构建校验；CI 会在打包前跑单测，红了就不发版。

`testDebugUnitTest` 覆盖课表的日期逻辑（开学第几周、下一个有课的日子、跨零点下课、进行中那节课的进度、闹钟编号），另有 `ReleaseShrinkTest` 守住下面 R8 那条约定。这类代码算错了不会崩，只会悄悄显示错的那一天、画错那一条线，所以说不出错不等于没错。

## 签名与发版

- 正式 keystore 不进仓库（`.gitignore` 挡了 `*.jks` / `*.keystore`），只以 base64 存在仓库 Secrets：`KEYSTORE_BASE64`（keystore 的 base64）、`KEYSTORE_PASSWORD`、`KEY_ALIAS`、`KEY_PASSWORD`；密钥与口令务必另行备份，丢了就只能改包名、让所有人重装一次
- 生成 keystore：`keytool -genkeypair -v -keystore release.jks -alias class-assistant -keyalg RSA -keysize 2048 -validity 10000`，再 `base64 -w0 release.jks`（PowerShell：`[Convert]::ToBase64String([IO.File]::ReadAllBytes("release.jks"))`）填进 `KEYSTORE_BASE64`
- 发版：CI 注入 `version_name`、从 Secrets 还原 keystore 后产出已签名的 release 包；发布 Release 后需同步更新 `web/version.json` 的 `android` 段（版本号 + APK 稳定直链），否则个人中心「检查更新」读不到，维护细节见 [`web/README.md`](../web/README.md) 的部署一节
- `build.gradle.kts` 里的签名配置只读环境变量（`CA_KEYSTORE_FILE` 等）：本地没有密钥时不创建该配置，release 出未签名包 —— 既不影响 `assembleDebug`，也杜绝「本地没密钥却拿 debug 密钥签个包发出去」

## 功能与实现要点

### 套壳与导航

- WebView 套壳加载线上门户：登录态持久化、下拉刷新（仅在页面置顶时触发）、返回键回退；站内与教务域留在 WebView，其它外链（含 APK 下载）交给系统浏览器
- **系统栏配色**：状态栏 / 导航栏跟随网页底色（浅色 / 深色各自适配，图标明暗自动切换）
- **JS 桥 `CAHost`**：`setToken` / `setPullRefreshReady` / `setTheme` / `startAcademicLogin` / `platform` / `appVersion` / `appStatus` / `testNotification` —— 与鸿蒙端同一套契约（网页按字面量调用，所以 R8 的 keep 规则不能少，见下面「体积与混淆」）
- **通知深链**：点提醒直达对应活动 / 通知详情，App 未打开（冷启动读启动 Intent）与已在运行（`onNewIntent`）都生效；表单在 App 里没有列表页，通知直接开网页填写页（`forms.html?id=`，与 Web Push 同一个落地页）

### 本地提醒与通知

- **本地提醒**：WorkManager 每 15 分钟后台同步活动 / 通知 / 待填表单（15 分钟已是系统下限；另有前台服务把间隔压到 3 分钟，见下面「后台常驻」），回到前台时再同步一次 —— 距上次成功同步不足 60 秒就跳过，避免切来切去反复拉；AlarmManager 在活动开始前 30 分钟发通知（App 未打开也能收到）；同步到新通知、新表单时各提醒一条（首次同步只记基线，不把历史内容补推一遍），通知与活动提醒都只发给 `remind_people` 点名的对象（空 = 全班，名单里可写姓名或用户 id）—— 与网页列表的 `remindMe()`、服务端「推给谁」同一口径；只在活动那一支判一次的话，通知就会「没被点名也弹」，所以两处共用 `SyncRunner.isMine`。待填表单不用客户端再判：`/api/forms/mine` 服务端已按提醒对象滤过
- **通知渠道**：两条都是「重要」级别，系统会以横幅（浮动通知）弹出 —— 活动提醒是 `activity_reminder`，通知与表单待办是 `class_notice_v2`。**id 里的 v2 不能去掉**：渠道重要性只在创建时生效，之后应用只能下调、不能上调（用户手动改的更是永远优先），老的 `class_notice`（默认级别，不弹横幅）改不动，只能换新 id 重建；建完顺手把老渠道删掉，否则系统设置里会永远多一条不弹横幅的渠道，用户分不清该关哪条。用户在系统设置里仍可单独把某条渠道调成静音 —— 这是他的最终权利，代码不跟它抢
- **本机状态可在网页查**：个人中心经 JS 桥取「本机通知开没开 + 上次同步时间」——同步时间跟在资料卡的「更新时间」下面，通知开关留在「偏好设置」卡片里「App 端通知」的推送测试上面（整块仅 App 壳内显示，网页版没有桥就隐藏）；通知被系统关掉时，推送测试不再回「已推送」而是直接说明原因（否则用户对着通知栏找不到东西，只会以为推送坏了）

### 桌面小组件

- **桌面小组件**：两个 —— 「今日活动」显示今天的班级活动；「课表」显示今天要上的课。**两张卡片长得完全一样**：一张圆角卡（**底色 = 该行左侧那道彩条的浅色版**，六色一一配对、由 `widget/WidgetCard.kt` 的同一个取色算法给出；底色要圆角，而 RemoteViews 只能铺方角纯色，所以是画在一层 `ImageView` 上、用 `setImageViewResource` 换资源），卡里从上到下三行「时间 / 名称 / 地点」，左侧一道**彩色竖条**（颜色按名字从 6 色调色板里固定分配，同一门课 / 同一场活动哪天都同色），行列表都是**可滚动的列表**（集合组件：`CoursesWidgetService` / `EventsWidgetService` + `ListView` + 共用的 `widget_card_item.xml`），有几条就列几行、装不下往下滚，**没有写死的行数上限**；代价是清单里必须声明这两个服务并带 `BIND_REMOTEVIEWS`，漏了对应列表会**永远是空的、且不报错**；组件布局还只能用 RemoteViews 白名单里的类（`FrameLayout` / `LinearLayout` / `RelativeLayout` / `GridLayout` / `ImageView` / `TextView` / `ProgressBar` / `ListView` 等），**纯 `android.view.View` 不在其中** —— 侧面那道彩条因此是 `ImageView` 而不是 `<View>`，写成 `<View>` 时启动器 inflate 整行会抛 `Class not allowed to be inflated`，表现是标题还在、列表整块变成灰色的「无法加载小部件」（2026-09-14 踩过一次）。两处差异：「今日活动」的标题**不带日期**（「今日活动」/「张三 的今日活动」），活动卡片也不画进度条；课表则一律在标题里带日期（「今日 09-16 课程」/「明日 09-16 课程」/「周五 09-18 课程」）—— 桌面这块屏是缓存的，不写日期就分不清它是今天算出来的还是昨天剩下来的。尺寸：两块都是**长 3 格 × 高 2 格**（180dp × 110dp）—— 格子按框架的 `min = 70n − 30` 折算，再大一点就跳成下一格、卡片周围多出一整格空白；2 格高扣掉标题与内边距后只完整露得下一张卡（一张三行卡就有 50 多 dp），其余靠列表往下滚。这一档是 2026-09-14 有意调小的（原先两块都是 4 格 × 3 格 = 250dp × 180dp），同时把各处边距一起收紧了一档（组件内边距 14dp → 左右 12dp / 上下 10dp、列表行距 5dp → 4dp、卡内左内边距 14dp → 12dp、卡内上下 6dp → 5dp）。课表组件今天还有课就显示今天（正在上的那节也算），**正在上的那张会用进度条盖出「上到一半」的效果**、课程名换成强调色，已上完的课程名变灰；今天的课上完了、或今天根本没课，就往前找**下一个真有课的日子**并在标题里标出来 —— 跳过周末与单双周没课的日子，否则一到周末它就一片空白；没绑教务时说的是「还没同步到课表」而不是「今日无课」，这两种空态的区别写在 `CoursesWidgetProvider` 里；另外，两个组件在系统「添加小组件」列表里显示的名字与图标，分别取自各自 receiver 的 `android:label` / `android:icon` —— 都不写就会一起回退成应用的名字与图标，两条在列表里长得一模一样（图标见 `ic_widget_today` / `ic_widget_courses`）
- **「今日活动」按什么口径显示**：与**网页主页完全一致** —— 后端 `/api/activities` 的默认 `scope=active` 是**按天**过滤的（`start_day <= 目标日 <= end_day`），所以昨天开始、今天还没结束的活动今天照样在列，单天的活动在结束那天也还在（哪怕时刻已经过去），第二天 00:00 才消失；`end_time` 为空就是「只占开始那天」。原生这边落库与两处过滤（列表数据 + 「有没有活动」的空态判定）走的是**同一个纯函数** `sync/Event.isEventActiveOnDay`（单测在 `EventTest`）：两处各写一份的话，一旦口径岔开，用户看到的就是「标题说今日有安排、下面却空着」。缓存本身也按这个口径留（`SyncRunner` 的判据是活动的**最后一天**而不是开始时间），否则一条昨天开始的运动会会被整场丢掉；跨天的那条在卡片上会带日期（`MM-dd HH:mm`），不然「08:00」会被当成今天 08:00。
- **小组件换天**：两个组件的内容都按**设备本地日期**算，但原来的刷新时机只有「后台同步成功」与 `updatePeriodMillis`（系统夹到最少 30 分钟，Doze 下更久）：过了零点没人叫它们，桌面就一直挂着昨天那一屏。现在按本机零点排一个 `RTC` 闹钟（`AlarmManager.RTC` 不唤醒设备，睡着就等醒来再刷）专门刷新这两个组件，接收方刷完自己再排下一次；系统时间/时区变更、覆盖安装、打开 App 时各补一次。`DATE_CHANGED` 特意没有注册 —— 它不在系统的隐式广播豁免名单里，清单注册的接收器收不到，换天只能靠零点闹钟，理由写在 `WidgetRefreshReceiver` 的注释里

### 课程提醒

- **课程提醒**：按本地课表在上课前提醒，在「个人中心 → 偏好设置 → 课程提醒」里可设提前多久（不提醒 / 5~60 分钟，默认 15）与是否在开课时再提醒一次（默认开）。设置存在原生 SharedPreferences，网页只经 `CAHost` 读写，改完**立刻**重排闹钟、不用等下次后台同步（否则用户会以为没保存上）。闹钟只排未来 7 天、按「绝对日期 + 课程序号 + 类型」编号 —— 用「今天往后第几天」的话同一个闹钟每过一天就换号，天天被当成新闹钟取消重排；窗口给 1 分钟，比活动提醒的 5 分钟紧，上课时间是精确的。课程提醒单独一条通知渠道，可以和班级活动/通知分开静音

### 后台常驻

- **后台常驻**：让「App 没打开、手机放着不动」时也能及时收到通知。前台服务（`sync/BackgroundSyncService.kt`）把进程钉住，每 3 分钟跑一轮同步 —— 真实逻辑抽在 `sync/SyncRunner.kt`，与 15 分钟的 `SyncWorker` 共用同一份（包括「首轮只记基线、不把历史内容补推一遍」的去重，这条是刷屏的唯一防线，单测在 `SyncRunnerTest`）；服务那一轮**只拉核心 3 个接口**，离线缓存预热那 5 个仍归 15 分钟的周期任务，否则一个班几十号人一天就能把后端额度啃穿。状态栏会挂一条最低重要级的常驻通知（系统对前台服务的硬性要求，点它回通知页），个人中心有「后台常驻」开关，关掉只是退回 15 分钟、功能不消失。服务类型按版本分支传：API 34+ 用 `specialUse`（没有时长上限，且将来 `targetSdk` 升到 35 后仍可从开机广播启动），29–33 用 `dataSync`，更老的版本不传。「开机自己起来」走 `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED`（都是后台启动前台服务的合法豁免时机），`START_STICKY` 只对「进程被内存回收」有效 —— 从最近任务划掉是强停，谁都救不回来，得再打开一次。**深 Doze 兜底**：前台服务能保住进程但**保不住 CPU** —— 深 Doze 会把 CPU 一起挂起，服务里那个进程内的定时器叫不醒它（真机实测：`force-idle` 期间一轮都没跑，服务本身还活着）。所以另排一个 `setAndAllowWhileIdle` 闹钟（Doze 下允许触发，被系统限流到约 9 分钟一次），由 `SyncAlarmReceiver` 直接跑一轮；接收器**只在 `isDeviceIdleMode` 时才真干活**，Doze 外定时器是准的、它不插一脚。于是「手机放着不动」这条路要两样齐全：免电池优化白名单（网络）+ 这个闹钟（CPU）。**注意**：首轮机验时这个闹钟在 `force-idle` 造出来的人为深 Doze 下没能投递（排上了、到点消失、零日志），是 `force-idle` 的特殊性还是真问题还没查清 —— 见方案文档第九节，下一轮要拿「自然进 Doze」再验
- **后台通知的系统限制**（与前一条配套，缺一条在手机放着不动时都收不到）：**Doze 会挂起网络访问，而前台服务并不能豁免这一点**，唯一确定的豁免是免电池优化白名单。所以个人中心那张「后台通知」卡片如实显示三项本机状态 —— 有没有免电池优化、前台服务在不在跑、系统给的待机档（active / working_set / frequent / rare / restricted），三项都是 AOSP 公开 API，跨 ROM 通用；并给两个入口：申请免电池优化（系统标准弹窗）、跳 ROM 的「自启动 / 后台管理」页（`BackgroundMode.AUTO_START_PAGES` 那张表逐个 try，全打不开就退到应用详情页）。**厂商的「自启动」没有标准 API、读不到**，页面上就如实写「这一项要你自己去确认」，不猜一个值糊上去。设计方案与取舍见 `.claude/artifacts/plans/android-background-notify.md`

### 离线可用

- **离线可用**：断网时课表、通知、活动照常能看。原生层在 `WebViewClient.shouldInterceptRequest` 里接管本站 `/api/` 的只读请求（`sync/OfflineApi.kt`）：在线时自己拉一份（用本机 token，不依赖 WebView 的请求头）、顺手按 URL 存一份（`data/OfflineCache.kt`），断网就把上次的响应原样回给页面。单条详情的请求（`/api/notices/{id}`）从缓存过的列表里按 id 拼回来 —— 后端列表项与详情返回的是同一行数据，所以字段一个不少，也不必为每条详情单独存文件（否则文件数随「点开过多少条」无限涨）。后台同步每轮还会照 `OfflineApi.PREWARM` 预热一遍**网页真正请求的那几个 URL**，于是离线数据的新鲜度跟着同步走，而不是「上次打开那个页面时」。两条边界：写操作（POST / PUT / DELETE）一律不接管，断网就该失败；服务端**答了**（401 / 500 / `success:false`）时原样透传、绝不退回缓存，否则「登录态失效了」会被一份旧数据盖住，页面既不会提示重新绑定，用户也看不出自己看的是哪天的东西。退出登录时随 `Store.clearSession` 一起清空（否则换账号后断网能翻到上一个账号的课表）
- **页面壳归网页自己管**：页面与静态资源的离线能力由 `sw.js` 的离线壳负责，原生层**刻意不碰** —— 在 App 里，这些导航请求会被 Service Worker 先接走，`shouldInterceptRequest` 根本看不见它们。这里踩过一次坑：真机反馈「杀进程重开后断网，除了主页都打不开」时，一度以为是原生层没兜住页面，于是照着 `sw.js` 的清单又做了一套原生离线壳，结果它永远走不到；真正的原因是 `sw.js` 预热的 `.html` 地址会被站点 308 跳到去扩展名的规范地址，跟过跳转的响应带着 `redirected` 标记、而规范禁止用它应答导航请求。修法与来龙去脉见 [`web/README.md`](../web/README.md) 的离线一节（**页面壳只该有一处实现**，两边各做一套的结果是其中一套永远走不到）。接口那一侧顺手改了一处：**断网回放不再要求 token**，读的是本机已经存下的数据，登录态在不在都不影响，以前先卡 token 会让「冷启动 + 断网 + 探针还没把 token 报上来」白跑一趟

### 教务绑定

- **教务绑定**：门户内一键打开教务登录页（固定桌面 UA，规避教务系统的手机端兼容问题），登录后由原生读出会话 Cookie 上报后端。教务系统的登录页至今是 **http**（安卓端打开 `https://szjw.njau.edu.cn`，门户自己会跳到 `http://szjw.njau.edu.cn/login/login.html`），所以 `res/xml/network_security_config.xml` 里给教务链路上的三个主机单独开了明文，其余仍全禁（`base-config` = false）—— 不开就是 `net::ERR_CLEARTEXT_NOT_PERMITTED`。**逐个点名、别改成 `njau.edu.cn` 通配**（见 `MainActivity.inAppHosts` 同款取舍），每个 `<domain>` 还必须显式写 `includeSubdomains="false"`（与不写等价，只匹配主机本身；缺了它 lint 的 `NetworkSecurityConfig` 规则判 **Fatal**，`lintVitalRelease` 会让整个 release 构建失败），别改成 `true` —— 那等于把明文放行扩到这几个主机的全部子域；代价是这几个主机上的流量可能以明文传输，这是校方服务器只提供 http 造成的，客户端没法单方面改成 https

### 体积与混淆

- **R8（release）**：开着代码压缩与资源收缩，APK 从 4.7 MB 降到 2.1 MB。唯一需要手写规则的地方是 WebView 的 JS 桥 —— `HostBridge` 的方法名同时写在两侧（`MainActivity.PROBE_JS` 里的 `CAHost.setToken` / `CAHost.setPullRefreshReady`，以及网页的那十来个调用点），而网页是按字面量调的、每处都包在 try/catch 里，名字被改名就是**静默失效**（登录态同步没了、个人页那几张卡片是空的），所以 `proguard-rules.pro` 里显式 keep 住了带 `@JavascriptInterface` 的方法；`ReleaseShrinkTest` 盯着「开关被关掉 / keep 规则被注释掉」这两种倒退
