package com.classassistant.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 桥的来源校验（issue #28）：门户自己的页面才放行。
 *
 * 能被真正执行的前提是 isAppOrigin() 被抽成了纯函数 —— 只吃 scheme/host/port 三个基础类型，
 * 不碰 android.net.Uri。本模块没有 Robolectric、也没开 isReturnDefaultValues，单测里一调
 * Uri.parse 就会抛「Method parse in android.net.Uri not mocked」，所以原来那句
 * `url.startsWith(startUrl)` 是测不到的（ReleaseShrinkTest 那种读源码钉形状的写法也钉不出
 * 「某个 URL 到底算不算站内」）。解析仍由调用方交给平台，这里只钉规则。
 *
 * 用例集中在「字符串前缀判不出来」的那几种构造上：伪造主机、非默认端口、明文 http。
 */
class AppOriginTest {

    private val host = "class.qxwkstudio.top"

    @Test
    fun `门户自己的页面放行`() {
        // https://class.qxwkstudio.top、带路径 / 查询串 / 锚点的页面都是它自己
        assertTrue(isAppOrigin("https", host, -1, host))
        // 显式写 :443 与省略端口是同一个 origin
        assertTrue(isAppOrigin("https", host, 443, host))
        // 协议与主机名大小写不敏感（Uri 已规范化，但规则本身也不该依赖调用方）
        assertTrue(isAppOrigin("HTTPS", "CLASS.QXWKSTUDIO.TOP", -1, host))
    }

    @Test
    fun `同前缀的伪造主机不放行`() {
        // 前缀比较的经典漏洞：站内主机名被别人当成了前缀
        assertFalse(isAppOrigin("https", "$host.evil.com", -1, host))
        // Uri.parse("https://class.qxwkstudio.top@evil.com") 的 host 是 evil.com ——
        // 用户信息那一截看起来像站内，真正的目标却不是
        assertFalse(isAppOrigin("https", "evil.com", -1, host))
        assertFalse(isAppOrigin("https", "evil-$host", -1, host))
    }

    @Test
    fun `子域不放行`() {
        // 与 isExternalLink 故意相反：那边对教务域要放宽子域（别把站内页面丢给系统浏览器），
        // 这边决定的是「要不要把桥交给这个页面」，只能收紧 —— 子域可能由别的内容托管
        assertFalse(isAppOrigin("https", "sub.$host", -1, host))
    }

    @Test
    fun `http 与非默认端口不放行`() {
        // 门户只有 https，放行 http 等于一次明文降级就能拿到桥
        assertFalse(isAppOrigin("http", host, -1, host))
        // 非默认端口在浏览器眼里是另一个来源
        assertFalse(isAppOrigin("https", host, 8443, host))
        // 非 http(s) 协议更不行
        assertFalse(isAppOrigin("javascript", host, -1, host))
    }

    @Test
    fun `主机缺失或门户主机没配好时不放行`() {
        // about:blank / data: 这类页面 Uri.host 为 null，桥绝不能挂在那儿
        assertFalse(isAppOrigin("about", null, -1, host))
        assertFalse(isAppOrigin(null, host, -1, host))
        assertFalse(isAppOrigin("https", null, -1, host))
        // 门户主机取不到（startUrl 写坏）时必须一律拒绝：宁可桥失效，也不能全放行
        assertFalse(isAppOrigin("https", host, -1, null))
        assertFalse(isAppOrigin("https", host, -1, ""))
    }

    /**
     * 另一条期望：桥的挂载范围跟着文档走（issue #28）。
     *
     * 这段胶水碰的是 WebView，本模块没有 Robolectric、执行不了，只能像 ReleaseShrinkTest 那样
     * 读源码钉形状。它值得钉：这层保护被拆掉**没有任何外部症状** —— 页面照常工作，只是教务 /
     * CAS 页面上又能摸到 CAHost 了，回归时只能靠人记得。
     */
    @Test
    fun `桥的挂载范围跟着文档走`() {
        val main = moduleFile("src/main/java/com/classassistant/app/MainActivity.kt").readText()

        // 主框架新文档开始的那一刻同步一次，摘与挂都在那一个入口发生
        val started = main.substringAfter("override fun onPageStarted")
            .substringBefore("override fun onPageFinished")
        assertTrue(
            "onPageStarted 里没同步桥的挂载：离开本站时桥会一直挂着（issue #28）",
            started.contains("syncBridgeMount(")
        )

        // 挂 / 摘只该有一处实现。散在别处（比如 setupWebView 里再来一次无条件的 add）就会
        // 各记一份状态，迟早与 bridgeAttached 对不上；releaseWebView 那次摘是销毁路径，另算。
        // 匹配带左括号的调用，免得把注释里提到的名字也数进来。
        assertEquals(
            "addJavascriptInterface 只应在 syncBridgeMount 里调用一次",
            1, Regex("""addJavascriptInterface\(""").findAll(main).count()
        )
        assertEquals(
            "removeJavascriptInterface 只应在 syncBridgeMount 与 releaseWebView 里各一次",
            2, Regex("""removeJavascriptInterface\(""").findAll(main).count()
        )
    }

    /** 单测的工作目录是模块目录（android/app）；从 IDE 直接跑时可能是仓库根，两种都认（同 ReleaseShrinkTest） */
    private fun moduleFile(name: String): File =
        File(name).takeIf { it.exists() } ?: File("app", name)
}
