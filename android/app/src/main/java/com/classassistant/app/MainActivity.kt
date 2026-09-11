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

    /** 网页当前是否已滚到顶部（由页面内探针回传，供下拉刷新判断） */
    @Volatile
    private var scrollAtTop = true

    /** 是否正处于「登录教务系统」流程中（此期间切换 UA、不注入探针） */
    private var academicLogin = false

    /** 上报 Cookie 期间避免重复触发 */
    private var bindingInProgress = false

    /** WebView 原始 UA，教务登录结束后还原 */
    private var defaultUserAgent: String? = null

    /** 页面与原生之间的 JS 桥（桥方法运行在非 UI 线程，操作 UI 需切回主线程） */
    private inner class HostBridge {

        @JavascriptInterface
        fun setScrollAtTop(atTop: Boolean) {
            scrollAtTop = atTop
        }

        /** 页面里的登录 token 变化时保存下来，并触发一次同步 */
        @JavascriptInterface
        fun setToken(token: String) {
            val ctx = applicationContext
            if (token.isBlank()) {
                // 网页里退出了登录，本地也清掉，避免继续用旧身份提醒
                if (Store.token(ctx) != null) Store.clearSession(ctx)
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
            runOnUiThread { beginAcademicLogin() }
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
        if (Store.token(this) != null) Scheduler.ensurePeriodic(this)
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
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.loadsImagesAutomatically = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true

            addJavascriptInterface(HostBridge(), HOST_BRIDGE)

            webViewClient = object : WebViewClient() {
                // 仅允许站内/同源链接，拦截系统协议
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    val url = request.url
                    if (isSystemScheme(url)) return true
                    // 非白名单域名不在带 JS 桥的 WebView 里打开
                    return !isAllowedUrl(url)
                }

                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
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

            loadUrl(startUrl)
        }

        // 只有页面真的在顶部时，下拉才触发刷新；否则把手势交还给页面滚动
        binding.swipeRefresh.setOnChildScrollUpCallback { _, _ -> !scrollAtTop }
        binding.swipeRefresh.setOnRefreshListener { binding.webView.reload() }
    }

    /** 拦截系统协议（拨号/短信/邮件等），避免 WebView 无法打开 */
    private fun isSystemScheme(url: android.net.Uri): Boolean {
        val scheme = url.scheme?.lowercase() ?: return false
        return scheme == "tel" || scheme == "sms" || scheme == "mailto"
    }

    /** 门户页只放行自己的站点；教务登录流程额外放行南农域名 */
    private fun isAllowedUrl(url: android.net.Uri): Boolean {
        val scheme = url.scheme?.lowercase() ?: return false
        if (scheme != "https") return false
        val host = url.host?.lowercase() ?: return false
        if (host == PORTAL_HOST) return true
        if (!academicLogin) return false
        return host == SCHOOL_HOST || host.endsWith(".njau.edu.cn")
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
        // 教务域不要暴露 CAHost，避免统一身份认证页面能改门户 token
        binding.webView.removeJavascriptInterface(HOST_BRIDGE)
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
            val ok = res?.optBoolean("success") == true
            val message = when {
                ok -> "教务系统绑定成功"
                res != null -> res.optString("error").takeIf { it.isNotBlank() } ?: "绑定失败，请重试"
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
        binding.webView.addJavascriptInterface(HostBridge(), HOST_BRIDGE)
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
        const val HOST_BRIDGE = "CAHost"
        const val PORTAL_HOST = "class.qxwkstudio.top"
        const val SCHOOL_HOST = "szjw.njau.edu.cn"

        /** 教务系统源（服务端代理与 Cookie 归属域） */
        const val SCHOOL_ORIGIN = "https://szjw.njau.edu.cn"

        /** 教务系统对手机 UA 兼容有问题，登录流程统一用桌面 UA */
        const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"

        /**
         * 滚动状态探针。
         * 站点是「固定外壳 + 内层 .app-view 滚动」，子页面又跑在同源 iframe 里，
         * 因此 webView.scrollY 恒为 0，无法直接判断是否在顶部。
         * 这里在页面内周期性探测真实滚动位置，通过 CAHost 桥回传给原生层。
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
              function probe() {
                var ok = atTop(document);
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
                try { CAHost.setScrollAtTop(ok); } catch (e) {}
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
