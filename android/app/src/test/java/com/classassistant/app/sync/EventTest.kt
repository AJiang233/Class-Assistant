package com.classassistant.app.sync

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 活动「哪天算在办」的判定。
 *
 * 为什么值得单独钉住：它是小组件与**网页主页**显示同一件事的唯一保证（后端 `/api/activities`
 * 默认 scope=active 的 SQL 见 [isEventActiveOnDay] 的注释）。按天比较的边界（最后一天 23:59
 * 还在、第二天 00:00 就没了）又最容易被「顺手写成 isSameDay」改坏 —— 改坏之后不崩不报错，
 * 只是少显示一场正在办的活动。
 */
class EventTest {

    private fun t(text: String): Long = parseServerTime(text)!!

    @Test
    fun `没有结束时间的活动只占开始那天`() {
        val start = t("2026-09-14 08:00:00")
        assertTrue(isEventActiveOnDay(start, null, t("2026-09-14 00:00:00")))
        assertTrue(isEventActiveOnDay(start, null, t("2026-09-14 23:59:00")))
        assertFalse(isEventActiveOnDay(start, null, t("2026-09-15 00:00:00")))
        assertFalse(isEventActiveOnDay(start, null, t("2026-09-13 23:59:00")))
    }

    @Test
    fun `跨天活动从开始那天到最后那天都在办`() {
        val start = t("2026-09-14 08:00:00")
        val end = t("2026-09-15 17:00:00")
        assertTrue(isEventActiveOnDay(start, end, t("2026-09-14 20:00:00")))
        assertTrue(isEventActiveOnDay(start, end, t("2026-09-15 09:00:00")))
    }

    @Test
    fun `活动在最后一天整天都算在办，第二天才消失`() {
        // 与后端一致：比的是**日期**而不是时刻 —— 15:00 就结束的活动，当天 23:00 仍显示
        val start = t("2026-09-14 08:00:00")
        val end = t("2026-09-14 15:00:00")
        assertTrue(isEventActiveOnDay(start, end, t("2026-09-14 23:00:00")))
        assertFalse(isEventActiveOnDay(start, end, t("2026-09-15 00:01:00")))
    }

    @Test
    fun `还没开始的活动不算在办`() {
        val start = t("2026-09-16 08:00:00")
        assertFalse(isEventActiveOnDay(start, null, t("2026-09-15 12:00:00")))
        assertFalse(isEventActiveOnDay(start, t("2026-09-16 18:00:00"), t("2026-09-15 12:00:00")))
    }
}
