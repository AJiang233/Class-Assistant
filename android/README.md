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
│   │   │   └── Event.kt                  # 活动 / 通知的数据模型 + 「哪天算在办」的判定
│   │   ├── notify/
│   │   │   ├── Notifier.kt               # 通知渠道定义与发通知
│   │   │   └── AlarmReceiver.kt          # 活动到点提醒
│   │   └── widget/
│   │       ├── TodayWidgetProvider.kt    # 「今日活动」小组件
│   │       ├── CoursesWidgetProvider.kt  # 「课表」小组件
│   │       ├── CoursesWidgetService.kt   # 课表卡片的行数据（集合组件的数据源）
│   │       ├── EventsWidgetService.kt    # 活动卡片的行数据（集合组件的数据源）
│   │       ├── WidgetCard.kt             # 两张卡片共用的取色与卡片底色
│   │       ├── WidgetRefreshReceiver.kt  # 系统广播（时间/时区变更、覆盖安装）刷新小组件
│   │       └── WidgetAlarmReceiver.kt    # 零点换天刷新 / 上课每分钟重绘（exported=false）
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

`testDebugUnitTest` 覆盖课表的日期逻辑（开学第几周、下一个有课的日子、跨零点下课、进行中那节课的进度、闹钟编号）与活动「哪天算在办」的按天窗口（`EventTest`，与网页主页同口径），另有 `ReleaseShrinkTest` 守住下面 R8 那条约定。这类代码算错了不会崩，只会悄悄显示错的那一天、画错那一条线，所以说不出错不等于没错。

## 签名与发版

- 正式 keystore 不进仓库（`.gitignore` 挡了 `*.jks` / `*.keystore`），只以 base64 存在仓库 Secrets：`KEYSTORE_BASE64`（keystore 的 base64）、`KEYSTORE_PASSWORD`、`KEY_ALIAS`、`KEY_PASSWORD`；密钥与口令务必另行备份，丢了就只能改包名、让所有人重装一次
- 生成 keystore：`keytool -genkeypair -v -keystore release.jks -alias class-assistant -keyalg RSA -keysize 2048 -validity 10000`，再 `base64 -w0 release.jks`（PowerShell：`[Convert]::ToBase64String([IO.File]::ReadAllBytes("release.jks"))`）填进 `KEYSTORE_BASE64`
- 发版：CI 注入 `version_name`、从 Secrets 还原 keystore 后产出已签名的 release 包；发布 Release 后需同步更新 `web/version.json` 的 `android` 段（版本号 + APK 稳定直链），否则个人中心「检查更新」读不到，维护细节见 [`web/README.md`](../web/README.md) 的部署一节
- `build.gradle.kts` 里的签名配置只读环境变量（`CA_KEYSTORE_FILE` 等）：本地没有密钥时不创建该配置，release 出未签名包 —— 既不影响 `assembleDebug`，也杜绝「本地没密钥却拿 debug 密钥签个包发出去」

## 功能与实现要点

### 套壳与导航

- WebView 套壳加载线上门户：登录态持久化、下拉刷新（仅在页面置顶时触发）、返回键回退；站内与教务域留在 WebView，其它外链（含 APK 下载）交给系统浏览器
- **系统栏配色**：状态栏 / 导航栏跟随网页底色（浅色 / 深色各自适配，图标明暗自动切换）
- **JS 桥 `CAHost`**：`setToken` / `setPullRefreshReady` / `setTheme` / `startAcademicLogin` / `platform` / `appVersion` / `appStatus` / `testNotification` —— 与鸿蒙端同一套契约（网页按字面量调用，所以 R8 的 keep 规则不能少，见下面「体积与混淆」）。**桥只挂在本站文档上**：离开门户 host（教务 / CAS 域）时 `removeJavascriptInterface`，回到本站再挂回来，判定与桥方法开头的 `fromAppPage()` 共用 `isAppOrigin`（主机精确相等，不放宽子域）—— 外部页面上拿到的不是「调了被拒」而是根本没有这个对象，不再依赖「`currentUrl` 与正在执行的文档一致」这个前提（issue #28）
- **通知深链**：点提醒直达对应活动 / 通知详情，App 未打开（冷启动读启动 Intent）与已在运行（`onNewIntent`）都生效；表单在 App 里没有列表页，通知直接开网页填写页（`forms.html?id=`，与 Web Push 同一个落地页）

