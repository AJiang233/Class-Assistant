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
}
