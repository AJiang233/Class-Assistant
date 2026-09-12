package com.classassistant.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.classassistant.app.data.Store
import com.classassistant.app.databinding.ActivityMainBinding
import com.classassistant.app.notify.Notifier
import com.classassistant.app.sync.Api
import com.classassistant.app.sync.Scheduler
import com.classassistant.app.sync.SyncWorker
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
    private val startUrl = "https://class.qxwkstudio.top"

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

    /** WebView 原始 UA，教务登录结束后还原 */
    private var defaultUserAgent: String? = null

    /**
     * 桥只服务本应用页面。
     * WebView 会导航到教务系统这类外部站点，而 addJavascriptInterface 挂上的对象
     * 在那些页面里同样可调用 —— 不校验的话，外部页面可以改本地 token、
     * 甚至触发教务绑定流程（拿到教务 Cookie 后上报到当前本地 token 名下）。
     */
    private fun fromAppPage(): Boolean {
        val url = currentUrl ?: return false
        return url == startUrl ||
            url.startsWith("$startUrl/") ||
            url.startsWith("$startUrl?") ||
            url.startsWith("$startUrl#")
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
                if (Store.token(ctx) != null) SyncWorker.logOutSession(ctx)
                return
            }
            if (token == Store.token(ctx)) return
            Store.saveToken(ctx, token)
            Api.decodeUser(token)?.let { Store.saveUser(ctx, it.first, it.second) }
            Scheduler.ensurePeriodic(ctx)
            Scheduler.syncNow(ctx)
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
            return SyncWorker.pushTestNotification(applicationContext, kind)
        }

        /** 关于软件卡片显示的 App 版本号；网页版没有原生桥，拿不到会退回「网页版」 */
        @JavascriptInterface
        fun appVersion(): String {
            if (!fromAppPage()) return ""
            return BuildConfig.VERSION_NAME
        }
    }

    /** Android 13+ 发通知需要用户授权 */
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setupWebView()

        Notifier.ensureChannels(this)
        requestNotificationPermission()
        // 上次已登录过：先把周期同步挂上，进入页面后探针会把 token 再确认一次
        if (Store.token(this) != null) {
            Scheduler.ensurePeriodic(this)
            // 打开就同步一次：周期任务在 Doze 下最坏要几小时才跑，只靠它会让临近开始的活动漏提醒
            Scheduler.syncNow(this)
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

            addJavascriptInterface(HostBridge(), "CAHost")

            webViewClient = object : WebViewClient() {
                // 仅允许站内/同源链接，拦截系统协议
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    val url = request.url
                    return isSystemScheme(url)
                }

                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                    // 桥的来源校验依赖这个值，必须在本页脚本执行之前更新
                    currentUrl = url
                    binding.swipeRefresh.isRefreshing = true
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    binding.swipeRefresh.isRefreshing = false
                    if (academicLogin) {
                        // 教务登录流程中：回到教务域即视为登录完成，读取 Cookie 上报；
                        // 且不能注入探针——探针在教务页找不到本应用 token 会回传空串，把本地登录态清掉
                        if (url != null && url.startsWith(SCHOOL_ORIGIN)) uploadAcademicCookies()
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

    /** 拦截系统协议（拨号/短信/邮件等），避免 WebView 无法打开 */
    private fun isSystemScheme(url: android.net.Uri): Boolean {
        val scheme = url.scheme?.lowercase() ?: return false
        return scheme == "tel" || scheme == "sms" || scheme == "mailto"
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
     * 登录成功后由 onPageFinished 触发 Cookie 上报，再回到门户。
     */
    private fun beginAcademicLogin() {
        if (academicLogin) return
        if (Store.token(this) == null) {
            Toast.makeText(this, "请先登录班级助理", Toast.LENGTH_SHORT).show()
            return
        }
        academicLogin = true
        bindingInProgress = false
        if (defaultUserAgent == null) defaultUserAgent = binding.webView.settings.userAgentString
        binding.webView.settings.userAgentString = DESKTOP_UA
        binding.webView.loadUrl(SCHOOL_ORIGIN)
        Toast.makeText(this, "请登录教务系统，登录完成后会自动返回", Toast.LENGTH_LONG).show()
    }

    /** 读取教务域下的会话 Cookie（含 HttpOnly），交给后端代拉课表与学分 */
    private fun uploadAcademicCookies() {
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
                res is Api.Res.Unauthorized -> "登录已过期，请重新登录后再绑定"
                else -> "网络异常，绑定失败"
            }
            runOnUiThread {
                Toast.makeText(this, message, Toast.LENGTH_LONG).show()
                finishAcademicLogin(ok)
            }
        }.start()
    }

    /** 结束教务登录流程：还原 UA 并回到门户（成功则直接落到课表页） */
    private fun finishAcademicLogin(success: Boolean) {
        academicLogin = false
        bindingInProgress = false
        defaultUserAgent?.let { binding.webView.settings.userAgentString = it }
        binding.webView.loadUrl(if (success) "$startUrl/?view=academic" else startUrl)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // 教务登录中途返回 = 放弃绑定，直接回门户
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
        /** 教务系统源（服务端代理与 Cookie 归属域） */
        const val SCHOOL_ORIGIN = "https://szjw.njau.edu.cn"

        /** 教务系统对手机 UA 兼容有问题，登录流程统一用桌面 UA */
        const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"

        /**
         * 下拉刷新探针。
         * 站点是「固定外壳 + 内层 .app-view 滚动」，子页面又跑在同源 iframe 里，
         * 因此 webView.scrollY 恒为 0，无法直接判断是否在顶部。
         * 这里在页面内周期性探测真实滚动位置，通过 CAHost 桥回传给原生层；
         * 且只有「主页 + 无弹窗 + 已置顶」才判为可下拉刷新。
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
              // 是否停在「主页」视图（下拉刷新只保留给主页）
              function onHome() {
                var h = document.getElementById('homeView');
                return !!h && h.style.display !== 'none';
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
                    if (!f || f.style.display === 'none') continue;
                    try {
                      if (f.contentDocument && !atTop(f.contentDocument)) { ok = false; break; }
                    } catch (e) {}
                  }
                }
                try { CAHost.setPullRefreshReady(ok); } catch (e) {}
                if (++tick % 8 === 0) reportToken();
              }
              var tick = 0;
              var lastToken = null;
              // 登录凭据只存在网页的 localStorage 里，这里按常见键名取，并兜底扫描
              function looksLikeJwt(v) {
                return typeof v === 'string' && v.length > 40 && v.split('.').length === 3;
              }
              function readToken() {
                try {
                  var known = ['ca_token', 'token', 'jwt', 'auth_token'];
                  for (var k = 0; k < known.length; k++) {
                    var kv = localStorage.getItem(known[k]);
                    if (kv && looksLikeJwt(kv)) return kv;
                  }
                  var keys = Object.keys(localStorage);
                  for (var i = 0; i < keys.length; i++) {
                    var v = localStorage.getItem(keys[i]);
                    if (v && looksLikeJwt(v)) return v;
                  }
                } catch (e) {}
                return '';
              }
              function reportToken() {
                var t = readToken();
                if (t === lastToken) return;
                lastToken = t;
                try { CAHost.setToken(t); } catch (e) {}
              }
              setInterval(probe, 250);
              probe();
              reportToken();
            })();
        """.trimIndent()
    }
}