### 本地提醒与通知

- **本地提醒**：WorkManager 每 15 分钟后台同步活动 / 通知 / 待填表单（15 分钟已是系统下限；另有前台服务把间隔压到 3 分钟，见下面「后台常驻」），回到前台时再同步一次 —— 距上次成功同步不足 60 秒就跳过，避免切来切去反复拉；AlarmManager 在活动开始前 30 分钟发通知（App 未打开也能收到）；同步到新通知、新表单时各提醒一条（首次同步只记基线，不把历史内容补推一遍），通知与活动提醒都只发给 `remind_people` 点名的对象（空 = 全班，名单里可写姓名或用户 id）—— 与网页列表的 `remindMe()`、服务端「推给谁」同一口径；只在活动那一支判一次的话，通知就会「没被点名也弹」，所以两处共用 `SyncRunner.isMine`。待填表单不用客户端再判：`/api/forms/mine` 服务端已按提醒对象滤过
- **通知渠道**：三条提醒渠道（活动 `activity_reminder_v3`、通知与表单待办 `class_notice_v3`、课程 `course_reminder_v3`）都是「最高」级别（`IMPORTANCE_MAX`，横幅 + 响铃 + 锁屏置顶）；常驻那条（前台服务）保持「最低」不响不弹。**id 里的 v3 不能去掉**：渠道重要性只在创建时生效，之后应用只能下调、不能上调（用户手动改的更是永远优先），老的 `class_notice` / `class_notice_v2` / `activity_reminder` / `course_reminder` 改不动，只能换新 id 重建；建完顺手把老渠道删掉，否则系统设置里会永远多几条旧渠道，用户分不清该关哪条。用户在系统设置里仍可单独把某条渠道调成静音 —— 这是他的最终权利，代码不跟它抢
- **本机状态可在网页查**：个人中心经 JS 桥取「本机通知开没开 + 上次同步时间」——同步时间跟在资料卡的「更新时间」下面，通知开关留在「偏好设置」卡片里「App 端通知」的推送测试上面（整块仅 App 壳内显示，网页版没有桥就隐藏）；通知被系统关掉时，推送测试不再回「已推送」而是直接说明原因（否则用户对着通知栏找不到东西，只会以为推送坏了）

### 桌面小组件

