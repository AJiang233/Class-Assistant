package com.classassistant.app.sync

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 一条待提醒的活动（只保留提醒与小组件需要的字段）。
 *
 * `endMillis` 可空：服务端的 end_time 本来就允许为空（见下面的 [isEventActiveOnDay]），
 * 空表示这场活动只占开始那天。提醒只看 `startMillis`（见 Scheduler.rescheduleAlarms），
 * 结束时间只用来决定小组件上「这场活动还算不算在办」。
 */
data class Event(
    val id: Int,
    val title: String,
    val startMillis: Long,
    val endMillis: Long?,
    val location: String
)

/**
 * 服务端时间是不带时区的「本地时间」字符串（如 2026-09-10 21:09:00），
 * 所以直接用设备时区解析，不做 UTC 换算。
 */
fun parseServerTime(text: String?): Long? {
    if (text.isNullOrBlank()) return null
    val value = text.trim().replace('T', ' ')
    for (pattern in listOf("yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm")) {
        try {
            return SimpleDateFormat(pattern, Locale.CHINA).parse(value)?.time
        } catch (e: Exception) {
            // 试下一种格式
        }
    }
    return null
}

/** 09:30 */
fun formatClock(millis: Long): String =
    SimpleDateFormat("HH:mm", Locale.CHINA).format(Date(millis))

/** 09-12 09:30 */
fun formatDayClock(millis: Long): String =
    SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(Date(millis))

fun isSameDay(a: Long, b: Long): Boolean {
    val f = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA)
    return f.format(Date(a)) == f.format(Date(b))
}

/**
 * 「今天 00:00」的毫秒时间戳（设备时区，与 parseServerTime / isSameDay 同一套时区口径）。
 * 同步时用它当缓存下限：小工具标题是「今日活动」，所以今天已经开始的（甚至已经结束的）
 * 活动都得留在缓存里，否则正在进行的活动会显示成「今日暂无安排」。
 */
fun startOfToday(now: Long): Long {
    val day = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(Date(now))
    return SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).parse(day)?.time ?: now
}

/**
 * 这场活动在「某一天」算不算在办。小组件（今日活动卡片）与网页主页取同一口径。
 *
 * 口径来自后端 `/api/activities` 的默认 `scope=active`（见后端 activityModel.list 的 SQL），
 * 只比**日期**、不比时刻：
 *
 *     start_day <= 该日 <= end_day
 *
 * 也就是说：活动在自己最后那一天从 00:00 到 23:59 之间都还显示，过了这一天（第二天 00:00 起）
 * 才从列表里消失；`endMillis` 为空 = 只占开始那天（end_day 退化成 start_day）。
 *
 * 为什么不能拿 `isSameDay(startMillis, 该日)` 凑合：那条只认「开始就在今天」，
 * 一条昨天开始、今天才结束的活动（比如两天的运动会）在今天就是「在办」，
 * 网页主页看得到、小组件却看不到 —— 两块屏说的是两件事。
 *
 * @param dayMillis 要判的那一天里的任意时刻（只看它的日期）
 */
fun isEventActiveOnDay(startMillis: Long, endMillis: Long?, dayMillis: Long): Boolean {
    val day = startOfToday(dayMillis)
    // 还没开始（开始那天在该日之后）
    if (startOfToday(startMillis) > day) return false
    // 已经结束（最后一天在该日之前）
    return startOfToday(endMillis ?: startMillis) >= day
}
