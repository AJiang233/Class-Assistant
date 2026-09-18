package com.classassistant.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import com.classassistant.app.data.Store
import com.classassistant.app.databinding.ActivityMainBinding
import com.classassistant.app.notify.Notifier
import com.classassistant.app.sync.Api
import com.classassistant.app.sync.BackgroundMode
import com.classassistant.app.sync.BackgroundSyncService
import com.classassistant.app.sync.OfflineApi
import com.classassistant.app.sync.Scheduler
import com.classassistant.app.sync.SyncRunner
import com.classassistant.app.sync.parseTimetableJson
import org.json.JSONObject

/**
 * 班级助理 — WebView 套壳
 * 加载 https://class.qxwkstudio.top，支持登录态持久化、下拉刷新、返回键，
 * 以及登录后的本地到点提醒（活动/通知）与桌面小组件。
 *
 * 另负责「绑定教务系统」：切到桌面 UA 打开教务登录页，登录完成后读出会话 Cookie 上报后端。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    /**
     * 门户根地址。字面量只留 Api.BASE 一份 —— 这里再抄一遍的话，两处一旦漂移，
     * 「这个页面是不是我们自己的」判定会安静地永远为假，也就是桥整个失效。
     */
    private val startUrl = Api.BASE

    /** 当前 WebView 主文档 URL，桥方法据此判断调用方是不是本应用页面 */
    @Volatile
    private var currentUrl: String? = null

    /** 是否允许下拉刷新（仅主页、无弹窗、且页面已置顶时允许；由页面内探针回传） */
    @Volatile
    private var pullRefreshReady = true

    /** 是否正处于「登录教务系统」流程中（此期间切换 UA、不注入探针） */
    private var academicLogin = false

    /** 上报 Cookie 期间避免重复触发 */
    private var bindingInProgress = false

    /**
     * 本次登录流程里是否**离开过教务主机**（去 CAS / 统一身份认证那几跳）。
     *
     * 「URL 落在教务域」不等于「用户已经登录」（issue #29）：流程第一步加载的就是 SCHOOL_ORIGIN
     * 本身，而 Cookie 罐里往往还留着上一次的会话 —— 只看 host 就会在第一页拿一份未认证的 Cookie
     * 去上报，后端拉不到课表，于是刚点「一键绑定」就弹「绑定失败」并把用户踢回门户。
     *
     * 登录链路是 authserver（CAS 登录页）→ workflow（中转）→ szjw（教务门户），前后两个主机不同，
     * 所以「离开过 szjw 又被送回来」是能观测到的事实。它只会漏判（同主机的登录页 → 不自动上报，
     * 用户按返回键放弃），不会误判成「已登录」—— 上报与否最终仍以后端能不能拉到数据为准。
     */
    private var leftSchoolHost = false

    /** WebView 原始 UA，教务登录结束后还原 */
    private var defaultUserAgent: String? = null

    /**
     * WebView 是否已经销毁过。
     * 渲染进程没了之后只剩 destroy() 还能用（见 onRenderProcessGone），
     * 那条路径会先把 WebView 释放掉，onDestroy 就别再碰第二次。
     */
    private var webViewReleased = false

    /**
     * 桥当前是不是挂在 WebView 上。让 syncBridgeMount 幂等用 —— 开关桥是跨进程的 WebView
     * 调用，不必在每次导航时无脑调一遍。
     * 初值 false：真正的挂载由 setupWebView 里的 syncBridgeMount(initialUrl()) 完成，
     * 这样「挂 / 摘」只有一处实现，两边不会各记一份状态。
     */
    private var bridgeAttached = false

    /**
     * 桥只服务本应用页面。
     * WebView 会导航到教务系统这类外部站点，而 addJavascriptInterface 挂上的对象
     * 在那些页面里同样可调用 —— 不校验的话，外部页面可以改本地 token、
     * 甚至触发教务绑定流程（拿到教务 Cookie 后上报到当前本地 token 名下）。
     *
     * **按主机名判，不要用 `url.startsWith(startUrl)`**（理由同 isSchoolUrl 那条注释）：
     * 前缀写法把「什么算本站」绑死在字面量的拼写上，不看协议、不看端口，也不看主机边界 ——
     * `https://class.qxwkstudio.top.evil.com` 只是恰好因为第 25 个字符是 `.` 而不是 `/`
     * 才没被放行，靠的是运气而不是规则。规则本身抽成了文件末尾的 isAppOrigin()，
     * 纯字符串比较、无安卓依赖，所以能在 JVM 单测里直接跑（见 AppOriginTest）。
     */
    private fun fromAppPage(): Boolean {
        val url = currentUrl ?: return false
        val u = Uri.parse(url)
        return isAppOrigin(u.scheme, u.host, u.port, portalHost)
    }

    /**
     * 把桥的挂载范围收窄到「当前文档是本站」—— 该挂就挂、该摘就摘（issue #28）。
     *
     * 为什么要摘，而不是只靠每个桥方法开头的 fromAppPage()：addJavascriptInterface 挂上的
     * 对象在整个 WebView 生命周期里都在，而这个 WebView 会跑到教务 / CAS 域（schoolHost）。
     * 那些页面上调 CAHost 只能被 fromAppPage() 在当时拦下 —— 而这个兜底的前提是
     * 「currentUrl 与正在执行的文档一致」，一旦出现重定向窗口或页面里塞的 iframe 就不成立。
     * 摘掉之后外部页面连这个对象都不存在，不再依赖任何运行时判断 —— 两层一起在。
     *
     * 只在 onPageStarted 里调用，**不要**挪进 shouldOverrideUrlLoading：那里返回 true 的分支
     * （交给系统浏览器的外链、weixin:// 这类）根本不会导航，当前文档还是我们自己那一页，
     * 在那儿摘就是「页面还在、桥没了」，而下一个 onPageStarted 之前没人补回来。
     * （后退 / 前进同样会走 onPageStarted —— 下拉刷新的那个转圈本来就依赖这一点，所以历史回退
     * 之后桥也会照常挂回来，不必额外挂 doUpdateVisitedHistory。）
     *
     * host 判定复用 isAppOrigin（AppOriginTest 钉的就是它），与 isExternalLink 的 inAppHosts
     * **故意不同**：那边对教务域要放宽子域（目标是「别把站内页面丢给系统浏览器」），这边决定的是
     * 「把桥交给谁」，只能收紧到主机精确相等。
     *
     * 已知边界：removeJavascriptInterface 只对**之后**加载的文档生效，不会把已注入进当前文档的
     * 对象撤销 —— 这恰好是本方法要的语义（它总在新文档开始前被调用），所以 fromAppPage() 那层
     * 不能省。
     */
    private fun syncBridgeMount(url: String?) {
        if (webViewReleased) return
        val target = url?.let { Uri.parse(it) }
        val isOurs = target != null && isAppOrigin(target.scheme, target.host, target.port, portalHost)
        if (isOurs == bridgeAttached) return
        binding.webView.apply {
            if (isOurs) addJavascriptInterface(HostBridge(), BRIDGE_NAME)
            else removeJavascriptInterface(BRIDGE_NAME)
        }
        bridgeAttached = isOurs
    }

    /** 页面与原生之间的 JS 桥（桥方法运行在非 UI 线程，操作 UI 需切回主线程） */
    private inner class HostBridge {

        @JavascriptInterface
        fun setPullRefreshReady(ready: Boolean) {
            if (!fromAppPage()) return
            pullRefreshReady = ready
        }

        /** 页面里的登录 token 变化时保存下来，并触发一次同步 */
        @JavascriptInterface
        fun setToken(token: String) {
            if (!fromAppPage()) return
            val ctx = applicationContext
            if (token.isBlank()) {
                // 网页里退出了登录：清本地会话，并取消闹钟、重绘小组件
                // （只清凭据的话，小组件会继续显示上一个账号的活动、旧闹钟也还留着）
                if (Store.token(ctx) != null) SyncRunner.logOutSession(ctx)
                return
            }
            if (token == Store.token(ctx)) return

            // 换了账号（不是换了 token）就先把上一个账号的本地数据清掉，再落新凭据。
            // 不清的话课表小组件会继续显示上一个账号的课、课程提醒按 ta 的课表响，
            // 断网时页面翻到的也是 ta 的通知（issue #64）。
            //
            // 为什么要按用户 id 判、而不是按 token 字符串判：同一个人重新登录也会拿到一条新的 JWT，
            // 按 token 判等于每次重新登录都把课表与离线缓存清空。
            // 而网页登录是直接覆盖 localStorage 里的 ca_token（app.js 的 saveSession），
            // 不会先走一次登出 —— 所以这条不是边角路径，换账号就是从这里进来的。
            val decoded = Api.decodeUser(token)
            if (SyncRunner.isAccountSwitch(Store.userId(ctx), decoded?.first)) {
                // 与登出共用同一套清理（见 SyncRunner.logOutSession 的注释）：
                // 它内部「先撤闹钟再清存储」的顺序不能反，反了闹钟就撤不掉、会继续按上一个账号的课表响
                SyncRunner.logOutSession(ctx)
            }

            Store.saveToken(ctx, token)
            if (decoded != null) Store.saveUser(ctx, decoded.first, decoded.second)
            Scheduler.ensurePeriodic(ctx)
            // 登录态变了：后台常驻服务该起了（它只在登录后才跑得动）
            BackgroundMode.apply(ctx)
            // 刚换了登录凭据，这一次必须真拉：不能让它被回前台的 60 秒节流挡掉
            Scheduler.syncNow(ctx, force = true)
        }

        /**
         * 网页当前是深色还是浅色（个人页「主题外观」选的，或选了「跟随系统」时系统自己变的）。
         *
         * 探针每拍读一次 `<html data-theme>` 上报，值没变就不会调到这里（见 PROBE_JS 的 reportTheme）。
         * 与鸿蒙端同一套契约（那边是 ThemeData.dark → SystemBar.apply）。
         *
         * 桥方法跑在非 UI 线程，动系统栏得切回主线程；顺手落盘，冷启动才能先按上，
         * 不必等这一路上报回来（见 onCreate 与 Store.themeDark）。
         */
        @JavascriptInterface
        fun setTheme(dark: Boolean) {
            if (!fromAppPage()) return
            Store.saveThemeDark(applicationContext, dark)
            runOnUiThread { applySystemBars(dark) }
        }

        /** 门户点「一键绑定教务系统」：打开教务登录页，登录完成后自动抓取 Cookie 上报 */
        @JavascriptInterface
        fun startAcademicLogin() {
            if (!fromAppPage()) return
            runOnUiThread { beginAcademicLogin() }
        }

        /**
         * 个人页「推送通知测试」：用最新一条真实活动 / 通知发一条本地通知，
         * 让用户自查推送是否可达、点通知能否跳到对应详情。kind 为 "activity" / "notice"。
         * 桥方法不在 UI 线程，这里同步发请求没问题（网页那边会先把按钮置灰）。
         */
        @JavascriptInterface
        fun testNotification(kind: String): String {
            if (!fromAppPage()) return ""
            return SyncRunner.pushTestNotification(applicationContext, kind)
        }

        /** 关于软件卡片显示的 App 版本号；网页版没有原生桥，拿不到会退回「网页版」 */
        @JavascriptInterface
        fun appVersion(): String {
            if (!fromAppPage()) return ""
            return BuildConfig.VERSION_NAME
        }

        /**
         * 网页据此读 version.json 里自己那段（android / harmony）。
         * 纯网页版没有这个桥，也就不会去读任何一段。
         */
        @JavascriptInterface
        fun platform(): String {
            if (!fromAppPage()) return ""
            return "android"
        }

        /**
         * 个人页「开发功能」那一行状态：本机通知开没开 + 上次同步时间。
         * 返回 JSON 字符串而不是两个布尔/长整型参数 —— 桥的返回值类型在各端解释不完全一致，
         * 字符串最稳，而且一次取回省掉一次桥调用。契约见 web/account.html 的 refreshAppStatus()：
         *   {"notifications":true,"lastSyncAt":1789300000000}
         * lastSyncAt 为 0 表示这台设备一次都没成功同步过（Store.lastSyncAt 由 SyncWorker 写入）。
         */
        @JavascriptInterface
        fun appStatus(): String {
            if (!fromAppPage()) return ""
            return JSONObject()
                .put("notifications", Notifier.notificationsEnabled(applicationContext))
                .put("lastSyncAt", Store.lastSyncAt(applicationContext))
                .toString()
        }

        /**
         * 个人页「课程提醒」卡片读设置。返回值同样是 JSON 字符串，理由见 appStatus。
         * 契约见 web/account.html 的 refreshCourseCard()：
         *   {"lead":15,"atStart":true,"courseCount":23}
         * courseCount 是给页面提示「本机还没同步到课表」用的 —— 用户打开了开关却什么都没发生，
         * 得能分辨是「今天没课」还是「本机根本没有课表数据」。
         */
        @JavascriptInterface
        fun courseReminderSettings(): String {
            if (!fromAppPage()) return ""
            return courseSettingsJson(applicationContext)
        }

        /**
         * 个人页改完设置：存下来并**立即重排**闹钟。
         * 不重排的话要等下一次后台同步（Doze 下可能几小时）才生效，用户会以为没保存上。
         */
        @JavascriptInterface
        fun saveCourseReminderSettings(lead: Int, atStart: Boolean): String {
            if (!fromAppPage()) return ""
            val ctx = applicationContext
            // 网页的下拉是可信来源，但桥是公开接口，这里仍按范围夹一次（0 = 不提前提醒）
            Store.setCourseRemindLead(ctx, lead.coerceIn(0, 120))
            Store.setCourseRemindAtStart(ctx, atStart)
            Scheduler.rescheduleCourseAlarms(ctx)
            return courseSettingsJson(ctx)
        }

        private fun courseSettingsJson(ctx: Context): String = JSONObject()
            .put("lead", Store.courseRemindLead(ctx))
            .put("atStart", Store.courseRemindAtStart(ctx))
            .put("courseCount", parseTimetableJson(Store.timetableJson(ctx))?.courses?.size ?: 0)
            .toString()

        /**
         * 个人页「后台通知」卡片读状态。契约见 web/account.html 的 refreshBackgroundCard()：
         *   {"enabled":true,"running":true,"ignoringBattery":false,"standbyBucket":"active"}
         *
         * 这几项都是**本机能如实回答的**，而且都是 AOSP 公开 API：
         *   ignoringBattery 有没有免电池优化 —— Doze 期间系统会挂起网络，它是唯一确定的豁免
         *   running         前台服务当前在不在跑
         *   standbyBucket   系统给这个应用定的待机档（active / working_set / frequent / rare / restricted），
         *                   越靠后越被压。它跨 ROM 通用，能解释「为什么最近收不到」
         * enabled 是用户自己在个人页的开关（存在本机，与账号无关）。
         *
         * 厂商的「自启动」**没有标准 API**，读不到 —— 所以那个值不在这里，页面上只能如实写
         * 「这一项我们看不到，需要你自己去设置里确认」。不瞎猜一个值显示给用户。
         */
        @JavascriptInterface
        fun backgroundStatus(): String {
            if (!fromAppPage()) return ""
            return backgroundStatusJson(applicationContext)
        }

        /** 改「后台常驻」开关：存下来并立刻启停服务。返回改完后的最新状态，页面直接用返回值刷新 */
        @JavascriptInterface
        fun setBackgroundAlwaysOn(enabled: Boolean): String {
            if (!fromAppPage()) return ""
            val ctx = applicationContext
            BackgroundMode.setEnabled(ctx, enabled)
            return backgroundStatusJson(ctx)
        }

        /** 申请免电池优化：弹系统标准窗。用户点「允许」之后由系统去改，我们下次读状态才看得到结果 */
        @JavascriptInterface
        fun requestIgnoreBatteryOptimizations() {
            if (!fromAppPage()) return
            runOnUiThread {
                val asked = startSettings(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                        .setData(Uri.parse("package:$packageName"))
                )
                // 少数 ROM 把这个弹窗去掉了：退到电池优化列表，让用户自己找
                if (!asked) openBatteryList()
            }
        }

        /** 打开系统的电池优化列表：用户拒了上面的弹窗、或想自己去找的时候用 */
        @JavascriptInterface
        fun openBatterySettings() {
            if (!fromAppPage()) return
            runOnUiThread { openBatteryList() }
        }

        /**
         * 打开 ROM 的「自启动 / 后台管理」页。逐个试各家的私有页面（见 BackgroundMode.AUTO_START_PAGES），
         * 一个都打不开就退到应用详情页 —— 那里至少有「电池」「权限」这些入口，用户自己也能找到。
         * 连应用详情页都打不开（理论上不该发生）才提示用户手动去，别点了没反应。
         */
        @JavascriptInterface
        fun openAutoStartSettings() {
            if (!fromAppPage()) return
            runOnUiThread {
                val opened = BackgroundMode.AUTO_START_PAGES.any { (pkg, cls) ->
                    startSettings(Intent().setComponent(ComponentName(pkg, cls)))
                }
                if (opened) return@runOnUiThread

                val fallback = startSettings(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:$packageName"))
                )
                if (!fallback) {
                    Toast.makeText(
                        this@MainActivity,
                        "没能打开系统设置，请手动到「设置 → 应用 → 班级助理」里找",
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }

        private fun openBatteryList() {
            startSettings(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }

        private fun backgroundStatusJson(ctx: Context): String = JSONObject()
            .put("enabled", BackgroundMode.isEnabled(ctx))
            .put("running", BackgroundSyncService.isRunning())
            .put("ignoringBattery", BackgroundMode.ignoringBatteryOptimizations(ctx))
            .put("standbyBucket", BackgroundMode.standbyBucket(ctx))
            .toString()
    }

    /** Android 13+ 发通知需要用户授权 */
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /**
     * 系统栏配色跟着**网页**走（issue #63）。
     *
     * 资源里那两套（`values/` 与 `values-night/`）跟随的是**系统**深浅色，而网页的主题是用户在
     * 个人页自选的 —— 两者可以相反，于是过去会出现「深色页面上压一条浅色系统栏」：一条亮带把
     * 页面顶部切开，顶部图标还跟底色撞在一起。
     *
     * 颜色直接复用那两个颜色资源（与 style.css 的底色变量同一个值），不另立一套；图标明暗走
     * androidx 的兼容层 —— 它自己处理 API 27 以下没有 `windowLightNavigationBar` 这件事，
     * 也省掉手写 `systemUiVisibility` 那套废弃位标志。
     */
    private fun applySystemBars(dark: Boolean) {
        val bg = ContextCompat.getColor(
            this,
            if (dark) R.color.window_bg_dark else R.color.window_bg_light
        )
        window.statusBarColor = bg
        window.navigationBarColor = bg
        WindowCompat.getInsetsController(window, binding.root).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        // 网页上次报的明暗先按上：不然冷启动会先按**系统**深浅色画出一帧，再被探针的第一份上报
        // 改过来 —— 用户看到的就是「自己选了深色、却先闪一下浅色」（issue #63 点名不许闪）。
        // 还没有缓存（首次安装）时维持资源那两套，等下面探针的首次上报来修正。
        Store.themeDark(this)?.let { applySystemBars(it) }
        setupWebView()

        Notifier.ensureChannels(this)
        requestNotificationPermission()
        // 上次已登录过：先把周期同步挂上，进入页面后探针会把 token 再确认一次
        if (Store.token(this) != null) {
            Scheduler.ensurePeriodic(this)
        }
        // 「后台常驻」的前台服务也在这里挂上 —— 这是它唯一 100% 可行的启动时机：
        // 应用可见时启动前台服务不受 Android 12+ 的后台启动限制，之后才轮到开机广播那些豁免时机
        BackgroundMode.apply(this)
        // 小组件的内容按**本地日期**算（今日活动 / 今日课程），而后台同步可能几小时没跑过。
        // 打开 App 是最可靠的一次「对表」机会：隔夜回来、跨了零点，都在这里把小组件刷成当天该有的样子。
        Scheduler.refreshWidgets(this)
        // 顺手把下一次零点刷新排上（重复排只是覆盖，不会堆）
        Scheduler.scheduleMidnightRefresh(this)
    }

    /**
     * 每次回到前台都同步一次（带 60 秒节流，见 Scheduler.syncNow）。
     *
     * 原来只在 onCreate 里同步：App 从后台切回来时 onCreate 不会再跑，于是会出现
     * 「用户明明打开着 App，新通知却还躺在服务端」。冷启动是 onCreate → onResume 紧挨着，
     * 所以这一处也覆盖了原来那次「打开就同步」。
     * 不会堆任务：syncNow 用的是唯一名 + KEEP，已经排着的那次不会被叠加。
     * 背景是周期任务在 Doze 下最坏要几小时才跑（见 ensurePeriodic），只靠它会让临近开始的活动漏提醒。
     *
     * 小组件也在这一处重绘一次：只写在 onCreate 里的话，从后台切回来（onCreate 不会再跑）
     * 且 syncNow 又被 60 秒节流挡住时，课表那张卡上的进度条就一动不动 —— 这正是
     * 「从卡片点进去也不一定更新」（issue #61）。重绘只读本地缓存，不联网、不排任务。
     */
    override fun onResume() {
        super.onResume()
        if (Store.token(this) != null) Scheduler.syncNow(this)
        Scheduler.refreshWidgets(this)
    }

    /**
     * App 已经在运行时点提醒通知：系统走 onNewIntent，onCreate 不会再执行，
     * 少了这一段就会「App 被拉到前台，但停在原来的页面，不跳那条活动/通知」。
     * setIntent 之后 getIntent()（以及 initialUrl()）才看得到这次的新 intent。
     *
     * 这条路能被走到，靠的是清单里的 `android:launchMode="singleTop"`：
     * 提醒的 PendingIntent 只带 FLAG_ACTIVITY_CLEAR_TOP，standard 模式下系统会把
     * 栈顶的实例销毁重建，onNewIntent 永远不执行（改回 standard 前先看一眼那里的注释）。
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // 教务登录中途点通知：不打断登录流程
        if (academicLogin) return
        // 只有带深链才跳。小组件的 PendingIntent 不带 extras，若不判断就会把用户
        // 正在看的页面重载回主页。
        if (intent.getStringExtra(Notifier.EXTRA_DEEP_LINK).isNullOrBlank()) return
        binding.webView.loadUrl(initialUrl())
    }

    /**
     * 退出时把 WebView 拆干净。
     *
     * MainActivity 是唯一页面，Activity finish 并不会让进程退出，所以不 destroy 的话，
     * 它拉起的渲染进程、以及挂在上面的 JS 桥会一直跟着进程留着 —— 反复进出就是一份份泄漏。
     */
    override fun onDestroy() {
        releaseWebView()
        super.onDestroy()
    }

    /**
     * 释放 WebView：先摘桥再 destroy，免得销毁过程中还有页面脚本回调进来。
     * 幂等 —— 渲染进程先没了的情况下（onRenderProcessGone）已经调用过一次。
     */
    private fun releaseWebView() {
        if (webViewReleased) return
        webViewReleased = true
        binding.webView.apply {
            stopLoading()
            removeJavascriptInterface(BRIDGE_NAME)
            destroy()
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        binding.webView.apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true          // localStorage：登录态持久化
            settings.databaseEnabled = true
            settings.loadsImagesAutomatically = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            // 多窗口默认就是关的，这行只是显式钉住：关着时 target="_blank"（以及 window.open）
            // 会被当成顶层导航、在当前 WebView 里打开，于是下面 shouldOverrideUrlLoading 里的
            // 外链判断能接住它、交给系统浏览器。真开了多窗口反而要 onCreateWindow，我们没实现，
            // 那就又变成点了没反应。
            // 只能写成 setXxx() 调用：WebSettings 没有 supportMultipleWindows 的 getter，
            // Kotlin 合成不出属性，写成 settings.supportMultipleWindows = false 编译不过。
            settings.setSupportMultipleWindows(false)

            // 首个文档必然是门户自己的（初始地址由 startUrl 派生），先按同一套判定挂上；
            // 之后离开本站 / 回到本站由 onPageStarted 里的 syncBridgeMount 负责摘与挂（issue #28）。
            // 挂 / 摘只有 syncBridgeMount 一处实现，别在这儿直接 add —— 那样状态会有两份。
            syncBridgeMount(initialUrl())

            webViewClient = object : WebViewClient() {
                /**
                 * 离线回退：本站 /api/ 的只读请求由 OfflineApi 接管（在线顺手存一份、断网给缓存）。
                 * 其余请求返回 null，交给 WebView 原样走网络 —— 这一层不碰页面与静态资源，
                 * 它们的离线能力由网页自己的 Service Worker 负责。
                 */
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? = OfflineApi.intercept(applicationContext, request) { key, json ->
                    // 「先回缓存」那一支的后半程：后台取到的新数据与缓存不同，推回页面重绘
                    pushApiUpdate(key, json)
                }

                // 站内与教务域留在 WebView，系统协议拦截，其余外链交给系统浏览器
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    val url = request.url
                    if (isSystemScheme(url)) {
                        // 拨号 / 短信 / 邮件：WebView 自己打不开这些协议，交给系统应用去接。
                        // 以前这里直接 return true 却什么都不做 —— 结果就是点了没反应。
                        openExternal(url)
                        return true
                    }
                    // 其余 WebView 打不开的协议（weixin:// / alipays:// / market:// / intent://…，
                    // 班级通知里真会出现的分享、缴费、应用市场链接）：return false 只会让点击**静默
                    // 无反应**，所以同样交给系统应用去接，接不住时 openExternal 会提示一句。
                    // 只管主框架——子框架里的第三方跳转不该把用户弹出去。
                    if (request.isForMainFrame && !isHandledByWebView(url)) {
                        openExternal(url)
                        return true
                    }
                    // 只管主框架（子框架里的第三方链接不该被踢到浏览器）；
                    // 教务登录期间一律不往外跳——认证过程会跨主机，跳走就把登录流程断了
                    if (!academicLogin && request.isForMainFrame && isExternalLink(url)) {
                        openExternal(url)
                        return true
                    }
                    return false
                }

                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                    // 桥的来源校验依赖这个值，必须在本页脚本执行之前更新
                    currentUrl = url
                    // 教务登录期间离开教务主机（去 CAS / 统一身份认证）就记一笔：
                    // onPageFinished 靠它区分「认证走完被送回来了」和「页面本来就停在教务域」
                    // （issue #29，见 leftSchoolHost 的注释）
                    if (academicLogin && url != null && !isSchoolUrl(url)) leftSchoolHost = true
                    // 同一时刻把桥的挂载范围收窄到这一份文档（issue #28）。onPageStarted 是主框架
                    // 「新文档开始」的那一刻，此时摘掉，接下来的文档就注入不到这个对象 —— 教务 /
                    // CAS 页面上拿到的不是「调了被拒」，而是根本没有 CAHost。
                    syncBridgeMount(url)
                    binding.swipeRefresh.isRefreshing = true
                    // 新文档开始：上一份文档的探针结论作废 —— pullRefreshReady 是「最后一份报告」
                    // 的缓存，不在这里复位就会从导航前一路带到导航后（issue #85）。教务登录期间
                    // 探针被刻意关掉（onPageFinished 的 academicLogin 分支不注入），所以进教务前
                    // 那份「学业视图 = 不可下拉」会一直缓存到回来之后，主页的下拉刷新就被它卡死。
                    // 本站页先恢复成可下拉，等探针注入后 250ms 内按真实页面状态纠正（主页本就该
                    // 可下拉，默认值几乎立即被覆盖）；教务等外部页直接禁用 —— 否则从主页进教务后
                    // 还停在 true，在教务页上下拉会误触发 reload()。
                    pullRefreshReady = url?.let {
                        isAppOrigin(Uri.parse(it).scheme, Uri.parse(it).host, Uri.parse(it).port, portalHost)
                    } ?: false
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    binding.swipeRefresh.isRefreshing = false
                    if (academicLogin) {
                        // 教务登录流程中：不能注入探针——探针在教务页找不到本应用 token 会回传空串，
                        // 把本地登录态清掉。
                        // 上报条件必须带上 leftSchoolHost：光看 host 会在点进来第一页就上报（issue #29，
                        // 见该字段的注释）。上报后立刻清掉它，用户在教务站里接着翻页时不会反复上报 ——
                        // 每次上报后端都要真去拉一次课表，不能每翻一页来一发。
                        if (url != null && isSchoolUrl(url) && leftSchoolHost) {
                            leftSchoolHost = false
                            uploadAcademicCookies(announceFailure = true)
                        }
                        return
                    }
                    // 安装滚动状态探针（脚本内部幂等，重复注入无副作用）
                    view.evaluateJavascript(PROBE_JS, null)
                }

                override fun onReceivedSslError(
                    view: WebView,
                    handler: SslErrorHandler,
                    error: SslError
                ) {
                    // 站点使用合法 HTTPS，不忽略证书错误
                    handler.cancel()
                }

                /**
                 * 渲染进程没了（系统回收内存，或者渲染进程自己崩了）。
                 *
                 * targetSdk ≥ 26 起，**不处理的话系统会直接结束整个应用进程** —— 表现就是
                 * 「用着用着闪退」，而且看不到自己的崩溃栈，只能在 logcat 里看到
                 * Render process gone。低内存机型切到后台再回来是最常见的触发场景。
                 *
                 * 两种情况都重建：官方文档对「系统回收内存而杀掉渲染进程」给的办法就是
                 * 「在前台重建一个新的 WebView」，而崩溃同样只能重建 —— 返回 false 等于把
                 * 应用进程交出去杀掉，这个 bug 就等于没修。
                 */
                override fun onRenderProcessGone(
                    view: WebView,
                    detail: RenderProcessGoneDetail?
                ): Boolean {
                    // didCrash() 是 API 26 才有的（这个回调本身也是 26 起才会被调到），
                    // 显式判断版本，别让 minSdk 24 的机器在 lint / 运行时上被卡住
                    val crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                        detail?.didCrash() == true
                    Log.w(TAG, "WebView 渲染进程没了（crashed=$crashed），重建界面")

                    if (isFinishing || isDestroyed) return true

                    // 这个 WebView 已经不可用了：必须从视图树摘掉并销毁，否则它会以
                    // 一片空白的样子留在界面上 —— 返回 true 之后系统不会再替我们清理。
                    // 只调 destroy()：摘桥 / 停加载这些留给正常路径，崩溃恢复这一层
                    // 自己再抛异常就等于恢复失败。
                    (view.parent as? ViewGroup)?.removeView(view)
                    webViewReleased = true
                    view.destroy()

                    Toast.makeText(applicationContext, "页面已重新加载", Toast.LENGTH_SHORT).show()
                    // 重建 Activity：新 WebView 由 onCreate 正常装配，页面回到首页重新加载
                    recreate()
                    return true
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    binding.progressBar.progress = newProgress
                    binding.progressBar.visibility =
                        if (newProgress >= 100) View.GONE else View.VISIBLE
                }
            }

            loadUrl(initialUrl())
        }

        // 只有「主页 + 无弹窗 + 已置顶」时才允许下拉刷新；其余情况把手势交还给页面滚动
        binding.swipeRefresh.setOnChildScrollUpCallback { _, _ -> !pullRefreshReady }
        binding.swipeRefresh.setOnRefreshListener { binding.webView.reload() }
    }

    /**
     * 把后台刷新到的新数据推回网页（原生离线层的 SWR 用，见 OfflineApi.refreshInBackground）。
     *
     * 页面在 app.js 里把 window.__caApiUpdated(key, json) 挂到 window 上，按 key（路径 + 查询串，
     * 与缓存键同一个字符串）找到自己那个渲染函数重绘。网页版没有这一步 —— 它本来就不经过这一层。
     *
     * evaluateJavascript 必须在 UI 线程调用，而调用方还在后台线程，所以在这里切过去。
     * JSONObject.quote 负责把 key 与整段 JSON 转成安全的 JS 字面量（里面有引号、换行、中文）。
     */
    internal fun pushApiUpdate(key: String, json: String) {
        runOnUiThread {
            binding.webView.evaluateJavascript(
                "window.__caApiUpdated&&window.__caApiUpdated(${JSONObject.quote(key)},${JSONObject.quote(json)})",
                null
            )
        }
    }

    /** 是否是 WebView 打不开、该交给系统应用处理的协议（拨号 / 短信 / 邮件） */
    private fun isSystemScheme(url: android.net.Uri): Boolean {
        val scheme = url.scheme?.lowercase() ?: return false
        return scheme == "tel" || scheme == "sms" || scheme == "mailto"
    }

    /**
     * 这些协议的导航由 WebView 自己处理，**不该往外抛**（抛给系统应用要么没人接，
     * 要么把页面内部的跳转误伤成「打开某个应用」）。
     * tel / sms / mailto 不在这里 —— 它们由上面 isSystemScheme 那一支单独接管。
     */
    private fun isHandledByWebView(url: Uri): Boolean {
        // 取不到协议（相对地址之类）时按「自己处理」算：本方法只用来决定「要不要丢给系统」，
        // 拿不准的时候不丢，比拿不准就丢安全
        val scheme = url.scheme?.lowercase() ?: return true
        return scheme in WEBVIEW_SCHEMES
    }

    /**
     * 是不是教务系统自己的页面。**按主机名判，不要用 `url.startsWith(SCHOOL_ORIGIN)`**：
     *   - 教务门户本身还提供 http（见 network_security_config.xml），登录跳回来可能落在
     *     `http://szjw.njau.edu.cn/…` 上：只比 `https://` 前缀会一直等不到 Cookie 上报，
     *     用户就卡在「桌面 UA + 教务页」里出不来，绑定也永远完不成；
     *   - 字符串前缀还会把 `https://szjw.njau.edu.cn.evil.com` 当成教务域。
     */
    private fun isSchoolUrl(url: String): Boolean =
        Uri.parse(url).host?.lowercase() == schoolHost

    /**
     * 交给系统应用打开：站外链接交给浏览器，tel / sms / mailto 交给各自的处理应用
     * （ACTION_VIEW 对这三种协议都能解析到对应应用，浏览器点这类链接也是这么做的）。
     * 外链里的 APK 也一样走这里 —— WebView 自己装不了应用。
     * 没有能处理的应用时给句提示，别静默无反应。
     */
    private fun openExternal(url: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "没有可以打开该链接的应用", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * 留在 WebView 里加载的主机（含子域）：门户自己 + 教务系统主机。
     * 只列具体主机，别自作聪明放宽到「顶级域」——按 takeLast(2) 取 szjw.njau.edu.cn 得到的是
     * edu.cn，那样任何 *.edu.cn 都会被当成站内。教务登录会跳到同域别的主机（认证页 / SSO），
     * 那边由 shouldOverrideUrlLoading 里的 academicLogin 判断兜住：登录流程中一律不往外跳。
     */
    private val inAppHosts: List<String> by lazy { listOfNotNull(portalHost, schoolHost) }

    /**
     * 门户主机名。从 startUrl 派生，比照下面 schoolHost 的写法 —— 导航判定（isExternalLink）
     * 与桥的来源校验（fromAppPage）用的是同一个 host，不必各自从 URL 里再切一遍。
     */
    private val portalHost: String? by lazy { Uri.parse(startUrl).host?.lowercase() }

    /**
     * 教务系统主机名。从 SCHOOL_ORIGIN 派生，**别在两处各写一份字面量** ——
     * 两处一旦不一致，「这段 URL 是不是教务页面」的判定会安静地永远为假。
     */
    private val schoolHost: String? by lazy { Uri.parse(SCHOOL_ORIGIN).host?.lowercase() }

    /** 是否属于「该交给系统浏览器打开」的外链：http(s)，且不在站内 / 教务域内 */
    private fun isExternalLink(url: Uri): Boolean {
        val scheme = url.scheme?.lowercase() ?: return false
        if (scheme != "http" && scheme != "https") return false
        val host = url.host?.lowercase() ?: return false
        return inAppHosts.none { host == it || host.endsWith(".$it") }
    }

    /**
     * 打开一个系统设置页。返回是否成功 —— 厂商页面不存在（那台机器没装对应应用、或厂商改了名）
     * 时返回 false，调用方（BackgroundMode.AUTO_START_PAGES 那张表）靠返回值继续试下一个。
     * 这里**不弹提示**：逐个试探时弹一串「打不开」比什么都不说更糟，最终兜底失败才由调用方提示。
     */
    private fun startSettings(intent: Intent): Boolean = try {
        startActivity(intent)
        true
    } catch (e: Exception) {
        false
    }

    /**
     * 启动地址：从提醒通知点进来时，intent 里带着要直达页面的深链（?view=…&id=…），
     * 直接落到那条通知 / 活动；没有深链就回主页。
     */
    private fun initialUrl(): String {
        val deep = intent?.getStringExtra(Notifier.EXTRA_DEEP_LINK)
        return if (deep.isNullOrBlank()) startUrl else "$startUrl/$deep"
    }

    /**
     * 进入教务系统登录：教务对手机 UA 有兼容问题（页面错乱），因此整个过程固定用桌面 UA。
     * 结束有两条路（都是「没成功就不结束」）：
     *   - 上报成功：`uploadAcademicCookies` 里落到课表页
     *   - 用户按返回键放弃：`onKeyDown` 里回门户
     * 另外开流程时先拿现有 Cookie 试一次，会话还有效就直接绑好，不必再登一遍（见下）。
     */
    private fun beginAcademicLogin() {
        if (academicLogin) return
        if (Store.token(this) == null) {
            Toast.makeText(this, "请先登录班级助理", Toast.LENGTH_SHORT).show()
            return
        }
        academicLogin = true
        bindingInProgress = false
        leftSchoolHost = false
        if (defaultUserAgent == null) defaultUserAgent = binding.webView.settings.userAgentString
        binding.webView.settings.userAgentString = DESKTOP_UA
        binding.webView.loadUrl(SCHOOL_ORIGIN)
        Toast.makeText(this, "请登录教务系统，登录完成后会自动返回", Toast.LENGTH_LONG).show()
        // 顺手拿现有 Cookie 试一次：教务会话还没过期的话（之前绑过、只是重装或换了设备）这一步
        // 就直接绑好了，用户不必白登一遍。失败**不提示** —— 用户马上要看到登录页，这时弹一句
        // 「绑定失败」正是 issue #29 里那个让人以为坏了的提示
        uploadAcademicCookies(announceFailure = false)
    }

    /**
     * 读取教务域下的会话 Cookie（含 HttpOnly），交给后端代拉课表与学分。
     *
     * @param announceFailure 失败时要不要弹提示。进流程时那一次是「顺手试试」，没成也不必说
     *   （见 beginAcademicLogin）；走完 CAS 又被送回教务之后失败，才是真出了问题 —— 账号都认了，
     *   后端却仍拉不到数据，这时候得让用户知道。
     */
    private fun uploadAcademicCookies(announceFailure: Boolean) {
        if (bindingInProgress) return
        val cookies = CookieManager.getInstance().getCookie(SCHOOL_ORIGIN)
        if (cookies.isNullOrBlank()) return
        val token = Store.token(this) ?: return
        bindingInProgress = true

        Thread {
            val body = JSONObject().put("cookies", cookies)
            val res = Api.postJson("/api/academic/bind", token, body)
            val parsed = (res as? Api.Res.Ok)?.body
            val ok = parsed?.optBoolean("success") == true
            val message = when {
                ok -> "教务系统绑定成功"
                parsed != null -> parsed.optString("error").takeIf { it.isNotBlank() } ?: "绑定失败，请重试"
                res is Api.Res.Unauthorized -> "登录态已失效，请重新登录"
                else -> "网络异常，绑定失败"
            }
            runOnUiThread {
                if (ok) {
                    Toast.makeText(this, message, Toast.LENGTH_LONG).show()
                    finishAcademicLogin(true)
                    return@runOnUiThread
                }
                // 失败**不能结束流程**（issue #29）：用户很可能还停在教务登录页上，把他踢回门户
                // 就变成「点一下、什么都没做、直接失败」。留在教务页继续等下一次上报（重新登录会
                // 再绕一遍 CAS，leftSchoolHost 会重新置位），想放弃就按返回键。
                // 后端是「校验通过才落库」（academicHandler 的 bindWithCookies），所以这次失败不会
                // 覆盖掉原有的绑定。
                bindingInProgress = false
                if (announceFailure) Toast.makeText(this, message, Toast.LENGTH_LONG).show()
            }
        }.start()
    }

    /**
     * 结束教务登录流程：还原 UA 并回到门户（成功则直接落到课表页）。
     *
     * 只有两处调用：上报成功后（`success = true`）与用户按返回键放弃（`false`）。
     * **上报失败不进这里** —— 失败就留在教务页继续等（issue #29），这条是那个 bug 的底线：
     * 只要失败还能走到这里，用户就会看到「点一下、什么都没做、直接失败」。
     */
    private fun finishAcademicLogin(success: Boolean) {
        academicLogin = false
        bindingInProgress = false
        defaultUserAgent?.let { binding.webView.settings.userAgentString = it }
        binding.webView.loadUrl(if (success) "$startUrl/?view=academic" else startUrl)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // 教务登录中途返回 = 放弃绑定，直接回门户（也是 issue #29 之后唯一的退出口：
            // 没走完 CAS 就不会自动上报，用户想不绑了就从这里走）
            if (academicLogin) {
                finishAcademicLogin(false)
                return true
            }
            if (binding.webView.canGoBack()) {
                binding.webView.goBack()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    private companion object {
        /** 日志标签，与其它模块的 CAApi / CABackground / CAOffline 同一套命名 */
        const val TAG = "CAMain"

        /**
         * JS 桥挂在页面里的对象名，加桥 / 摘桥两处共用。
         * 注意 PROBE_JS 里是按字面量 `CAHost.xxx` 调的（JS 那边插值不进来），改名要一起改。
         */
        const val BRIDGE_NAME = "CAHost"

        /** 教务系统源（服务端代理与 Cookie 归属域） */
        const val SCHOOL_ORIGIN = "https://szjw.njau.edu.cn"

        /**
         * 由 WebView 自己处理的协议清单（见 isHandledByWebView）：
         * 前两个是页面本身，其余是页面内部资源 —— 这些都不能往外抛给系统应用。
         */
        val WEBVIEW_SCHEMES = setOf(
            "http", "https",
            "about", "data", "blob", "file", "javascript", "content"
        )

        /** 教务系统对手机 UA 兼容有问题，登录流程统一用桌面 UA */
        const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"

        /**
         * 页面探针：每 250ms 探一次，通过 CAHost 桥把三件事回传给原生层 ——
         *   1. 是否允许下拉刷新（见下）
         *   2. localStorage 里的登录 token（要扫一遍存储，代价高，所以每 8 拍才做一次）
         *   3. 页面当前是深色还是浅色（只读一个属性，很便宜，所以每拍都做）
         *
         * 下拉刷新这一项单说：站点是「固定外壳 + 内层 .app-view 滚动」，子页面又跑在同源 iframe 里，
         * 因此 webView.scrollY 恒为 0，无法直接判断是否在顶部 —— 只能在页面里周期性探测滚动位置，
         * 且只有「主页 + 无弹窗 + 已置顶」才判为可下拉刷新。
         *
         * 与鸿蒙端的 ProbeJs.ets 是同一份探针（只差主题那一项的实现，见 reportTheme 的注释）。
         */
        val PROBE_JS = """
            (function () {
              if (window.__caTopProbe) return;
              window.__caTopProbe = true;
              function atTop(doc) {
                try {
                  var s = doc.scrollingElement || doc.documentElement;
                  if (s && s.scrollTop > 0) return false;
                } catch (e) {}
                return true;
              }
              // 是否停在「主页」视图（下拉刷新只保留给主页）。
              // 显隐读 hidden 属性：网页那边统一改过（见 index.js 的 switchView），
              // 内联样式已不再写 —— 再去读内联样式恒为空串，「在不在主页」就永远为真。
              function onHome() {
                var h = document.getElementById('homeView');
                return !!h && !h.hidden;
              }
              // 是否有弹窗打开（.modal-overlay 关闭时 display:none，尺寸为 0）
              function modalOpen(doc) {
                try {
                  var o = doc.querySelectorAll('.modal-overlay');
                  for (var i = 0; i < o.length; i++) {
                    if (o[i].offsetWidth > 0 || o[i].offsetHeight > 0) return true;
                  }
                } catch (e) {}
                return false;
              }
              function probe() {
                var ok = atTop(document) && onHome() && !modalOpen(document);
                if (ok) {
                  var views = document.querySelectorAll('.app-view');
                  for (var v = 0; v < views.length; v++) {
                    var el = views[v];
                    if (!el || el.offsetParent === null) continue;
                    if (el.scrollTop > 0) { ok = false; break; }
                  }
                }
                if (ok) {
                  var frames = document.querySelectorAll('.app-frame');
                  for (var i = 0; i < frames.length; i++) {
                    var f = frames[i];
                    if (!f || f.hidden) continue;
                    try {
                      if (f.contentDocument && !atTop(f.contentDocument)) { ok = false; break; }
                    } catch (e) {}
                  }
                }
                try { CAHost.setPullRefreshReady(ok); } catch (e) {}
                reportTheme();
                if (++tick % 8 === 0) reportToken();
              }
              var tick = 0;
              var lastToken = null;
              var lastDark = null;
              // 登录凭据只存在网页的 localStorage 里，键固定为 ca_token（web/assets/js/app.js 的
              // LS_TOKEN / saveSession）。**只认这一个键，不遍历其它键去猜**：页面里可能有第三方
              // 脚本 / 调试时留下的其它 JWT，扫到就会被原生当成登录凭据落库，同步 401 后按 #64
              // 把本地会话与缓存清掉 —— 表现为「明明还登录着，后台提醒却永久失效」（issue #81）。
              function looksLikeJwt(v) {
                return typeof v === 'string' && v.length > 40 && v.split('.').length === 3;
              }
              function readToken() {
                try {
                  var t = localStorage.getItem('ca_token');
                  if (t && looksLikeJwt(t)) return t;
                } catch (e) {}
                return '';
              }
              function reportToken() {
                var t = readToken();
                if (t === lastToken) return;
                lastToken = t;
                try { CAHost.setToken(t); } catch (e) {}
              }
              // 页面当前是深色还是浅色（系统栏配色用，见 setTheme）。
              // 读 <html data-theme> 而不是像鸿蒙端那样按底色亮度算：theme.js 在首帧绘制前就把它
              // 写成 'dark' / 'light'（选「跟随系统」时也已经在那边解析成具体值），个人页切主题时
              // 还会直接同步到父窗口这一份（account.js 的 applyTheme）—— 读属性既准又便宜，所以每拍
              // 都报，不像 token 那样要扫 localStorage、只能每 8 拍一次。
              // 属性不在时（页面没加载 theme.js）干脆不报：宁可维持现状，也不猜一个值糊上去。
              function reportTheme() {
                var attr = document.documentElement.getAttribute('data-theme');
                if (attr !== 'dark' && attr !== 'light') return;
                var d = attr === 'dark';
                if (d === lastDark) return;
                lastDark = d;
                try { CAHost.setTheme(d); } catch (e) {}
              }
              setInterval(probe, 250);
              probe();
              reportToken();
            })();
        """.trimIndent()
    }
}

/**
 * 「这个地址算不算门户自己」—— 桥的来源校验规则（issue #28）。
 *
 * 为什么单独抽成一个纯函数：安卓侧没有 Robolectric，单测里一碰 android.net.Uri 就抛
 * 「Method parse in android.net.Uri not mocked」，所以私有方法的判定逻辑根本测不到，
 * 只能像 ReleaseShrinkTest 那样去读源码文本、钉形状。这里把规则做成只吃三个基础类型的函数，
 * 解析仍交给平台（调用方用 Uri.parse，与 isSchoolUrl 同一套），于是规则本身可以真正被单测执行。
 *
 * 三条都必须满足，缺一条就是「另一个来源」：
 *   - **https**：门户只有 https。放行 http 等于允许一次明文降级就把桥拿到手 —— 教务那边确实
 *     有 http 页面（见 isSchoolUrl 的注释），所以这条不能靠「反正没人用 http」混过去；
 *   - **主机精确相等**：不做子域放宽。子域可能由别的内容托管，桥只服务门户自己
 *     （对比 isExternalLink 对教务域反而要放宽子域 —— 那里的目标是「别把站内丢给浏览器」，
 *     方向相反，所以两处的口径本来就该不同，别为了「统一」把它们合并）；
 *   - **默认端口**：同源策略里 scheme + host + port 才算一个 origin，非默认端口是另一个来源。
 *
 * @param scheme 访问协议（Uri.scheme，可能为 null）
 * @param host   主机名（Uri.host，可能为 null；大小写不敏感）
 * @param port   端口（Uri.port，未显式写时为 -1）
 * @param siteHost 门户主机名（见 MainActivity.portalHost）
 */
internal fun isAppOrigin(scheme: String?, host: String?, port: Int, siteHost: String?): Boolean {
    if (siteHost.isNullOrEmpty()) return false
    return scheme.equals("https", ignoreCase = true) &&
        host.equals(siteHost, ignoreCase = true) &&
        (port == -1 || port == 443)
}
