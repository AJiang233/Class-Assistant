package com.classassistant.app.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

/**
 * 预热清单里「每天都会变」的那两条。
 *
 * 主页的当日列表按 `date=YYYY-MM-DD` 取，缓存键就是 URL —— 参数顺序、日期格式差一个字，
 * 命中的就是另一份缓存（或者压根没有），表现成「每天第一次进屋还是要等一下」，不会报错。
 * 所以把这两个 URL 的形状钉住。
 */
class OfflineApiTest {

    private val shanghai: TimeZone = TimeZone.getTimeZone("Asia/Shanghai")

    /** 某个时区的某日 12:00（避开跨日边界，测试结果也不随跑测机器的时区变） */
    private fun noon(y: Int, m: Int, d: Int, zone: TimeZone): Long {
        val c = Calendar.getInstance(zone)
        c.clear()
        c.set(y, m - 1, d, 12, 0, 0)
        return c.timeInMillis
    }

    @Test
    fun `当日列表的 URL 与网页拼的逐字一致`() {
        // 顺序也要对上：网页里通知是 ?limit=50&date=…、活动是 ?date=…&limit=50
        assertEquals(
            listOf(
                "/api/notices?limit=50&date=2026-09-14",
                "/api/activities?date=2026-09-14&limit=50"
            ),
            OfflineApi.todayListPaths(noon(2026, 9, 14, shanghai), shanghai)
        )
    }

    @Test
    fun `日期按传入的时区算`() {
        // 同一时刻：北京时间已经是 9 月 15 日 07:00，UTC 那边还是 9 月 14 日 23:00
        val at = noon(2026, 9, 15, shanghai) - 5 * 60 * 60 * 1000L
        assertTrue(OfflineApi.todayListPaths(at, shanghai)[0].endsWith("date=2026-09-15"))
        assertTrue(OfflineApi.todayListPaths(at, TimeZone.getTimeZone("UTC"))[0].endsWith("date=2026-09-14"))
    }

    @Test
    fun `预热清单 = 固定项 + 当天的两条`() {
        val paths = OfflineApi.prewarmPaths(noon(2026, 9, 14, shanghai), shanghai)
        assertTrue(paths.contains(OfflineApi.TIMETABLE_PATH))
        assertTrue(paths.contains("/api/notices?scope=all"))
        assertTrue(paths.contains("/api/auth/me"))
        assertTrue(paths.contains("/api/notices?limit=50&date=2026-09-14"))
        assertTrue(paths.contains("/api/activities?date=2026-09-14&limit=50"))
    }

    /**
     * 「刷新」这一类请求（页面在查询串里带 `refresh=1`）。
     *
     * 缓存键里要去掉它：同一份数据挂在两个键上，既白占名额，又让「先刷新、后断网」
     * 读到另一份（很可能压根没写过）的缓存。同时这一类不吃缓存首帧，否则刷新按钮
     * 在窗口期内等于没反应。键或判定算错了都不报错，只是行为悄悄不对，所以把形状钉住。
     */
    @Test
    fun `刷新请求的缓存键去掉 refresh=1`() {
        assertEquals("/api/academic/credits", OfflineApi.cacheKey("/api/academic/credits", "refresh=1"))
        assertEquals(
            "/api/academic/timetable?xnxq=2025-2026-1",
            OfflineApi.cacheKey("/api/academic/timetable", "xnxq=2025-2026-1&refresh=1")
        )
        // 学期参数是数据的一部分，必须留下
        assertEquals("/api/notices?scope=all", OfflineApi.cacheKey("/api/notices", "scope=all"))
        assertEquals("/api/notices", OfflineApi.cacheKey("/api/notices", null))
        assertEquals("/api/notices", OfflineApi.cacheKey("/api/notices", ""))
        assertEquals("/api/notices", OfflineApi.cacheKey("/api/notices", "refresh=1"))
    }

    @Test
    fun `只有 refresh=1 算强制刷新`() {
        assertTrue(OfflineApi.isForceRefresh("refresh=1"))
        assertTrue(OfflineApi.isForceRefresh("xnxq=2025-2026-1&refresh=1"))
        // 只认整段相等：refresh=12 不是那个开关，别把它也当成「别给我缓存」
        assertTrue(!OfflineApi.isForceRefresh("refresh=12"))
        assertTrue(!OfflineApi.isForceRefresh("scope=all"))
        assertTrue(!OfflineApi.isForceRefresh(null))
        assertTrue(!OfflineApi.isForceRefresh(""))
    }
}
