# Class Assistant · 鸿蒙端

ArkTS + ArkWeb 套壳，加载线上门户（`web/`）。与安卓端同一套产品形态：套壳 + 系统到点提醒 + 服务卡片。

## 目录结构

```
HarmonyOS/
├── AppScope/
│   ├── app.json5                        # bundleName / versionName / versionCode
│   └── resources/base/                  # 应用名、图标
├── entry/src/main/
│   ├── ets/
│   │   ├── entryability/EntryAbility.ets # 入口：ArkWeb 容器、生命周期、系统栏、深链
│   │   ├── pages/
│   │   │   ├── Index.ets                 # 主页面：ArkWeb + 注入脚本
│   │   │   └── ProbeJs.ets               # 页面内探针（滚动位置 / 主题明暗 / token 回传）
│   │   ├── sync/
│   │   │   ├── SyncService.ets           # 同步逻辑（拉活动 / 通知 / 待填表单）
│   │   │   ├── SyncWorkAbility.ets       # workScheduler 周期任务入口
│   │   │   └── Scheduler.ets             # 各类排期
│   │   ├── notice/NoticeService.ets      # 通知槽位与发通知
│   │   ├── remind/ReminderService.ets    # reminderAgentManager 到点提醒
│   │   ├── net/Api.ets                   # 门户 REST 客户端
│   │   ├── data/Store.ets                # 首选项：token / 上次同步时间 / 卡片缓存
│   │   ├── model/SchoolEvent.ets         # 活动 / 通知模型
│   │   ├── common/
│   │   │   ├── Constants.ets             # 通知 id 分段、常量
│   │   │   ├── DeepLink.ets              # 深链拼法
│   │   │   └── SystemBar.ets             # 系统栏配色
│   │   └── widget/
│   │       ├── EntryFormAbility.ets      # 服务卡片入口（含手动刷新消息）
│   │       ├── WidgetCard.ets            # 「今日活动」卡片布局
│   │       └── WidgetUpdater.ets         # 卡片数据推送
│   ├── resources/                        # 文案（base / zh_CN / en_US）、颜色、图标、form_config
│   └── module.json5                      # 权限、ability、workScheduler / form 扩展
├── hvigor/hvigor-config.json5
├── build-profile.json5                   # 产品与模块（compatibleSdkVersion 等）
└── ANDROID-PARITY.md                     # 与安卓端的能力对照 + 跟进清单
```

## 构建

用 **DevEco Studio** 打开 `HarmonyOS/` 目录构建（仓库未带 hvigor wrapper 脚本，走 IDE 内置的 Hvigor）。签名材料由各开发者本地生成，`build-profile.json5` 的 `signingConfigs` 留空不入库。

| 项 | 值 |
| --- | --- |
| 最低系统 | `compatibleSdkVersion` `5.0.0(12)` —— HarmonyOS NEXT 5.0.0 / API 12 |
| 目标 | `targetSdkVersion` `26.0.0`、`runtimeOS` `HarmonyOS` |
| 设备 | `phone` / `tablet` / `2in1` |
| 包名 | `com.classassistant.app`，`versionName` `0.1.0` / `versionCode` `1` |
| 权限 | 只申请 `INTERNET` / `GET_NETWORK_INFO` / `PUBLISH_AGENT_REMINDER` |

> 两个版本号看着不同构是正常的：**API 26 起版本号不再带 `(API)` 后缀**，所以一个写成 `5.0.0(12)`、一个写成 `26.0.0`，两者可比且 `compatible ≤ target ≤ compile`。
>
> 发版后要把 `web/version.json` 的 `harmony` 段 `version` 改成与 `AppScope/app.json5` 的 `versionName` 一致，否则个人中心「检查更新」读不到。

## 与安卓端的差异

后台同步与提醒周期由系统调度（`workScheduler` / `reminderAgentManager`），不保证准点；活动提醒走系统「日历类」提醒，只精确到分钟，因此进入提前量窗口的补排会取「下一分钟整点」（安卓端 `AlarmManager` 可到毫秒）；`testNotification()` 只能同步回「没登录 / 通知权限没开」这两类提示（见下）。其余行为（通知 id、深链拼法、缓存下限、卡片排序、回前台的 60 秒同步节流、外链交给系统浏览器、退出登录清理、按新时间重排改期活动）都已与安卓端对齐 —— 通知槽位级别能否对已存在的槽位上调是例外，尚待真机验证。

两端逐项的能力对照与待跟进项见 [`ANDROID-PARITY.md`](./ANDROID-PARITY.md)。

## 功能与实现要点

### 套壳与导航