- **桌面小组件**：两个 —— 「今日活动」显示今天的班级活动；「课表」显示今天要上的课。**两张卡片长得完全一样**：一张圆角卡（**底色 = 该行左侧那道彩条的浅色版**，六色一一配对、由 `widget/WidgetCard.kt` 的同一个取色算法给出；底色要圆角，而 RemoteViews 只能铺方角纯色，所以是画在一层 `ImageView` 上、用 `setImageViewResource` 换资源），卡里从上到下三行「时间 / 名称 / 地点」，左侧一道**彩色竖条**（颜色按名字从 6 色调色板里固定分配，同一门课 / 同一场活动哪天都同色），行列表都是**可滚动的列表**（集合组件：`CoursesWidgetService` / `EventsWidgetService` + `ListView` + 共用的 `widget_card_item.xml`），有几条就列几行、装不下往下滚，**没有写死的行数上限**；代价是清单里必须声明这两个服务并带 `BIND_REMOTEVIEWS`，漏了对应列表会**永远是空的、且不报错**；组件布局还只能用 RemoteViews 白名单里的类（`FrameLayout` / `LinearLayout` / `RelativeLayout` / `GridLayout` / `ImageView` / `TextView` / `ProgressBar` / `ListView` 等），**纯 `android.view.View` 不在其中** —— 侧面那道彩条因此是 `ImageView` 而不是 `<View>`，写成 `<View>` 时启动器 inflate 整行会抛 `Class not allowed to be inflated`，表现是标题还在、列表整块变成灰色的「无法加载小部件」（2026-09-14 踩过一次）。两处差异：「今日活动」的标题**不带日期**（「今日活动」/「张三 的今日活动」），活动卡片也不画进度条；课表则一律在标题里带日期（「今日 09-16 课程」/「明日 09-16 课程」/「周五 09-18 课程」）—— 桌面这块屏是缓存的，不写日期就分不清它是今天算出来的还是昨天剩下来的。尺寸：两块都是**长 3 格 × 高 2 格**（180dp × 110dp）—— 格子按框架的 `min = 70n − 30` 折算，再大一点就跳成下一格、卡片周围多出一整格空白；2 格高扣掉标题与内边距后只完整露得下一张卡（一张三行卡就有 50 多 dp），其余靠列表往下滚。这一档是 2026-09-14 有意调小的（原先两块都是 4 格 × 3 格 = 250dp × 180dp），同时把各处边距一起收紧了一档（组件内边距 14dp → 左右 12dp / 上下 10dp、列表行距 5dp → 4dp、卡内左内边距 14dp → 12dp、卡内上下 6dp → 5dp）。课表组件今天还有课就显示今天（正在上的那节也算），**正在上的那张会用进度条盖出「上到一半」的效果**（进度条那层底色是**透明**的、「已上过」的一段是**半透明深色**叠上去：它铺满整张卡，底色不透明就会把每行的卡片底色整块盖掉，而 `progressDrawable` 是布局里写死的**一个**资源、没法跟着每行变色，所以只能取中性色；颜色见 `colors.xml` 的 `widget_chip_fill`）、课程名换成强调色，已上完的课程名变灰；今天的课上完了、或今天根本没课，就往前找**下一个真有课的日子**并在标题里标出来 —— 跳过周末与单双周没课的日子，否则一到周末它就一片空白；没绑教务时说的是「还没同步到课表」而不是「今日无课」，这两种空态的区别写在 `CoursesWidgetProvider` 里；另外，两个组件在系统「添加小组件」列表里显示的名字与图标，分别取自各自 receiver 的 `android:label` / `android:icon` —— 都不写就会一起回退成应用的名字与图标，两条在列表里长得一模一样（图标见 `ic_widget_today` / `ic_widget_courses`）。**列表里那片缩略图**（在名字右侧的大预览区）来自各自的 `android:previewImage`：两张 1280×1280 的正方形设计稿，放 `res/drawable-nodpi/`（`widget_today_preview.png` / `widget_courses_preview.png`）。两条讲究：**必须是正方形**，组件是 2×2，图不是方的启动器会照格子尺寸拉伸变形；**放 `nodpi` 而不是密度桶**，落进密度桶会被系统按机器密度先缩一次、再被启动器按格子尺寸缩第二次，等于糊两遍。同时**刻意没有用 `previewLayout`** —— Android 12+ 会优先用它，等于把这两张图盖掉；哪天改成拿真实控件渲染预览，记得把图一并撤掉。加之前列表里只有名字 + 图标 + `description` 那句说明，没有任何预览图；组件尺寸或卡片样式一改，这两张图要重出，否则等于骗用户往下拖
- **「今日活动」按什么口径显示**：与**网页主页完全一致** —— 后端 `/api/activities` 的默认 `scope=active` 是**按天**过滤的（`start_day <= 目标日 <= end_day`），所以昨天开始、今天还没结束的活动今天照样在列，单天的活动在结束那天也还在（哪怕时刻已经过去），第二天 00:00 才消失；`end_time` 为空就是「只占开始那天」。原生这边落库与两处过滤（列表数据 + 「有没有活动」的空态判定）走的是**同一个纯函数** `sync/Event.isEventActiveOnDay`（单测在 `EventTest`）：两处各写一份的话，一旦口径岔开，用户看到的就是「标题说今日有安排、下面却空着」。缓存本身也按这个口径留（`SyncRunner` 的判据是活动的**最后一天**而不是开始时间），否则一条昨天开始的运动会会被整场丢掉；跨天的那条在卡片上会带日期（`MM-dd HH:mm`），不然「08:00」会被当成今天 08:00。
- **小组件换天**：两个组件的内容都按**设备本地日期**算，但原来的刷新时机只有「后台同步成功」与 `updatePeriodMillis`（系统夹到最少 30 分钟，Doze 下更久）：过了零点没人叫它们，桌面就一直挂着昨天那一屏。现在按本机零点排一个 `RTC` 闹钟（`AlarmManager.RTC` 不唤醒设备，睡着就等醒来再刷）专门刷新这两个组件，接收方刷完自己再排下一次；系统时间/时区变更、覆盖安装、打开 App 时各补一次。`DATE_CHANGED` 特意没有注册 —— 它不在系统的隐式广播豁免名单里，清单注册的接收器收不到，换天只能靠零点闹钟，理由写在 `WidgetAlarmReceiver` 的注释里
- **上课时那条进度条自己会走**：进度条是**渲染那一刻算出来的快照**，只在列表被重新绑定时才按当时的 `now` 重算，而系统给小工具的定时档 `updatePeriodMillis` 最少 30 分钟 —— 一条 45 分钟的课最多蹦一格，看着就是「不会动」（issue #61）。所以上课期间自己排一串 `AlarmManager.RTC` 闹钟（同样非唤醒 + `setWindow`），每分钟触发一次 `WidgetAlarmReceiver.ACTION_CLASS_TICK` 重绘；「下一次排在哪」由纯函数 `sync/CourseSchedule.nextClassTickAt` 决定（单测在 `CourseScheduleTest`）：正在上课 → 一分钟后；还没上课 → 直接排到**下一节开课那一刻**（否则进度条要等「碰巧有人重绘」才出现，最坏晚半小时）；课上完 / 今天没课 → 返回 `null`，把那串闹钟撤掉，剩下的交给系统那一档与零点闹钟。**链子是靠每次 `render` 续的** —— 不管这次重绘是谁触发的（同步成功 / 换天 / 上一次的闹钟 / 打开 App），都会把下一格续上，漏一次也不会永远断掉；这个 action 只重绘课表组件，**不排同步**（每分钟排一轮网络任务，代价比进度条晚一格大得多）

