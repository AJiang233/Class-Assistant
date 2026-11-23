package com.classassistant.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 学习通多子域 Cookie 汇总：漏掉 i.mooc 的 host-only Cookie 时姓名读不到。 */
class ChaoxingCookieJarTest {

    @Test
    fun `合并时补齐 i_mooc 的 host-only Cookie`() {
        val merged = ChaoxingCookieJar.merge(
            listOf(
                "_uid=u1; fid=1433; uf=abc",
                "_uid=SHOULD_NOT_WIN; jrose=j1; spaceFidEnc=s1; uf=SHOULD_NOT_WIN"
            )
        )
        assertEquals("_uid=u1; fid=1433; uf=abc; jrose=j1; spaceFidEnc=s1", merged)
    }

    @Test
    fun `主机级会话 ID 不跨子域搬`() {
        val merged = ChaoxingCookieJar.merge(
            listOf(
                "_uid=u1",
                "JSESSIONID=mooc-session; route=mooc-route; jrose=j1"
            )
        )
        assertEquals("_uid=u1; jrose=j1", merged)
    }

    @Test
    fun `空来源和非法片段不会产生多余分隔符`() {
        assertEquals("_uid=u1", ChaoxingCookieJar.merge(listOf(null, " ; =bad; _uid=u1; ")))
        assertEquals("", ChaoxingCookieJar.merge(emptyList()))
    }

    @Test
    fun `只有出现 _uid 才算登录`() {
        assertTrue(ChaoxingCookieJar.hasLogin("fid=1433; _uid=123"))
        assertFalse(ChaoxingCookieJar.hasLogin("fid=1433; uf=abc"))
        assertFalse(ChaoxingCookieJar.hasLogin(null))
        assertFalse(ChaoxingCookieJar.hasLogin(""))
    }

    @Test
    fun `个人空间会话要 spaceFidEnc`() {
        assertTrue(ChaoxingCookieJar.hasMoocSession("_uid=123; spaceFidEnc=abc"))
        assertFalse(ChaoxingCookieJar.hasMoocSession("_uid=123; jrose=xyz"))
        assertFalse(ChaoxingCookieJar.hasMoocSession(null))
    }
}
