package com.classassistant.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 学习通登录小窗，以及教务登录回跳哪个视图。
 *
 * 这两块都是「两侧按字面量对齐 + WebView 胶水」：
 *   - 网页调 `CAHost.startChaoxingLogin()` / `startAcademicLoginFor('account')`，桥方法名、
 *     参数名一改就是**静默失效**（按钮点了没反应，且没有任何报错）；
 *   - 回调名 `__caChaoxingCookies` / `__caChaoxingCancel` 也是写死在两侧的；
 *   - 「检测到 `_uid` 才算登录成功」「只回调一次」「关窗销毁 WebView」拆掉都不会崩，
 *     只会绑到一份空 Cookie、或者回调两遍、或者泄漏一个 WebView。
 *
 * 本模块没有 Robolectric，真的跑不起 WebView，所以和 AcademicBindFlowTest 一样读源码钉形状。
 */
class ChaoxingBindTest {

    private val main: String =
        moduleFile("src/main/java/com/classassistant/app/MainActivity.kt").readText()

    private val cookieJar: String =
        moduleFile("src/main/java/com/classassistant/app/ChaoxingCookieJar.kt").readText()

    /**
     * 学习通小窗那一段（从分隔注释到下一个分隔注释之前）。
     *
     * 边界用「中国大学MOOC 登录小窗」而不是 onKeyDown：MOOC 小窗与它同形、断言几乎一样，
     * 混在同一段里会让这里的检查被隔壁的代码满足，等于没测。
     */
    private val chaoxing: String =
        main.substringAfter("===== 学习通登录小窗 =====")
            .substringBefore("===== 中国大学MOOC 登录小窗 =====")

    @Test
    fun `桥上有学习通小窗和带视图参数的教务登录`() {
        assertTrue(
            "HostBridge 里没有 @JavascriptInterface fun startChaoxingLogin()：" +
                "网页的「一键绑定学习通」会静默失效",
            Regex("""@JavascriptInterface\s+fun\s+startChaoxingLogin\(\)""").containsMatchIn(main)
        )
        assertTrue(
            "HostBridge 里没有 startAcademicLoginFor(returnView: String?)：" +
                "个人中心没法要求「登录完回个人中心」",
            Regex("""fun\s+startAcademicLoginFor\(returnView:\s*String\?\)""").containsMatchIn(main)
        )
        // 老入口必须还在、且等价于 academic：鸿蒙端与老网页都按 startAcademicLogin 调
        val legacy = main.substringAfter("fun startAcademicLogin()")
            .substringBefore("fun startAcademicLoginFor")
        assertTrue(
            "startAcademicLogin() 没委托给 startAcademicLoginFor(\"academic\")：老调用点会失去回跳语义",
            legacy.contains("startAcademicLoginFor(\"academic\")")
        )
    }

    @Test
    fun `教务登录成功按白名单回到指定视图`() {
        assertTrue(
            "没找到回跳视图的白名单 ACADEMIC_RETURN_VIEWS",
            main.contains("ACADEMIC_RETURN_VIEWS")
        )
        assertTrue(
            "白名单里 must 是 academic / account 两项",
            Regex("""setOf\(\s*"academic"\s*,\s*"account"\s*\)""").containsMatchIn(main)
        )
        val finish = main.substringAfter("private fun finishAcademicLogin").substringBefore("/**")
        assertTrue(
            "finishAcademicLogin 成功时没用 pendingReturnView，还是写死的 academic",
            finish.contains("view=\$pendingReturnView")
        )
        assertTrue(
            "开始新登录时没重置 pendingReturnView：上一次的回跳视图会漏进这一次",
            main.substringAfter("private fun beginAcademicLogin")
                .substringBefore("private fun uploadAcademicCookies")
                .contains("pendingReturnView =")
        )
    }

