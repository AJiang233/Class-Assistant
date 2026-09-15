package com.classassistant.app.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 课表日期逻辑的单元测试。
 *
 * 这块是全靠日期算术的地方（第几周、下一个有课的日子、跨零点下课），出错又不会崩，
 * 只会悄悄显示错的那一天 —— 所以用真实日期钉住。
 *
 * 用到的日期事实（可以拿任意日历核对）：
 *   2026-08-31 周一 = 第 1 周首日；09-07 周一 = 第 2 周；09-14 周一 = 第 3 周
 *   09-12 周六、09-13 周日；09-16 周三
 */
class CourseScheduleTest {

    private val firstDate = "2026-08-31"
    private val weekCount = 19

    /** 周一 / 周三有课：周一两节全天课 + 一门单周课，周三一节 */
    private val timetable = Timetable(
        firstDate = firstDate,
        weekCount = weekCount,
        courses = listOf(
            course("早课", weekday = 1, start = "08:00", end = "09:40"),
            course("下午课", weekday = 1, start = "14:00", end = "15:40"),
            course("单周课", weekday = 1, start = "16:00", end = "17:40", weeks = listOf(1, 3, 5, 7, 9, 11, 13, 15)),
            course("周三课", weekday = 3, start = "10:45", end = "11:30")
        )
    )

    private fun course(
        name: String,
        weekday: Int,
        start: String,
        end: String,
        weeks: List<Int> = (1..16).toList()
    ) = Course(
        name = name,
        room = "公共教学楼A101",
        teacher = "王老师",
        weekday = weekday,
        start = start,
        end = end,
        weeks = weeks
    )

    private fun t(text: String): Long = parseServerTime(text)!!

    // ===== 第几周 =====

    @Test
    fun `开学第几周按学期首日算`() {
        assertEquals(1, weekOf(t("2026-08-31 00:00:00"), timetable))
        assertEquals(1, weekOf(t("2026-09-06 23:59:00"), timetable))   // 第 1 周最后一天（周日）
        assertEquals(2, weekOf(t("2026-09-07 00:00:00"), timetable))
        assertEquals(3, weekOf(t("2026-09-14 09:00:00"), timetable))
    }

    @Test
    fun `学期外一律算没课`() {
        assertEquals(0, weekOf(t("2026-08-30 09:00:00"), timetable))   // 开学前一天
        assertEquals(0, weekOf(t("2027-03-01 09:00:00"), timetable))   // 第 19 周早已结束
        assertTrue(coursesOn(timetable, t("2026-08-30 00:00:00")).isEmpty())
    }

    // ===== 某天有哪些课 =====

    @Test
    fun `某天的课按周几与周次过滤并按时间排序`() {
        assertEquals(
            listOf("早课", "下午课", "单周课"),
            coursesOn(timetable, t("2026-09-14 00:00:00")).map { it.name }   // 第 3 周（单周）
        )
        assertEquals(
            listOf("早课", "下午课"),
            coursesOn(timetable, t("2026-09-21 00:00:00")).map { it.name }   // 第 4 周（双周，单周课不上）
        )
        assertTrue(coursesOn(timetable, t("2026-09-15 00:00:00")).isEmpty())  // 周二没课
    }

    // ===== 小组件显示哪一屏 =====

    @Test
    fun `今天还有课就显示今天`() {
        val board = decideBoard(timetable, t("2026-09-14 10:00:00"))   // 早课已上完，下午还有课
        assertEquals(CourseBoardKind.TODAY, board.kind)
        assertEquals(t("2026-09-14 00:00:00"), board.dayStart)
        assertEquals(listOf("早课", "下午课", "单周课"), board.courses.map { it.name })
    }

    @Test
    fun `正在上的那节课也算今天还有课`() {
        val board = decideBoard(timetable, t("2026-09-14 08:30:00"))   // 早课 08:00-09:40 进行中
        assertEquals(CourseBoardKind.TODAY, board.kind)
    }

    @Test
    fun `今天的课都上完就往前看，并标出是哪天`() {
        val board = decideBoard(timetable, t("2026-09-14 21:00:00"))
        assertEquals(CourseBoardKind.LATER, board.kind)                // 周三不是「明天」，所以是 LATER
        assertEquals(t("2026-09-16 00:00:00"), board.dayStart)
        assertEquals(listOf("周三课"), board.courses.map { it.name })
    }

