package com.classassistant.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 中国大学MOOC 登录小窗（方案 A：App 内打开 icourse163 真实登录页，原生抓 Cookie 交回网页）。
 *
 * 和学习通小窗一样，两侧全靠字面量对齐 —— 桥方法名、回调名、Cookie 名一改就是静默失效：
 * 按钮点了没反应、或者绑到一份空 Cookie，但不会有任何报错。这里读源码钉形状
 * （本模块没有 Robolectric，跑不起真 WebView，同 ChaoxingBindTest）。
 */
class MoocBindTest {

    private val main: String =
        moduleFile("src/main/java/com/classassistant/app/MainActivity.kt").readText()

    private val cookieJar: String =
        moduleFile("src/main/java/com/classassistant/app/MoocCookieJar.kt").readText()

    /** MOOC 小窗那一段（从分隔注释到 onKeyDown 之前） */
    private val mooc: String =
        main.substringAfter("===== 中国大学MOOC 登录小窗 =====")
            .substringBefore("override fun onKeyDown")

    @Test
    fun `桥上有 startMoocLogin，且只在 App 页面内可用`() {
        assertTrue(
            "HostBridge 里没有 @JavascriptInterface fun startMoocLogin()：" +
                "网页的「App 内登录」会静默失效",
            Regex("""@JavascriptInterface\s+fun\s+startMoocLogin\(\)""").containsMatchIn(main)
        )
        val body = main.substringAfter("fun startMoocLogin()").take(300)
        assertTrue(
            "startMoocLogin 没先校验 fromAppPage()：外部页面也能拉起登录小窗",
            body.contains("if (!fromAppPage()) return")
        )
        assertTrue(
            "startMoocLogin 没切到 UI 线程开窗",
            body.contains("runOnUiThread")
        )
        assertTrue("没有 showMoocLogin 实现", main.contains("private fun showMoocLogin()"))
    }

    @Test
    fun `小窗用独立 WebView，icourse163 登录链路按桌面环境渲染`() {
        assertTrue("没解析出 MOOC 小窗代码段，分隔注释要跟着代码走", mooc.isNotBlank())
        assertTrue(
            "小窗没开独立 WebView（找不到 webViewClient 或 loadUrl(MOOC_LOGIN_URL)）",
            mooc.contains("webViewClient") && mooc.contains("MOOC_LOGIN_URL")
        )
        assertTrue(
            "登录入口不是 www.icourse163.org/member/login.htm",
            main.contains("MOOC_LOGIN_URL = \"https://www.icourse163.org/member/login.htm\"")
        )
        assertTrue(
            "小窗没设桌面 UA / 第三方 Cookie：登录表单在 reg.icourse163.org 的跨域 iframe 里，" +
                "不接第三方 Cookie 会「登录完还是游客」",
            mooc.contains("userAgentString = DESKTOP_UA") &&
                mooc.contains("setAcceptThirdPartyCookies")
        )
        assertTrue(
            "小窗没打开 useWideViewPort / loadWithOverviewMode：icourse163 登录页没有 viewport，" +
                "会被裁成左边一块",
            mooc.contains("useWideViewPort = true") &&
                mooc.contains("loadWithOverviewMode = true")
        )
        assertTrue(
            "小窗不允许双指缩放：页面被裁时用户没有兜底手段",
            mooc.contains("setSupportZoom(true)") && mooc.contains("builtInZoomControls = true")
        )
    }

    @Test
    fun `Cookie 判据同时要 NTESSTUDYSI 与 STUDY_INFO，汇总 www 优先并丢掉主机级会话`() {
        assertTrue(
            "没从 MoocCookieJar 汇总 Cookie：只读 www 会丢掉 reg 下发的登录临时凭据",
            mooc.contains("MoocCookieJar.merge(MoocCookieJar.ORIGINS.map")
        )
        assertTrue(
            "没检查 NTESSTUDYSI：它是所有 /web/j/*.rpc 的 csrfKey，没有它服务端一个请求都发不出去",
            cookieJar.contains("NTESSTUDYSI=") && mooc.contains("MoocCookieJar.hasLogin")
        )
        assertTrue(
            "登录判据没要求 STUDY_INFO：访客也拿得到 NTESSTUDYSI，小窗一打开就会误判成功",
            cookieJar.contains("STUDY_INFO") && cookieJar.contains("fun hasLogin")
        )
        // 三个来源都要在，且 www 必须排第一（csrfKey 取的是 www 那份）
        assertTrue(
            "Cookie 汇总没包含 reg.icourse163.org：登录表单所在的跨域页",
            cookieJar.contains("\"https://reg.icourse163.org\"")
        )
        assertTrue(
            "Cookie 汇总没包含 m.icourse163.org：扫码登录可能落在这里",
            cookieJar.contains("\"https://m.icourse163.org\"")
        )
        assertTrue(
            "www.icourse163.org 没排在 Cookie 来源第一位：NTESSTUDYSI 可能取到别的子域那份",
            cookieJar.indexOf("\"https://www.icourse163.org\"") <
                cookieJar.indexOf("\"https://reg.icourse163.org\"")
        )
        assertTrue(
            "主机级会话 Cookie 没跨来源丢弃（JSESSIONID / route 不能搬到别的子域）",
            cookieJar.contains("JSESSIONID") && cookieJar.contains("index > 0")
        )
    }

