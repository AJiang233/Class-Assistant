package com.classassistant.app

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * release 的 R8 配置（压缩 / 混淆 / 资源收缩）以及它必须配套的两件事。
 *
 * 这几条只能用读源文件这种笨办法钉住：混淆出问题**不崩、不报错、日志也没有** ——
 *   JS 桥的方法名被改名 → 网页那边静默调不到（登录态同步没了、个人页那几张卡片是空的）
 *   下拉刷新探针读回内联样式 → 网页侧改走 hidden 属性后，它会一直以为「在主页」
 * 都属于「上线后靠用户反馈才发现」的类别，所以在此拦住。
 *
 * 同时也守住了体积：开关被谁顺手关掉时，这条会先红，而不是等下一个人比着两个包才发现。
 */
class ReleaseShrinkTest {

    /**
     * 单测的工作目录是模块目录（android/app）；从 IDE 直接跑时可能是仓库根，两种都认。
     */
    private fun moduleFile(name: String): File =
        File(name).takeIf { it.exists() } ?: File("app", name)

    /** 去掉注释行：ProGuard 用 `#`、Kotlin 用 `//` —— 规则被注释掉就等于没有，不能算数 */
    private fun effective(file: File, prefix: String): String =
        file.readText().lines().filterNot { it.trimStart().startsWith(prefix) }.joinToString("\n")

    @Test
    fun `release 必须开着代码压缩与资源收缩`() {
        val gradle = effective(moduleFile("build.gradle.kts"), "//")
        assertTrue(
            "release 的 isMinifyEnabled 被关掉了 —— 关掉就没有混淆，APK 也从 2.1 MB 回到 4.7 MB",
            gradle.contains("isMinifyEnabled = true")
        )
        assertTrue(
            "release 的 isShrinkResources 被关掉了 —— 它要靠代码压缩的结果才能工作，两个得一起开",
            gradle.contains("isShrinkResources = true")
        )
    }

    @Test
    fun `JS 桥的 keep 规则必须在，否则网页调不到桥`() {
        val rules = effective(moduleFile("proguard-rules.pro"), "#")
        assertTrue(
            "proguard-rules.pro 里少了 HostBridge 的 keep 规则：桥方法名一被改名，网页侧就是静默失效",
            rules.contains("-keepclassmembers class com.classassistant.app.MainActivity\$HostBridge")
        )
        assertTrue(
            "keep 规则里没有保留 @JavascriptInterface 方法",
            rules.contains("@android.webkit.JavascriptInterface <methods>;")
        )
    }

    @Test
    fun `下拉刷新探针读的是 hidden 属性，不是内联样式`() {
        val main = moduleFile("src/main/java/com/classassistant/app/MainActivity.kt").readText()
        val probe = main.substringAfter("val PROBE_JS =")
        assertTrue("没找到 PROBE_JS，测试要跟着代码走", probe.isNotBlank())
        // 网页侧的视图显隐统一走 hidden 属性（当初为收紧 CSP 改的），内联 style.display 不再写了：
        // 探针再去读它，取到的永远是空串，于是「是否在主页」恒为真 —— 子页面下拉也会触发整页刷新
        assertTrue(
            "PROBE_JS 还在读内联的 style.display，网页侧已经不写它了",
            !probe.contains("style.display")
        )
        assertTrue("PROBE_JS 判断主页与子页面显隐要读 hidden 属性", probe.contains("!h.hidden"))
        assertTrue("PROBE_JS 判断子页面（iframe）显隐要读 hidden 属性", probe.contains("f.hidden"))
    }
}
