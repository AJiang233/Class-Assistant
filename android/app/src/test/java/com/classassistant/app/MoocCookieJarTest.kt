package com.classassistant.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 中国大学MOOC 多子域 Cookie 汇总。
 *
 * 服务端只向 www.icourse163.org 发 `.rpc` 请求，csrfKey 取的是这一域上的 NTESSTUDYSI；
 * reg 那份是登录链路上的临时凭据。合并顺序错了会拿到另一个子域的同名 Cookie。
 */
class MoocCookieJarTest {

    @Test
    fun `www 排第一，同名 Cookie 以先出现的为准`() {
        val merged = MoocCookieJar.merge(
            listOf(
                "NTESSTUDYSI=www-token; STUDY_INFO=www-info; WM_TID=t",
                "NTESSTUDYSI=reg-token; STUDY_SESS=reg-sess"
            )
        )
        assertEquals(
            "NTESSTUDYSI=www-token; STUDY_INFO=www-info; WM_TID=t; STUDY_SESS=reg-sess",
            merged
        )
    }

    @Test
    fun `主机级会话 ID 只保留第一个来源里的`() {
        val merged = MoocCookieJar.merge(
            listOf(
                "NTESSTUDYSI=www-token",
                "JSESSIONID=reg-session; route=reg-route; STUDY_SESS=reg-sess"
            )
        )
        assertEquals("NTESSTUDYSI=www-token; STUDY_SESS=reg-sess", merged)
    }

    @Test
    fun `空来源和非法片段不会产生多余分隔符`() {
        assertEquals("NTESSTUDYSI=t", MoocCookieJar.merge(listOf(null, " ; =bad; NTESSTUDYSI=t; ")))
        assertEquals("", MoocCookieJar.merge(emptyList()))
    }

    @Test
    fun `只有出现 NTESSTUDYSI 才算登录`() {
        assertTrue(MoocCookieJar.hasLogin("STUDY_SESS=s; NTESSTUDYSI=abc"))
        // 只有展示用的 STUDY_INFO 不算：没有 csrfKey 一个接口都发不出去
        assertFalse(MoocCookieJar.hasLogin("STUDY_INFO=yd.abc@163.com|8|1|2"))
        assertFalse(MoocCookieJar.hasLogin(null))
        assertFalse(MoocCookieJar.hasLogin(""))
        assertFalse(MoocCookieJar.hasLogin("   "))
    }

    @Test
    fun `Cookie 来源按 www 在前的顺序固定`() {
        assertEquals(
            listOf(
                "https://www.icourse163.org",
                "https://reg.icourse163.org",
                "https://m.icourse163.org"
            ),
            MoocCookieJar.ORIGINS
        )
    }
}