### 课程提醒

- **课程提醒**：按本地课表在上课前提醒，在「个人中心 → 偏好设置 → 课程提醒」里可设提前多久（不提醒 / 5~60 分钟，默认 15）与是否在开课时再提醒一次（默认开）。设置存在原生 SharedPreferences，网页只经 `CAHost` 读写，改完**立刻**重排闹钟、不用等下次后台同步（否则用户会以为没保存上）。闹钟只排未来 7 天、按「绝对日期 + 课程序号 + 类型」编号 —— 用「今天往后第几天」的话同一个闹钟每过一天就换号，天天被当成新闹钟取消重排；窗口给 1 分钟，比活动提醒的 5 分钟紧，上课时间是精确的。课程提醒单独一条通知渠道，可以和班级活动/通知分开静音

### 后台常驻

- **后台常驻**：让「App 没打开、手机放着不动」时也能及时收到通知。前台服务（`sync/BackgroundSyncService.kt`）把进程钉住，每 3 分钟跑一轮同步 —— 真实逻辑抽在 `sync/SyncRunner.kt`，与 15 分钟的 `SyncWorker` 共用同一份（包括「首轮只记基线、不把历史内容补推一遍」的去重，这条是刷屏的唯一防线，单测在 `SyncRunnerTest`）；服务那一轮**只拉核心 3 个接口**，离线缓存预热那 5 个仍归 15 分钟的周期任务，否则一个班几十号人一天就能把后端额度啃穿。状态栏会挂一条最低重要级的常驻通知（系统对前台服务的硬性要求，点它回主页），个人中心有「后台常驻」开关，关掉只是退回 15 分钟、功能不消失。服务类型按版本分支传：API 34+ 用 `specialUse`（没有时长上限，且将来 `targetSdk` 升到 35 后仍可从开机广播启动），29–33 用 `dataSync`，更老的版本不传。「开机自己起来」走 `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED`（都是后台启动前台服务的合法豁免时机），`START_STICKY` 只对「进程被内存回收」有效 —— 从最近任务划掉是强停，谁都救不回来，得再打开一次。**深 Doze 兜底**：前台服务能保住进程但**保不住 CPU** —— 深 Doze 会把 CPU 一起挂起，服务里那个进程内的定时器叫不醒它（真机实测：`force-idle` 期间一轮都没跑，服务本身还活着）。所以另排一个 `setAndAllowWhileIdle` 闹钟（Doze 下允许触发，被系统限流到约 9 分钟一次），由 `SyncAlarmReceiver` 直接跑一轮；接收器**只在 `isDeviceIdleMode` 时才真干活**，Doze 外定时器是准的、它不插一脚。于是「手机放着不动」这条路要两样齐全：免电池优化白名单（网络）+ 这个闹钟（CPU）。**注意**：首轮机验时这个闹钟在 `force-idle` 造出来的人为深 Doze 下没能投递（排上了、到点消失、零日志），是 `force-idle` 的特殊性还是真问题还没查清 —— 见方案文档第九节，下一轮要拿「自然进 Doze」再验
- **后台通知的系统限制**（与前一条配套，缺一条在手机放着不动时都收不到）：**Doze 会挂起网络访问，而前台服务并不能豁免这一点**，唯一确定的豁免是免电池优化白名单。所以个人中心那张「后台通知」卡片如实显示三项本机状态 —— 有没有免电池优化、前台服务在不在跑、系统给的待机档（active / working_set / frequent / rare / restricted），三项都是 AOSP 公开 API，跨 ROM 通用；并给两个入口：申请免电池优化（系统标准弹窗）、跳 ROM 的「自启动 / 后台管理」页（`BackgroundMode.AUTO_START_PAGES` 那张表逐个 try，全打不开就退到应用详情页）。**厂商的「自启动」没有标准 API、读不到**，页面上就如实写「这一项要你自己去确认」，不猜一个值糊上去。设计方案与取舍见 `.claude/artifacts/plans/android-background-notify.md`