    @Test
    fun `今天没课时下一个有课的日子分明天与更后面`() {
        val tomorrow = decideBoard(timetable, t("2026-09-15 09:00:00"))   // 周二 → 周三 = 明天
        assertEquals(CourseBoardKind.TOMORROW, tomorrow.kind)
        assertEquals(t("2026-09-16 00:00:00"), tomorrow.dayStart)

        val later = decideBoard(timetable, t("2026-09-12 09:00:00"))      // 周六 → 下周一
        assertEquals(CourseBoardKind.LATER, later.kind)
        assertEquals(t("2026-09-14 00:00:00"), later.dayStart)
    }

    @Test
    fun `周日看的是明天的周一`() {
        val board = decideBoard(timetable, t("2026-09-13 09:00:00"))
        assertEquals(CourseBoardKind.TOMORROW, board.kind)
        assertEquals(t("2026-09-14 00:00:00"), board.dayStart)
    }

    @Test
    fun `没有课表时说没数据，而不是说今天没课`() {
        assertEquals(CourseBoardKind.NO_DATA, decideBoard(null, t("2026-09-14 09:00:00")).kind)
        val empty = Timetable(firstDate, weekCount, emptyList())
        assertEquals(CourseBoardKind.NO_DATA, decideBoard(empty, t("2026-09-14 09:00:00")).kind)
    }

    @Test
    fun `往后都排不出课时说近期没有安排`() {
        // 只在第 1 周有课，第 5 周打开：往后 60 天（约 8 周）都碰不到
        val onlyFirstWeek = Timetable(firstDate, weekCount, listOf(course("开学典礼", 1, "08:00", "09:40", weeks = listOf(1))))
        assertEquals(CourseBoardKind.NONE, decideBoard(onlyFirstWeek, t("2026-09-28 09:00:00")).kind)
    }

    // ===== 时间小工具 =====

    @Test
    fun `下课时刻按上课时长推，跨零点也不会算到前面去`() {
        val day = t("2026-09-14 00:00:00")
        assertEquals(t("2026-09-14 09:40:00"), courseEndAt(day, course("早课", 1, "08:00", "09:40")))
        // 23:00-00:30：时长 90 分钟，下课时刻是次日 00:30 而不是当天 00:30
        assertEquals(t("2026-09-15 00:30:00"), courseEndAt(day, course("夜课", 1, "23:00", "00:30")))
    }

    @Test
    fun `时间字符串解析`() {
        assertEquals(480, minuteOfDay("08:00"))
        assertEquals(0, minuteOfDay("00:00"))
        assertEquals(1439, minuteOfDay("23:59"))
        assertNull(minuteOfDay("abc"))
        assertNull(minuteOfDay("24:00"))
        assertNull(minuteOfDay(""))
        assertNull(minuteOfDay(null))
        assertNull(courseStartAt(t("2026-09-14 00:00:00"), "25:00"))
    }

    // ===== 进行中那节课的进度（小组件上那条「一半深一半浅」的分界线）=====

    /** 空指针 / 除零这类错在小组件上不会崩，只会画错一条线，所以边界全钉住 */
    @Test
    fun `课时进行到一半给 50`() {
        val day = t("2026-09-16 00:00:00")   // 2026-09-16 周三
        val c = course("高数", 3, "08:00", "10:00")
        assertEquals(0, courseProgress(day, c, t("2026-09-16 08:00:00")))    // 刚上课
        assertEquals(50, courseProgress(day, c, t("2026-09-16 09:00:00")))
        assertEquals(99, courseProgress(day, c, t("2026-09-16 09:59:00")))
    }

    @Test
    fun `还没开始和已经下课都不给进度`() {
        val day = t("2026-09-16 00:00:00")
        val c = course("高数", 3, "08:00", "10:00")
        assertNull(courseProgress(day, c, t("2026-09-16 07:59:00")))
        // 下课那一刻就算下课：该走「变灰」，不是「100% 还在上」
        assertNull(courseProgress(day, c, t("2026-09-16 10:00:00")))
        assertNull(courseProgress(day, c, t("2026-09-16 12:00:00")))
    }

