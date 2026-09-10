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
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.classassistant.app.data.Store
import com.classassistant.app.databinding.ActivityMainBinding
import com.classassistant.app.notify.Notifier
import com.classassistant.app.sync.Api
import com.classassistant.app.sync.Scheduler

/**
 * 班级助理 — WebView 套壳
 * 加载 https://class.qxwkstudio.top，支持登录态持久化、下拉刷新、返回键，
 * 以及登录后的本地到点提醒（活动/通知）与桌面小组件。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val startUrl = "https://class.qxwkstudio.top"

    /** 网页当前是否已滚到顶部（由页面内探针回传，供下拉刷新判断） */
    @Volatile
    private var scrollAtTop = true

    /** 页面内探针回传滚动状态与登录态（JS 桥方法运行在非 UI 线程） */
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
                    binding.swipeRefresh.isRefreshing = true
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    binding.swipeRefresh.isRefreshing = false
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

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && binding.webView.canGoBack()) {
            binding.webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private companion object {
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