    @Test
    fun `小窗用独立 WebView，学习通域内且 Cookie 有 _uid 才算登录`() {
        assertTrue("没解析出学习通小窗代码段，分隔注释要跟着代码走", chaoxing.isNotBlank())
        assertTrue(
            "小窗没开独立 WebView（找不到 webViewClient 或 loadUrl(CHAOXING_LOGIN_URL)）",
            chaoxing.contains("webViewClient") && chaoxing.contains("CHAOXING_LOGIN_URL")
        )
        assertTrue(
            "小窗没设桌面 UA / 第三方 Cookie：学习通登录链路会被当成游客",
            chaoxing.contains("userAgentString = DESKTOP_UA") &&
                chaoxing.contains("setAcceptThirdPartyCookies")
        )
        assertTrue(
            "小窗没打开 useWideViewPort / loadWithOverviewMode：" +
                "学习通登录页没有 viewport，会被裁成左边一块",
            chaoxing.contains("useWideViewPort = true") &&
                chaoxing.contains("loadWithOverviewMode = true")
        )
        assertTrue(
            "小窗不允许双指缩放：页面被裁时用户没有兜底手段",
            chaoxing.contains("setSupportZoom(true)") && chaoxing.contains("builtInZoomControls = true")
        )
        // 判据三件套：学习通域、多子域 Cookie 汇总、_uid
        assertTrue(
            "没从 ChaoxingCookieJar 汇总 Cookie：只读 i.chaoxing.com 会丢 i.mooc 的 jrose / spaceFidEnc，姓名读不到",
            chaoxing.contains("ChaoxingCookieJar.merge(ChaoxingCookieJar.ORIGINS.map")
        )
        assertTrue(
            "Cookie 汇总没包含 i.mooc.chaoxing.com：jrose / spaceFidEnc 拿不到",
            cookieJar.contains("\"https://i.mooc.chaoxing.com\"")
        )
        assertTrue(
            "没检查 _uid，任何 Cookie 都会当成登录成功",
            cookieJar.contains("_uid=") && chaoxing.contains("ChaoxingCookieJar.hasLogin")
        )
        assertTrue(
            "没有补齐 i.mooc 会话就回调：课程能读但姓名是空，预览会再次显示「未读取到姓名」",
            chaoxing.contains("ChaoxingCookieJar.hasMoocSession") &&
                chaoxing.contains("CHAOXING_SESSION_URL")
        )
        assertTrue(
            "域名判定没按子域匹配（passport2 / i.chaoxing.com 都要算学习通）",
            main.contains("endsWith(\".\$CHAOXING_HOST\")")
        )
    }

    @Test
    fun `登录页上的旧 _uid 不会触发自动完成`() {
        assertTrue("没有 isChaoxingLoginPage：passport2 登录页会被当成已登录", main.contains("isChaoxingLoginPage"))
        assertTrue(
            "onPageFinished 没排除登录页：旧 _uid 会让小窗 1.5 秒后自动关掉，用户无法重新登录",
            chaoxing.contains("!isChaoxingLoginPage(url)")
        )
        val helper = main.substringAfter("private fun isChaoxingLoginPage")
            .substringBefore("private fun chaoxingCookie")
        assertTrue(
            "登录页判定没排除 passport2.chaoxing.com",
            helper.contains("\"passport2.chaoxing.com\"")
        )
    }

    @Test
    fun `成功和取消都只回调一次，回调名与 iframe 兜底都在`() {
        assertTrue("没有成功回调 __caChaoxingCookies", main.contains("__caChaoxingCookies"))
        assertTrue("没有取消回调 __caChaoxingCancel", main.contains("__caChaoxingCancel"))
        assertTrue(
            "回调没在顶层找不到时降级到 #frameAccount iframe：" +
                "个人中心跑在 iframe 里，顶层拿不到它的函数",
            chaoxing.contains("frameAccount")
        )
        assertEquals(
            "成功 / 取消两处各置一次 delivered 才够：多一处或漏一处都可能回调两遍",
            2, Regex("""state\.delivered\s*=\s*true""").findAll(main).count()
        )
        assertTrue(
            "回调前没校验 state 身份：关窗后延时任务醒来还会往页面上回调",
            chaoxing.contains("chaoxingLogin !== state")
        )
        assertTrue(
            "没有检测到登录后的自动完成 / 延时",
            chaoxing.contains("CHAOXING_AUTO_FINISH_MS") && chaoxing.contains("postDelayed")
        )
    }

    @Test
    fun `关窗先销毁内嵌 WebView，Cookie 不进日志`() {
        val dismiss = main.substringAfter("setOnDismissListener")
            .substringBefore("dialog.show()")
        assertTrue(
            "dismiss 里没把内嵌 WebView 移出视图树：destroy 前必须先 removeView",
            dismiss.contains("removeView")
        )
        assertTrue(
            "dismiss 里没 destroy 内嵌 WebView：每次开小窗都漏一个 WebView",
            dismiss.contains("destroy()")
        )
        assertTrue(
            "Activity 退出时没先关小窗，Dialog 会带着 Activity 的窗口一起泄漏",
            main.substringAfter("override fun onDestroy")
                .substringBefore("private fun releaseWebView")
                .contains("chaoxingLogin?.dialog?.dismiss()")
        )
        assertTrue(
            "Cookie 被写进日志了（登录凭据不能落日志）",
            !Regex("""Log\.[a-z]+\([^\n]*[Cc]ookie""").containsMatchIn(main)
        )
    }

    /** 单测的工作目录是模块目录（android/app）；从 IDE 直接跑时可能是仓库根，两种都认（同 AcademicBindFlowTest） */
    private fun moduleFile(name: String): File =
        File(name).takeIf { it.exists() } ?: File("app", name)
}