### 后台任务与耗电

- **清单：动任何一处后台逻辑之前，先看这一张**。会自己跑起来的东西全在下面，放在一起看才发现「这里省掉、那里又补回来」。按「会不会主动把睡着的 CPU 叫醒」分三组：
  - **会主动唤醒（`RTC_WAKEUP`，睡着也叫）—— 只有三条，都在明面上**：
    - 深 Doze 兜底闹钟（`BackgroundMode.scheduleDozeWake`）：**每 9 分钟一次**（`DOZE_WAKE_MINUTES`，也是 `setAndAllowWhileIdle` 在 Doze 里的限流下限，再短没用），只在「后台常驻」开着时存在；接收器只在 `isDeviceIdleMode` 时才真发请求（Doze 外定时器是准的，它不插手）；
    - 活动提醒（`Scheduler.rescheduleAlarms`）：每个**还没开始**的活动一个，提前 30 分钟（`REMIND_LEAD_MILLIS`）；
    - 课程提醒（`Scheduler.rescheduleCourseAlarms`）：未来 7 天滚动窗口、最多 60 个（`COURSE_ALARM_LIMIT`），每节课最多 2 个（提前 N 分钟 + 开课时），窗口给 1 分钟。
  - **不唤醒（`RTC` 非唤醒，或交给 WorkManager）—— 代价是次数，不是唤醒**：
    - 15 分钟周期同步（`Scheduler.ensurePeriodic`）：WorkManager 的周期下限就是 15 分钟，Doze 下还会被推到维护窗口，一轮 3 个接口 + 离线缓存预热 5 个接口（`deep = true`）；
    - 前台服务里那一轮（`BackgroundSyncService`）：**每 3 分钟一次**（`BackgroundMode.INTERVAL_MINUTES`），只拉核心 3 个接口（`deep = false`）—— 全项目最高频的请求，一个班几十号人就是每人每天约 1440 次，「及时性 ↔ 后端额度」那笔账的支点就是这个数；
    - 零点换天闹钟（`Scheduler.scheduleMidnightRefresh`）：一天一次，刷完自己续下一次；
    - **上课期间每分钟重绘课表小组件**（`Scheduler.scheduleClassTick`，2026-09-15 为 issue #61 加）：正在上课时**每分钟一次**、一节课约 45 次，课上完或今天没课就把闹钟撤掉（`CourseSchedule.nextClassTickAt` 返回 `null`）。`RTC` 非唤醒 + `setWindow` 一分钟窗口，**只重绘、不联网**；手机睡着时不叫醒设备、醒来补一次，所以上课把手机锁屏放兜里不会因此掉电。它不是「又加了一条后台服务」，而是补上「进度条是渲染那一刻的快照、而系统给小工具的定时档最少 30 分钟」这个差额。
  - **不占 CPU，但占别的**：前台服务把进程钉住（「后台常驻」开关控制），状态栏挂一条最低重要级的常驻通知 —— 这是内存与系统待机档的代价，不是 CPU 的。
  - **一次性的**：开机、覆盖安装、系统时间/时区变化各跑一轮（`BootReceiver`、`WidgetRefreshReceiver`）；回前台同步带 60 秒节流（`SYNC_THROTTLE_MILLIS`）。
  - **不耗电的那一边**（省得以后往这里白查）：全应用**不持有任何 `WakeLock`**，也没有用 `setExact*` 精确闹钟（那要单独申请 Android 12+ 的「闹钟与提醒」权限，等于再开一个耗电口子）；网页侧没有轮询定时器（唯一的 `setInterval` 是教务 MFA 的倒计时，只在页面可见时跑）。也就是说，耗电这件事只出在原生这几个闹钟与那个前台服务上。