    @Test
    fun `跨零点的那节课进度按真实时长算`() {
        val day = t("2026-09-16 00:00:00")
        val c = course("晚课", 3, "23:00", "00:30")
        // 23:30 时上了 30 分钟，全程 90 分钟 → 33%
        assertEquals(33, courseProgress(day, c, t("2026-09-16 23:30:00")))
    }

    @Test
    fun `时间串坏掉时不给进度`() {
        val day = t("2026-09-16 00:00:00")
        assertNull(courseProgress(day, course("怪课", 3, "八点", "十点"), t("2026-09-16 08:00:00")))
    }

    // ===== 上课期间那次重绘该排在什么时候（进度条靠它一格一格往前推，issue #61）=====

    /**
     * 这个函数决定「下次什么时候重绘」，排错不会崩 —— 只会静静地不动（排太晚）或者
     * 空转重绘（排太早），在小组件上都看不出来，所以边界全钉住。
     */
    @Test
    fun `正在上课时排一分钟后`() {
        val day = t("2026-09-16 00:00:00")
        val courses = listOf(course("高数", 3, "08:00", "10:00"))
        val now = t("2026-09-16 09:00:00")
        assertEquals(now + 60_000L, nextClassTickAt(day, courses, now))
    }

    @Test
    fun `还没上课时直接排在下一节开课那一刻`() {
        val day = t("2026-09-16 00:00:00")
        val courses = listOf(
            course("高数", 3, "08:00", "10:00"),
            course("英语", 3, "14:00", "15:40")
        )
        // 两节课之间的空档：排在下午那节开课，而不是等「碰巧有人重绘」（最坏晚半小时）
        assertEquals(t("2026-09-16 14:00:00"), nextClassTickAt(day, courses, t("2026-09-16 12:00:00")))
        // 凌晨看手机：排在当天第一节课开课那一刻
        assertEquals(t("2026-09-16 08:00:00"), nextClassTickAt(day, courses, day))
    }

    @Test
    fun `课都上完或者根本没课时不用再排`() {
        val day = t("2026-09-16 00:00:00")
        val courses = listOf(course("高数", 3, "08:00", "10:00"))
        // 下课那一刻就不算「正在上」（口径同 courseProgress），当天也没有下一节了
        assertNull(nextClassTickAt(day, courses, t("2026-09-16 10:00:00")))
        assertNull(nextClassTickAt(day, courses, t("2026-09-16 23:00:00")))
        // 今天没课 / 压根没有课表：不能因为「没东西排」就退回 now，那样会变成每分钟空转
        assertNull(nextClassTickAt(day, emptyList(), t("2026-09-16 09:00:00")))
    }

    @Test
    fun `时间串坏掉时排不出重绘时刻`() {
        val day = t("2026-09-16 00:00:00")
        val broken = listOf(course("怪课", 3, "八点", "十点"))
        assertNull(nextClassTickAt(day, broken, t("2026-09-16 09:00:00")))
    }

    // ===== 闹钟编号 =====

    /**
     * 编号必须「同一天同一节课同一个类型」稳定、「不同天 / 不同课 / 不同类型」互不相同 ——
     * 稳定才能重复排期时只是覆盖而不堆重复闹钟，互不相同才不会互相顶掉。
     */
    @Test
    fun `课程闹钟编号稳定且不冲突`() {
        val day = t("2026-09-14 00:00:00")
        val nextDay = plusDays(day, 1)

        assertEquals(courseAlarmId(day, 3, 0), courseAlarmId(day, 3, 0))
        assertNotEquals(courseAlarmId(day, 3, 0), courseAlarmId(day, 3, 1))   // 提前 / 开课时
        assertNotEquals(courseAlarmId(day, 3, 0), courseAlarmId(day, 4, 0))   // 不同课
        assertNotEquals(courseAlarmId(day, 3, 0), courseAlarmId(nextDay, 3, 0)) // 不同天

        // 与活动闹钟（直接用活动 id）、通知（10 万起）、表单（20 万起）都不在同一段
        assertTrue(courseAlarmId(day, 0, 0) >= 1_000_000)
    }
}
