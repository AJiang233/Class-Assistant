package com.classassistant.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 一键绑定的「什么时候算登录完成」（issue #29）。
 *
 * 这个 bug 的现象是「点一下、什么都没做、直接弹绑定失败并跳回软件」：判断条件是「当前 URL 落在
 * 教务域」，而流程第一步加载的就是教务门户本身，Cookie 罐里又往往留着上一次的会话 —— 于是第一页
 * 就上报了一份未认证的 Cookie，后端拉不到课表，失败又被当成流程结束，用户直接被踢回门户。
 *
 * 修好之后它**不会有任何编译或运行期症状**：去掉 leftSchoolHost 只是回到「第一页就上报」，
 * 去掉「失败不结束流程」只是回到「失败就踢人」，都要等校方门户的跳转行为变一次才会被用户发现
 * （2026-09 就是这么发生的）。所以这里像 ReleaseShrinkTest 那样读源码钉形状 ——
 * 这段胶水碰的是 WebView，本模块没有 Robolectric，执行不了。
 */
class AcademicBindFlowTest {

    private val main: String =
        moduleFile("src/main/java/com/classassistant/app/MainActivity.kt").readText()

    /** onPageFinished 里那一整个「教务登录中」分支 */
    private val finishedBranch: String =
        main.substringAfter("override fun onPageFinished")
            .substringBefore("override fun onReceivedSslError")

    /** uploadAcademicCookies 的函数体：切到下一段 KDoc 之前，免得把下一个函数的说明文字也算进来 */
    private val upload: String =
        main.substringAfter("private fun uploadAcademicCookies").substringBefore("/**")

    @Test
    fun `回到教务域不等于登录完成，还要离开过教务主机`() {
        assertTrue(
            "没找到 onPageFinished 的教务分支，测试要跟着代码走",
            finishedBranch.contains("academicLogin")
        )
        assertTrue(
            "onPageFinished 只看 isSchoolUrl 就上报了：点进来第一页就会拿旧 Cookie 上报，" +
                "失败还会把用户踢回门户（issue #29）",
            finishedBranch.contains("leftSchoolHost")
        )
        // 离开教务主机这件事得有人记：onPageStarted 是主框架每次新文档开始的地方（#28 也在那儿）
        val started = main.substringAfter("override fun onPageStarted")
            .substringBefore("override fun onPageFinished")
        assertTrue(
            "onPageStarted 里没记「离开过教务主机」，leftSchoolHost 会永远是 false，" +
                "整个自动上报就静默失效了",
            started.contains("leftSchoolHost = true")
        )
        assertTrue(
            "开流程时没把 leftSchoolHost 复位：上一次没走完的流程会漏进这一次",
            main.substringAfter("private fun beginAcademicLogin")
                .substringBefore("private fun uploadAcademicCookies")
                .contains("leftSchoolHost = false")
        )
        // 上报一次就要清一次：每个上报后端都要真去教务拉一次课表，用户在教务站里翻几页就是几发
        assertTrue(
            "上报后没把 leftSchoolHost 清掉：用户接着在教务站里翻页会反复上报",
            Regex("""leftSchoolHost\s*=\s*false""").findAll(finishedBranch).count() >= 1
        )
    }

    @Test
    fun `上报失败不能结束流程`() {
        assertTrue("没解析出 uploadAcademicCookies，正则要跟着代码走", upload.isNotBlank())
        assertTrue(
            "uploadAcademicCookies 里出现了 finishAcademicLogin(false)：上报失败就会把用户踢回门户，" +
                "正是 issue #29 那个「点一下就失败」",
            !upload.contains("finishAcademicLogin(false)")
        )
        assertTrue(
            "成功路径上没结束流程",
            upload.contains("finishAcademicLogin(true)")
        )
        // 失败那一支必须把 bindingInProgress 放回可重试，否则这一趟就再也没有第二次上报
        assertTrue(
            "失败时没把 bindingInProgress 复位：重登一次也不会再上报",
            upload.contains("bindingInProgress = false")
        )
    }

    /**
     * 进流程时那一次「顺手拿现有 Cookie 试一次」必须静默失败：用户马上要看到登录页，
     * 这时弹一句「绑定失败」就是 issue #29 里让人以为坏了的提示。反之走完 CAS 之后失败要提示。
     */
    @Test
    fun `顺手试的那一次失败不提示，走完 CAS 之后失败才提示`() {
        assertEquals(
            "beginAcademicLogin 里那一次要 announceFailure = false",
            1, Regex("""uploadAcademicCookies\(announceFailure\s*=\s*false\)""").findAll(main).count()
        )
        assertEquals(
            "onPageFinished 里那一次要 announceFailure = true",
            1, Regex("""uploadAcademicCookies\(announceFailure\s*=\s*true\)""").findAll(main).count()
        )
        assertTrue(
            "失败时没按 announceFailure 决定要不要提示",
            upload.contains("if (announceFailure)")
        )
    }

    /** 单测的工作目录是模块目录（android/app）；从 IDE 直接跑时可能是仓库根，两种都认（同 ReleaseShrinkTest） */
    private fun moduleFile(name: String): File =
        File(name).takeIf { it.exists() } ?: File("app", name)
}
