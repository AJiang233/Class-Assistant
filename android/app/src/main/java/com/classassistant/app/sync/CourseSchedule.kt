package com.classassistant.app.sync

import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * 一门课。只留课表小组件与课程提醒要用的字段 —— 后端 `/api/academic/timetable` 还回了
 * 学分、课程性质、教学班这些，那些是网页课表页的事，原生侧不存。
 *
 * weekday 与 weeks 的口径照抄后端：weekday 1=周一 … 7=周日；weeks 是上课周次（1 起）。
 */
data class Course(
    val name: String,
    val room: String,
    val teacher: String,
    val weekday: Int,
    val start: String,
    val end: String,
    val weeks: List<Int>
)

/**
 * 本地保存的一份课表。算「今天第几周 / 今天有哪几门课」必须同时有学期首日与总周数 ——
 * 后端给的 courses 里只有「第几周上」，没有具体日期。
 */
data class Timetable(
    val firstDate: String,
    val weekCount: Int,
    val courses: List<Course>
)

private val DAY_FORMAT = "yyyy-MM-dd"

/** 从 `/api/academic/timetable` 的响应里解析出一份课表；字段缺失就返回 null（宁可不存，也不存半份） */
fun parseTimetable(root: JSONObject): Timetable? {
    val data = root.optJSONObject("data") ?: return null
    if (!root.optBoolean("success")) return null
    val firstDate = data.optString("firstDate")
    val weekCount = data.optInt("weekCount", 0)
    val rows = data.optJSONArray("courses") ?: return null
    if (firstDate.isBlank() || weekCount <= 0) return null

    val courses = ArrayList<Course>()
    for (i in 0 until rows.length()) {
        val row = rows.optJSONObject(i) ?: continue
        val name = row.optString("name").trim()
        val weekday = row.optInt("weekday", 0)
        val start = row.optString("start").trim()
        val end = row.optString("end").trim()
        // 上课时间解析不出来就没法排提醒，这种行直接跳过而不是留一条永远不响的课
        if (name.isBlank() || weekday !in 1..7) continue
        if (minuteOfDay(start) == null) continue

        val weeks = ArrayList<Int>()
        val rawWeeks = row.optJSONArray("weeks")
        if (rawWeeks != null) {
            for (w in 0 until rawWeeks.length()) {
                val v = rawWeeks.optInt(w, 0)
                if (v > 0) weeks.add(v)
            }
        }
        courses.add(
            Course(
                name = name,
                room = row.optString("room").trim(),
                teacher = row.optString("teacher").trim(),
                weekday = weekday,
                start = start,
                end = end,
                weeks = weeks
            )
        )
    }
    return Timetable(
        firstDate = firstDate,
        weekCount = weekCount,
        courses = courses.sortedWith(compareBy({ it.weekday }, { minuteOfDay(it.start) ?: 0 }))
    )
}

fun parseTimetableJson(json: String?): Timetable? {
    if (json.isNullOrBlank()) return null
    return try {
        parseTimetable(JSONObject(json))
    } catch (e: Exception) {
        null
    }
}

/** 某天的 00:00（设备时区）。课表按「天」算，全部以这个值为基准 */
fun startOfDay(millis: Long): Long {
    val c = Calendar.getInstance()
    c.timeInMillis = millis
    c.set(Calendar.HOUR_OF_DAY, 0)
    c.set(Calendar.MINUTE, 0)
    c.set(Calendar.SECOND, 0)
    c.set(Calendar.MILLISECOND, 0)
    return c.timeInMillis
}

/** 加/减天数。用 Calendar 而不是 ±86400000：跨夏令时那几天按毫秒加会偏一小时（国内没有，
 *  但这个函数要跟「今天第几周」的口径保持一致，别在这里埋一个只在国外才犯的错） */
fun plusDays(dayStart: Long, days: Int): Long {
    val c = Calendar.getInstance()
    c.timeInMillis = dayStart
    c.add(Calendar.DAY_OF_YEAR, days)
    return startOfDay(c.timeInMillis)
}