- **以后优化时能动的几处**（都还没做，只是方向）：
  - 深 Doze 那 9 分钟一次唤醒：**没进免电池优化白名单时，Doze 里网络本来也不通**，这一轮大概率是白跑。要不要「没白名单就放长间隔、甚至不排」，得先拿真机读数确认 —— 方案文档第九节那条「`force-idle` 下闹钟没投递」的悬案也在这条线上；
  - 每轮同步都重排两组提醒闹钟（`SyncRunner` 里那两行）：前台服务开着时等于每 3 分钟把「7 天内的课程」重算一遍、最多 60 次 `setWindow`。课表与设置没变时其实可以跳过，省的是那点 CPU 和系统闹钟表的抖动；
  - 上课那条每分钟重绘：现在一分钟一格。往宽里放（2~5 分钟）就是拿精度换次数；另外当初还有一条路是把它做成会自己走的 `Chronometer` 文本（RemoteViews 原生支持，不必每分钟重绘），只是「进度条」那个视觉没选它 —— 真要抠电，这是第一顺位；
  - 前台服务那 3 分钟：再往下压只有两条路 —— 走推送（取舍见 `.claude/artifacts/plans/android-background-notify.md`），或让接口支持增量（`If-Modified-Since` / `ETag`）。后者**接口是网页与 App 共用的**，得先和后端对齐。

### 离线可用