    @Test
    fun `登录页上的旧 Cookie 不会触发自动完成`() {
        assertTrue(
            "没记下打开小窗时的身份基线：罐里遗留的旧会话会被当成这次登录并自动绑定",
            mooc.contains("initialIdentityKey")
        )
        assertTrue(
            "身份基线不是从 MoocCookieJar.identityOf 取的（NTESSTUDYSI 访客也有，不能当身份）",
            mooc.contains("MoocCookieJar.identityOf(moocCookie())?.key")
        )
        assertTrue(
            "refreshMoocLoginState 没先解析 Identity",
            mooc.contains("val identity = MoocCookieJar.identityOf(cookie) ?: return")
        )
        assertTrue(
            "旧会话没有「只提示、不自动完成」的分支",
            mooc.contains("identity.key == moocState.initialIdentityKey") &&
                mooc.contains("alreadySignedInHinted")
        )
        assertTrue(
            "旧会话提示里没告诉用户当前账号 / 怎么换号：用户无法判断是不是自己的账号",
            mooc.contains("当前已登录：") && mooc.contains("退出登录")
        )
        assertFalse(
            "isMoocLoginPage 应随新判据删除：匿名登录页没有 STUDY_INFO，不再需要按 URL 排除（留着是死代码）",
            main.contains("isMoocLoginPage")
        )
        assertTrue(
            "登录判据退回了只认 NTESSTUDYSI：访客 Cookie 会再次触发 1.4.5 的误判",
            cookieJar.contains("STUDY_INFO") && cookieJar.contains("identityOf")
        )
    }

    @Test
    fun `iframe 里的登录靠轮询兜底，关窗清掉定时器`() {
        assertTrue(
            "没有登录态轮询（MOOC_POLL_MS）：登录表单在跨域 iframe 里，" +
                "iframe 内部的跳转不触发主框架 onPageFinished，登录完小窗会没反应",
            mooc.contains("MOOC_POLL_MS") && mooc.contains("postDelayed")
        )
        assertTrue(
            "dismiss 里没 removeCallbacksAndMessages：轮询会跟着已销毁的 WebView 一直跑",
            mooc.contains("removeCallbacksAndMessages")
        )
    }

    @Test
    fun `成功和取消都只回调一次，回调名与 iframe 兜底都在`() {
        assertTrue("没有成功回调 __caMoocCookies", main.contains("__caMoocCookies"))
        assertTrue("没有取消回调 __caMoocCancel", main.contains("__caMoocCancel"))
        assertTrue(
            "回调没在顶层找不到时降级到 #frameAccount iframe：" +
                "个人中心跑在 iframe 里，顶层拿不到它的函数",
            mooc.contains("frameAccount")
        )
        assertEquals(
            "成功 / 取消两处各置一次 delivered 才够：多一处或漏一处都可能回调两遍",
            2, Regex("""moocState\.delivered\s*=\s*true""").findAll(main).count()
        )
        assertTrue(
            "回调前没校验 state 身份：关窗后延时任务醒来还会往页面上回调",
            mooc.contains("moocLogin !== moocState")
        )
    }

    @Test
    fun `关窗先销毁内嵌 WebView，Cookie 不进日志`() {
        val dismiss = mooc.substringAfter("setOnDismissListener").substringBefore("dialog.show()")
        assertTrue(
            "dismiss 里没把内嵌 WebView 移出视图树：destroy 前必须先 removeView",
            dismiss.contains("removeView")
        )
        assertTrue(
            "dismiss 里没 destroy 内嵌 WebView：每次开小窗都漏一个 WebView",
            dismiss.contains("destroy()")
        )
        assertTrue(
            "Activity 退出时没先关 MOOC 小窗，Dialog 会带着 Activity 的窗口一起泄漏",
            main.substringAfter("override fun onDestroy")
                .substringBefore("private fun releaseWebView")
                .contains("moocLogin?.dialog?.dismiss()")
        )
        assertTrue(
            "Cookie 被写进日志了（登录凭据不能落日志）",
            !Regex("""Log\.[a-z]+\([^\n]*[Cc]ookie""").containsMatchIn(main)
        )
    }

    /** 单测的工作目录是模块目录（android/app）；从 IDE 直接跑时可能是仓库根，两种都认（同 ChaoxingBindTest） */
    private fun moduleFile(name: String): File =
        File(name).takeIf { it.exists() } ?: File("app", name)
}
