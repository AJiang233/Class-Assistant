package com.classassistant.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
    fun `访客会话不算登录：还要能从 STUDY_INFO 解析出账号`() {
        // 打开 /member/login.htm 时 icourse163 会给未登录访客下发 NTESSTUDYSI（实测），
        // 只看它会在「刚打开、什么都没做」时误判成功 —— 1.4.5 绑上访客会话的根因
        assertFalse(MoocCookieJar.hasLogin("NTESSTUDYSI=guest-token; EDUWEBDEVICE=dev"))
        // 只有展示用的 STUDY_INFO 也不算：没有 csrfKey 一个接口都发不出去
        assertFalse(MoocCookieJar.hasLogin("STUDY_INFO=yd.abc@163.com|8|1|2"))
        assertTrue(
            MoocCookieJar.hasLogin(
                "STUDY_SESS=s; NTESSTUDYSI=abc; STUDY_INFO=yd.abc%40163.com%7C8%7C159%7C2"
            )
        )
        assertFalse(MoocCookieJar.hasLogin(null))
        assertFalse(MoocCookieJar.hasLogin(""))
        assertFalse(MoocCookieJar.hasLogin("   "))
    }

    @Test
    fun `STUDY_INFO 解析出账号与成员 ID`() {
        val identity = MoocCookieJar.identityOf(
            "NTESSTUDYSI=t; STUDY_INFO=yd.abc%40163.com%7C8%7C159%7C2"
        )
        assertEquals("yd.abc@163.com", identity?.account)
        assertEquals("159", identity?.memberId)
        assertEquals("yd.abc@163.com#159", identity?.key)
        // 网易内部别名（yd.<hash>@163.com）不当展示名：所有用户都长这样，展示出来像「登上了别人的号」
        assertEquals(true, identity?.isInternalAlias)
        assertEquals("", identity?.displayName)
    }

    @Test
    fun `非别名账号照常展示，用于其它（非网易）来源的 STUDY_INFO`() {
        val identity = MoocCookieJar.identityOf("NTESSTUDYSI=t; STUDY_INFO=13800138000%7C8%7C159")
        assertEquals(false, identity?.isInternalAlias)
        assertEquals("13800138000", identity?.displayName)
    }

    @Test
    fun `STUDY_INFO 缺失或拆不出身份时返回 null`() {
        assertNull(MoocCookieJar.identityOf("NTESSTUDYSI=t"))
        assertNull(MoocCookieJar.identityOf("STUDY_INFO="))
        assertNull(MoocCookieJar.identityOf("STUDY_INFO=%7C%7C"))
        // 账号为空但有成员 ID：仍算登录（展示名退回成员 ID）
        assertEquals("159", MoocCookieJar.identityOf("STUDY_INFO=%7C8%7C159")?.displayName)
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
