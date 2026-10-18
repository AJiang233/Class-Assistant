package com.classassistant.app.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * 「哪些是新出现的 + 新基线记到哪」的判定。
 *
 * 为什么值得单独钉住：它是**刷屏的唯一防线**。前台服务 3 分钟来一轮，这条判定写错一次，
 * 用户一屏都是旧通知。而这种事故在开发机上很难碰到 —— 本地通常只有一两条历史数据，
 * 「把历史全推一遍」和「只推新的」看起来差不多。
 */
class SyncRunnerTest {

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

    // ===== 预热节流（Cloudflare 额度预算）=====
    //
    // 判错的两个方向都有代价：判宽了，预热又回到每 15 分钟一轮，一个班几十号人
    // 一天多出上千次请求；判窄了，离线缓存迟迟不刷新，首帧与离线内容变旧。

    @Test
    fun `从没预热过时必定到期`() {
        assertTrue(SyncRunner.isPrewarmDue(1_000L, 0L, 60L * 60 * 1000))
    }

    @Test
    fun `内容类满一小时才算到期`() {
        val hour = 60L * 60 * 1000
        assertTrue(SyncRunner.isPrewarmDue(10 * hour, 9 * hour, hour))
        // 差 1 毫秒都不能算到期，否则周期性的 15 分钟轮次会被四舍五入地多刷一次
        assertTrue(!SyncRunner.isPrewarmDue(10 * hour, 9 * hour + 1, hour))
    }

    @Test
    fun `教务类按六小时`() {
        val sixHours = 6L * 60 * 60 * 1000
        assertTrue(SyncRunner.isPrewarmDue(2 * sixHours, sixHours, sixHours))
        assertTrue(!SyncRunner.isPrewarmDue(2 * sixHours - 1, sixHours, sixHours))
    }

    /**
     * 当日列表的缓存键带着 `date=YYYY-MM-DD`，跨天就是一个全新的 URL。
     * 只按 1 小时节流的话，零点那次刷新可能被「距上次不满一小时」跳过，
     * 新一天的两个键要等到下一个整点才预热 —— 期间第一次进主页会落回网络。
     */
    @Test
    fun `跨天要强制刷一次内容类`() {
        val zone = TimeZone.getTimeZone("Asia/Shanghai")
        val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).apply { timeZone = zone }
        fun at(s: String): Long = fmt.parse(s)!!.time

        assertTrue(SyncRunner.crossedLocalDay(at("2026-09-15 00:05"), at("2026-09-14 23:50"), zone))
        assertTrue(!SyncRunner.crossedLocalDay(at("2026-09-15 00:05"), at("2026-09-15 00:00"), zone))
        // 从没预热过由 isPrewarmDue 负责，这里不重复判
        assertTrue(!SyncRunner.crossedLocalDay(at("2026-09-15 00:05"), 0, zone))
    }
}