- **在线首帧也走缓存**：上面那套只在断网时生效，在线时页面仍要等原生自己发的那次 HTTP 往返 —— 进 App 第一次看某个页面时那 0.5~1s 的加载动画等的就是它。现在多接了一支：在线且缓存**够新鲜**（`OfflineCache.RENDER_MAX_AGE_MS`，1 小时）就先把缓存交回页面，同时后台去取最新的，**内容真的变了**才经 `MainActivity.pushApiUpdate` 推回网页（网页侧在 `app.js` 用 `onApiData(key, fn)` 按请求 URL 注册渲染函数）。三个刻意的取舍：内容一致不推（否则白闪一下）；服务端答了错误（401 / 5xx）不推 —— 用户正看着内容，为一条 401 把他踢去登录页比晚一点发现更糟；缓存太旧就不先渲染（宁可照旧等一次网络，也别拿几天前的数据糊弄人）。`prewarmPaths` 也顺带补齐了列表页与个人中心用的 URL：缓存键就是 URL，主页的 `?scope=all&limit=200` 与列表页的 `?scope=all` 是两个键，缺一条那个页面第一次进去就还是加载态。主页那两个**当日列表**的键还带着日期（`?limit=50&date=今天`），写不进固定清单 —— 后台同步每轮按当天日期现拼一遍（`OfflineApi.prewarmPaths`），App **零点换天刷新**时干脆让后台同步跑一轮（`WidgetAlarmReceiver` 里的 `Scheduler.syncNow`，那一轮的 `prewarmPaths` 自然会把当天的两个键算出来）—— 冷启动来不及（实测页面请求 0.4 秒内就发出、预热要 1 秒上下才回来，还会和页面自己的落盘重复），接收器里也别自己发请求（被广播拉起的进程还在后台，网络被系统挡着，实测连 DNS 都解析不了）。这只是「尽量早」，真正兜底的是周期同步 —— 它 15 分钟一轮、走 deep 轮次，每轮都会按当天日期把这两个键预热出来，于是每天第一次进主页也不必等网络
- **离线可用**：断网时课表、通知、活动照常能看。原生层在 `WebViewClient.shouldInterceptRequest` 里接管本站 `/api/` 的只读请求（`sync/OfflineApi.kt`）：在线时自己拉一份（用本机 token，不依赖 WebView 的请求头）、顺手按 URL 存一份（`data/OfflineCache.kt`），断网就把上次的响应原样回给页面。单条详情的请求（`/api/notices/{id}`）从缓存过的列表里按 id 拼回来 —— 后端列表项与详情返回的是同一行数据，所以字段一个不少，也不必为每条详情单独存文件（否则文件数随「点开过多少条」无限涨）。后台同步每轮还会照 `OfflineApi.prewarmPaths()` 预热一遍**网页真正请求的那几个 URL**，于是离线数据的新鲜度跟着同步走，而不是「上次打开那个页面时」。两条边界：写操作（POST / PUT / DELETE）一律不接管，断网就该失败；服务端**答了**（401 / 500 / `success:false`）时原样透传、绝不退回缓存，否则「登录态失效了」会被一份旧数据盖住，页面既不会提示重新绑定，用户也看不出自己看的是哪天的东西。退出登录时随 `Store.clearSession` 一起清空（否则换账号后断网能翻到上一个账号的课表）——**换账号也一样清**：网页登录是直接覆盖 localStorage 里的 `ca_token`（`app.js` 的 `saveSession`），不会先走一次登出，所以 `MainActivity.setToken` 里按**用户 id**（不是 token 字符串，同一个人重新登录也会换一条 JWT）判断是否换了人，是的话先走一遍 `SyncRunner.logOutSession`，再落新凭据（issue #64）
- **页面壳归网页自己管**：页面与静态资源的离线能力由 `sw.js` 的离线壳负责，原生层**刻意不碰** —— 在 App 里，这些导航请求会被 Service Worker 先接走，`shouldInterceptRequest` 根本看不见它们。这里踩过一次坑：真机反馈「杀进程重开后断网，除了主页都打不开」时，一度以为是原生层没兜住页面，于是照着 `sw.js` 的清单又做了一套原生离线壳，结果它永远走不到；真正的原因是 `sw.js` 预热的 `.html` 地址会被站点 308 跳到去扩展名的规范地址，跟过跳转的响应带着 `redirected` 标记、而规范禁止用它应答导航请求。修法与来龙去脉见 [`web/README.md`](../web/README.md) 的离线一节（**页面壳只该有一处实现**，两边各做一套的结果是其中一套永远走不到）。接口那一侧顺手改了一处：**断网回放不再要求 token**，读的是本机已经存下的数据，登录态在不在都不影响，以前先卡 token 会让「冷启动 + 断网 + 探针还没把 token 报上来」白跑一趟

### 教务绑定

