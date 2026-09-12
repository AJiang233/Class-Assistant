package com.classassistant.app.sync

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 一条待提醒的活动（只保留提醒与小组件需要的字段） */
data class Event(
    val id: Int,
    val title: String,
    val startMillis: Long,
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
