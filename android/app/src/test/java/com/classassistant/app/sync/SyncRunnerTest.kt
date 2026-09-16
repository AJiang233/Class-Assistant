package com.classassistant.app.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「哪些是新出现的 + 新基线记到哪」的判定。
 *
 * 为什么值得单独钉住：它是**刷屏的唯一防线**。前台服务 3 分钟来一轮，这条判定写错一次，
 * 用户一屏都是旧通知。而这种事故在开发机上很难碰到 —— 本地通常只有一两条历史数据，
 * 「把历史全推一遍」和「只推新的」看起来差不多。
 */
class SyncRunnerTest {

    @Test
    fun `还没同步过时只记基线，什么都不算新`() {
        val pick = SyncRunner.pickFresh(listOf(100L, 300L, 200L), lastSeen = 0L)
        assertTrue(pick.fresh.isEmpty())
        assertEquals(300L, pick.baseline)
    }

    @Test
    fun `只有比基线更新的才算新`() {
        val pick = SyncRunner.pickFresh(listOf(100L, 200L, 300L), lastSeen = 200L)
        assertEquals(listOf(2), pick.fresh)
        assertEquals(300L, pick.baseline)
    }

    @Test
    fun `没有更新的条目时不动基线`() {
        val pick = SyncRunner.pickFresh(listOf(100L, 200L), lastSeen = 200L)
        assertTrue(pick.fresh.isEmpty())
        assertEquals(null, pick.baseline)
    }

    @Test
    fun `与基线同一时刻的条目不重复算新`() {
        // 用 > 而不是 >=：服务端的秒级时间戳换算成毫秒后容易撞在一起，
        // 判成 >= 的话同一条通知会被反复推
        val pick = SyncRunner.pickFresh(listOf(200L, 200L), lastSeen = 200L)
        assertTrue(pick.fresh.isEmpty())
        assertEquals(null, pick.baseline)
    }

    @Test
    fun `解析不出时间的条目不参与判定`() {
        val pick = SyncRunner.pickFresh(listOf(null, 300L), lastSeen = 100L)
        assertEquals(listOf(1), pick.fresh)
        assertEquals(300L, pick.baseline)
    }

    @Test
    fun `一条都解析不出时间时不动基线`() {
        val pick = SyncRunner.pickFresh(listOf(null, null), lastSeen = 100L)
        assertTrue(pick.fresh.isEmpty())
        assertEquals(null, pick.baseline)
    }

    @Test
    fun `列表为空时不动基线`() {
        val pick = SyncRunner.pickFresh(emptyList(), lastSeen = 100L)
        assertTrue(pick.fresh.isEmpty())
        assertEquals(null, pick.baseline)
    }

    // ===== 换账号时清不清本地数据（issue #64）=====
    //
    // 判据写错的两个方向都很难在开发机上发现：判宽了，每次重新登录都会把课表与离线缓存清空；
    // 判窄了，上一个账号的课表会一直挂在小部件上、旧闹钟还在响。所以四种情况都钉住。

    @Test
    fun `同一个人的新 JWT 不清本地数据`() {
        assertFalse(SyncRunner.isAccountSwitch("5", "5"))
    }

    @Test
    fun `换成另一个用户要清`() {
        assertTrue(SyncRunner.isAccountSwitch("5", "6"))
    }

    @Test
    fun `本地没记过 id 时不清`() {
        // 首次登录，或从没写过 user_id 的旧版本升上来：没有东西可清
        assertFalse(SyncRunner.isAccountSwitch(null, "6"))
        assertFalse(SyncRunner.isAccountSwitch("", "6"))
    }

    @Test
    fun `新 token 解不出 id 时按换人处理`() {
        // 解不出来说明凭据不可信，宁可多清一次（下次同步就回来了），
        // 也不能让上一个账号的课表与离线缓存留下来
        assertTrue(SyncRunner.isAccountSwitch("5", null))
        assertTrue(SyncRunner.isAccountSwitch("5", ""))
    }
}