- **套壳与登录态**：ArkWeb 组件加载线上门户；网页 localStorage 里的 token 由注入脚本经 JS 桥 `CAHost` 回传到本地首选项，网页里退出登录会同步清掉本地凭据、已排提醒与卡片缓存
- **外链**：站内与教务域留在 ArkWeb，其它 http(s) 外链（含 APK 下载）交给系统浏览器；教务登录期间一律不外跳（认证会跨主机，跳走就断了），系统协议（`tel` / `sms` / `mailto`）同样拦下不加载 —— 与安卓端 `shouldOverrideUrlLoading` 同一套判断
- **JS 桥**：`CAHost` 与安卓端对齐 —— `setPullRefreshReady` / `setToken` / `startAcademicLogin` / `setTheme`，外加 `platform()`（网页据此读 `version.json` 自己那段）、`appVersion()`、`appStatus()`（本机通知开关 + 上次同步时间，对应安卓端同名桥）、`testNotification()`；所有桥方法都先校验调用方是本应用页面，教务系统这类外部站点调不动，避免外部页面改本地 token 或触发教务绑定。其中 `testNotification()` 有个已知的有损点：桥必须同步返回而拉数据要发请求，所以它只能在「本地没有 token」和「通知权限没开」这两个分支同步回一句提示，其余结果一律返回空串、由网页显示兜底文案（安卓端的桥能同步阻塞，拿得到完整结果）
- **通知深链**：点提醒 / 通知直达对应活动、通知详情（`?view=activities&id=` / `?view=notices&id=`），App 未打开（冷启动读启动 `want`）与已在运行（`onNewWant`，对应安卓端 `onNewIntent`）都生效；表单没有壳内详情页，直接开网页填写页（`forms.html?id=`）；通知 id 与安卓端同规则 —— 表单用 `200000 + 表单 id`、通知用 `100000 + 通知 id`，活动提醒直接用活动 id
- **下拉刷新**：门户是「固定外壳 + 内层滚动」结构，ArkWeb 组件拿不到真实滚动位置，改由页面内探针脚本判断「主页 + 无弹窗 + 已置顶」，再决定这次手势是刷新还是交还页面滚动
- **系统栏配色**：状态栏 / 导航栏图标明暗跟随网页主题（探针回传页面底板明暗）

### 本地提醒

- **本地提醒**：`workScheduler` 周期任务每 30 分钟后台同步（已经是系统下限，需网络可用）；活动开始前 30 分钟用 `reminderAgentManager` 发布系统日历提醒，App 未打开或设备重启后仍能触发；同步到「已经进入提前量窗口」的活动会补一条立即提醒；活动被改期时会撤掉旧时间的提醒、按新时间重排（账本里记着当初排的触发时刻，只有时刻真的变了才动系统提醒）；同步发现新通知、新待填表单时逐条提醒（首次同步只记基线，不把历史内容补推一遍），各带自己的详情深链（不再聚合）；活动提醒与新通知都只发给 `remind_people` 点名的对象（空 = 全班），与安卓端 `SyncRunner.isMine`（本端 `SyncService.isMine`）、网页 `remindMe()` 同一口径，待填表单由 `/api/forms/mine` 在服务端滤过。活动提醒与新通知分属两个通知槽位，可分别开关（表单与通知共用后者），两条槽位都显式设成 `LEVEL_HIGH`（横幅 / 弹窗 + 响铃）—— 系统给槽位的默认级别只会在通知栏里静默堆着，用户注意不到。这里有个**待真机确认**的点：文档说 `addSlot` 对已存在的槽位是「更新」，但级别能不能往上调没实测过（安卓那边是只能在创建时定死、之后只能下调）；若老用户升上来仍不弹横幅，只能 `removeSlot` + `addSlot` 重建，代价是该槽位里用户改过的偏好被一并重置，所以没验证前不改成重建
- **回到前台补同步**：`onForeground` 触发一次同步（对应安卓端 `MainActivity.onResume`），带 60 秒节流、且上一轮没跑完就跳过；节流判据取「上次同步**完成**时间」而不是「上次触发时间」，所以同步一直失败时不会被卡住，下次回前台照常重试。原来只在 `onWindowStageCreate` 里同步，而 App 从后台切回来时它不会再执行，会出现「用户明明开着 App、新通知却还躺在服务端」；冷启动 `onCreate → onWindowStageCreate → onForeground` 是紧挨着的，所以 `onForeground` 这一处也覆盖了原来那次「打开就同步」。登录成功（`Index.handleToken`）与卡片手动刷新（`EntryFormAbility` 的 `sync` 消息）传 `force` 绕过节流

### 服务卡片

- **服务卡片**：名为「今日活动」，显示当天最多 3 条班级活动（「现在及以后」的排在前面，还空着才补当天更早的），支持 2×2 / 2×4 两种尺寸，点击直接打开 App；数据由同步任务写入本地缓存后推送，卡片渲染时不联网

### 教务绑定

- **教务绑定**：与安卓同一条路径 —— 固定桌面 UA 打开教务登录页，登录完成后读教务域 Cookie 上报后端，成功则回到门户课表页