/** 周几：1=周一 … 7=周日（与后端 weekday 同一口径，Calendar 里周日是 1，要换算） */
fun weekdayOf(dayStart: Long): Int {
    val c = Calendar.getInstance()
    c.timeInMillis = dayStart
    val raw = c.get(Calendar.DAY_OF_WEEK)   // SUNDAY=1 … SATURDAY=7
    return if (raw == Calendar.SUNDAY) 7 else raw - 1
}

/**
 * 开学第几周（1 起）。不在学期内返回 0 —— 学期开始前与结束后都算「没课」，
 * 口径与网页课表页的 currentWeek() 一致。
 */
fun weekOf(dayStart: Long, timetable: Timetable): Int {
    val first = parseServerTime(timetable.firstDate + " 00:00:00") ?: return 0
    val days = Math.floorDiv(dayStart - startOfDay(first), 86400000L)
    if (days < 0) return 0
    val week = (days / 7).toInt() + 1
    return if (week <= timetable.weekCount) week else 0
}

/** 某天要上的课（按开始时间升序）。学期外、或那天的课表里没有这门课的周次，都算没课 */
fun coursesOn(timetable: Timetable, dayStart: Long): List<Course> {
    val week = weekOf(dayStart, timetable)
    if (week <= 0) return emptyList()
    val weekday = weekdayOf(dayStart)
    return timetable.courses.filter { it.weekday == weekday && it.weeks.contains(week) }
        .sortedBy { minuteOfDay(it.start) ?: 0 }
}

/**
 * 从 [fromDayStart] 的**次日**开始，找到第一个有课的日子（含那天的课）。
 * 周末、单双周没课的日子会被跳过 —— 用户要的是「下次上什么课」，不是「明天有没有课」。
 * 找不到（假期 / 学期结束）返回 null。
 */
fun nextDayWithCourses(timetable: Timetable, fromDayStart: Long, maxDays: Int = 60): Pair<Long, List<Course>>? {
    for (offset in 1..maxDays) {
        val day = plusDays(fromDayStart, offset)
        val list = coursesOn(timetable, day)
        if (list.isNotEmpty()) return day to list
    }
    return null
}

/** "09:50" → 当天 09:50 的毫秒时间戳；解析不出来返回 null */
fun courseStartAt(dayStart: Long, hhmm: String): Long? {
    val minute = minuteOfDay(hhmm) ?: return null
    val c = Calendar.getInstance()
    c.timeInMillis = dayStart
    c.set(Calendar.HOUR_OF_DAY, minute / 60)
    c.set(Calendar.MINUTE, minute % 60)
    c.set(Calendar.SECOND, 0)
    c.set(Calendar.MILLISECOND, 0)
    return c.timeInMillis
}

/**
 * 这门课当天的下课时刻，用于判断「今天是不是已经没课了」。
 *
 * 按 开始时刻 + 时长 算，而不是把 end 重新铺到当天 ——
 * 后者遇到跨零点的课（23:00-00:30）会算出一个比上课还早的时刻。
 * 时长为负说明下课时间跨过了零点，加回 24 小时（23:00→00:30 是 90 分钟，不是 -1350 分钟）。
 */
fun courseEndAt(dayStart: Long, course: Course): Long? {
    val startAt = courseStartAt(dayStart, course.start) ?: return null
    val startMinute = minuteOfDay(course.start) ?: return null
    val endMinute = minuteOfDay(course.end) ?: return startAt
    val span = endMinute - startMinute
    val duration = if (span >= 0) span else span + 24 * 60
    return startAt + duration * 60_000L
}

/**
 * 这节课「上到百分之几」：正在上返回 0..100；还没开始 / 已经下课 / 时间串坏掉都返回 null。
 *
 * 单独提出来是为了能测。小组件那层只能靠肉眼看，而进度算错不会崩 ——
 * 只会静静地画错那条分界线（跨零点那节课最容易翻在这里），所以宁可留个纯函数钉住它。
 */
fun courseProgress(dayStart: Long, course: Course, now: Long): Int? {
    val startAt = courseStartAt(dayStart, course.start) ?: return null
    val endAt = courseEndAt(dayStart, course) ?: return null
    // 下课那一刻不算「正在上」：那节课已经上完了，该走「变灰」而不是「进度 100%」
    if (now < startAt || now >= endAt) return null
    val span = (endAt - startAt).coerceAtLeast(1L)
    return (((now - startAt) * 100) / span).toInt().coerceIn(0, 100)
}