- **教务绑定**：门户内一键打开教务登录页（固定桌面 UA，规避教务系统的手机端兼容问题），登录后由原生读出会话 Cookie 上报后端。教务系统的登录页至今是 **http**（安卓端打开 `https://szjw.njau.edu.cn`，门户自己会跳到 `http://szjw.njau.edu.cn/login/login.html`），所以 `res/xml/network_security_config.xml` 里给教务链路上的三个主机单独开了明文，其余仍全禁（`base-config` = false）—— 不开就是 `net::ERR_CLEARTEXT_NOT_PERMITTED`。**逐个点名、别改成 `njau.edu.cn` 通配**（见 `MainActivity.inAppHosts` 同款取舍），每个 `<domain>` 还必须显式写 `includeSubdomains="false"`（与不写等价，只匹配主机本身；缺了它 lint 的 `NetworkSecurityConfig` 规则判 **Fatal**，`lintVitalRelease` 会让整个 release 构建失败），别改成 `true` —— 那等于把明文放行扩到这几个主机的全部子域；代价是这几个主机上的流量可能以明文传输，这是校方服务器只提供 http 造成的，客户端没法单方面改成 https
- **「登录完成」怎么判（issue #29）**：不能只看「当前 URL 落在教务域」—— 流程第一步加载的就是教务门户本身，而 Cookie 罐里往往还留着上一次的会话，于是刚点「一键绑定」就拿一份未认证的 Cookie 去上报，后端拉不到课表、失败又被当成流程结束，用户直接被踢回门户（现象就是「点一下、什么都没做、直接弹绑定失败」）。现在分三处收口：`onPageStarted` 记下「离开过教务主机」（登录链路是 `authserver`（CAS 登录页）→ `workflow`（中转）→ `szjw`（教务门户），前后两个主机不同，所以这是能观测到的事实）；`onPageFinished` 只在**离开过又回到教务主机**时上报一次，上报后立刻清标记，用户接着在教务站里翻页不会反复拉课表；上报失败**不结束流程**，留在教务页继续等（重新登录会再绕一遍 CAS），想放弃按返回键。另外开流程时会先拿现有 Cookie 顺手试一次，会话没过期（之前绑过、只是重装或换设备）就直接绑好，这一次失败不提示。后端本就是「校验通过才落库」（`bindWithCookies`，实现已随教务代码挪到私有仓 `class-assistant-private-api`），所以失败的那几次不会覆盖掉原有绑定。`AcademicBindFlowTest` 读源码钉住这四条 —— 它们被拆掉**没有任何运行期症状**，要等校方门户的跳转行为变一次才会再炸一遍

### 体积与混淆

- **R8（release）**：开着代码压缩与资源收缩，APK 从 4.7 MB 降到 2.1 MB。唯一需要手写规则的地方是 WebView 的 JS 桥 —— `HostBridge` 的方法名同时写在两侧（`MainActivity.PROBE_JS` 里的 `CAHost.setToken` / `CAHost.setPullRefreshReady`，以及网页的那十来个调用点），而网页是按字面量调的、每处都包在 try/catch 里，名字被改名就是**静默失效**（登录态同步没了、个人页那几张卡片是空的），所以 `proguard-rules.pro` 里显式 keep 住了带 `@JavascriptInterface` 的方法；`ReleaseShrinkTest` 盯着「开关被关掉 / keep 规则被注释掉」这两种倒退

### 安全说明

- **登录 token 以明文存在 SharedPreferences**（`data/Store.kt`）。这是已知取舍：WebView 壳需要把网页的登录态搬到原生侧（后台同步 / 小组件 / 通知闹钟都要用它），而 Android 没有系统级加密存储；已用三层兜住 —— `allowBackup=false`（云备份不带走）、全站 HTTPS（传输不泄漏）、日志里不打印 token。真机 root 后能被读走，与其它未加固 App 同级风险。别为它引入 EncryptedSharedPreferences：那会要求 targetSdk 升到 35+ 才稳定可用，且换库要迁移全部存量数据，收益（防 root 后读取）与改动不成比例