/** "09:50" → 一天中的第几分钟；格式不对返回 null */
fun minuteOfDay(hhmm: String?): Int? {
    val text = hhmm?.trim().orEmpty()
    val parts = text.split(":")
    if (parts.size != 2) return null
    val hour = parts[0].toIntOrNull() ?: return null
    val minute = parts[1].toIntOrNull() ?: return null
    if (hour !in 0..23 || minute !in 0..59) return null
    return hour * 60 + minute
}

fun formatMonthDay(millis: Long): String =
    SimpleDateFormat("MM-dd", Locale.CHINA).format(Date(millis))

/** 周一 … 周日。与 weekdayOf 的下标对齐（1 起） */
fun weekdayName(context: android.content.Context, weekday: Int): String {
    val names = context.resources.getStringArray(com.classassistant.app.R.array.weekday_short)
    return names.getOrNull(weekday - 1) ?: ""
}

/**
 * 课程提醒闹钟的 requestCode 基数。活动闹钟直接用活动 id（数据库自增，小数值），
 * 通知 / 表单的通知 id 分别从 10 万 / 20 万起 —— 课程这边从 100 万起，互不撞号。
 */
private const val COURSE_ALARM_BASE = 1_000_000

/** requestCode 里给课程序号留的位置，够 128 门课；超出的课会共用同一格，只在极端课表下发生 */
private const val COURSE_INDEX_ROOM = 128

/**
 * 课程提醒闹钟的 requestCode：绝对日期 + 课程序号 + 类型（0=提前，1=开课时）。
 *
 * 用**绝对日期**而不是「今天往后第几天」：相对偏移每过一天就整体挪一位，
 * 同一个闹钟第二天会换一个 id，于是每天都被当成新闹钟取消重排一遍。
 * 课程序号取它在已排序课表里的下标（parseTimetable 里按 周几+开始时间 排过，顺序稳定）。
 */
fun courseAlarmId(dayStart: Long, courseIndex: Int, kind: Int): Int {
    val epochDay = (dayStart / 86400000L).toInt()
    val slot = courseIndex.coerceAtMost(COURSE_INDEX_ROOM - 1)
    return COURSE_ALARM_BASE + (epochDay * COURSE_INDEX_ROOM + slot) * 2 + kind
}

/** 小组件该显示哪一天：今天还有课 / 下一个有课的日子 / 没有数据 / 近期没课 */
enum class CourseBoardKind { TODAY, TOMORROW, LATER, NO_DATA, NONE }

data class CourseBoard(
    val kind: CourseBoardKind,
    val dayStart: Long,
    val courses: List<Course>
)

/**
 * 决定小组件显示哪一屏。抽成纯函数是为了能直接测 —— 这是整个课表小组件里
 * 唯一有分支判断的地方（今天 / 明天 / 更后面 / 没数据），也是最容易算错的地方。
 *
 *   今天还有课（含正在上的那一节） → TODAY
 *   今天没课、或者今天的课都上完了 → 往后找第一个有课的日子 → TOMORROW / LATER
 *   往后 60 天都没有课（假期 / 学期结束）→ NONE
 *   压根没有课表（没绑教务 / 还没同步到）→ NO_DATA
 */
fun decideBoard(timetable: Timetable?, now: Long): CourseBoard {
    val today = startOfDay(now)
    if (timetable == null || timetable.courses.isEmpty()) {
        return CourseBoard(CourseBoardKind.NO_DATA, today, emptyList())
    }

    val todayCourses = coursesOn(timetable, today)
    val hasLeft = todayCourses.any { courseEndAt(today, it)?.let { end -> end > now } == true }
    if (todayCourses.isNotEmpty() && hasLeft) {
        return CourseBoard(CourseBoardKind.TODAY, today, todayCourses)
    }

    val next = nextDayWithCourses(timetable, today)
        ?: return CourseBoard(CourseBoardKind.NONE, today, emptyList())
    val kind = if (next.first == plusDays(today, 1)) CourseBoardKind.TOMORROW else CourseBoardKind.LATER
    return CourseBoard(kind, next.first, next.second)
}
