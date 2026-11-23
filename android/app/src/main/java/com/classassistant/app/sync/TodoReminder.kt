package com.classassistant.app.sync

import org.json.JSONArray
import org.json.JSONObject

/**
 * 一条要提醒的待办。只留排期与通知要用的字段 —— 后端 `/api/todos` 还回了描述、来源、
 * 创建人这些，那是网页待办页的事，原生侧不存。
 */
data class TodoReminderItem(
    val id: Int,
    val title: String,
    val dueMillis: Long,
    val tag: String
)

/**
 * 待办到期提醒的默认提前量（分钟）。与课程提醒一样是**这台设备的偏好**，存本地，
 * 不随退出登录清掉；用户可以改成 0（不提醒）或更长的提前量。
 */
const val TODO_REMIND_DEFAULT = 60

/** 提前量的上限：7 天。再长就成「新建即提醒」了，也白占闹钟槽位 */
const val TODO_REMIND_MAX = 7 * 24 * 60

/**
 * 只给未来 30 天内的待办排闹钟。待办可以建在几个月后，没必要现在就把系统闹钟槽位占满；
 * 滚动窗口跟着后台同步往前推。
 */
const val TODO_HORIZON_MILLIS = 30L * 24 * 60 * 60 * 1000

/** 同时最多排多少个待办闹钟（系统对每个应用的闹钟总数有上限，别一个人把班里的额度吃光） */
const val TODO_ALARM_LIMIT = 60

/**
 * 待办闹钟的 requestCode 基数。
 *
 * 号段与别处错开：活动直接用活动 id（小数值）、课程从 100 万起（CourseSchedule.courseAlarmId）、
 * 待办从 200 万起。接收方同为 AlarmReceiver，但 action 不同；显式错开是为了查
 * 「系统里到底排着哪些闹钟」时一眼能认出是谁。
 */
private const val TODO_ALARM_BASE = 2_000_000

fun todoAlarmId(todoId: Int): Int = TODO_ALARM_BASE + todoId

/** 这条待办该在什么时刻响：截止时间往前推 lead 分钟 */
fun todoTriggerAt(dueMillis: Long, leadMinutes: Int): Long = dueMillis - leadMinutes * 60_000L

/** 已经进入提前量窗口的待办，用「id@截止毫秒」记住提醒过没有，避免每轮同步重复响 */
fun todoItemKey(item: TodoReminderItem): String = "${item.id}@${item.dueMillis}"

/**
 * 提前量的人话（通知正文用）。按整小时 / 整天归并，免得出现「还有 1440 分钟到期」。
 */
fun formatTodoLead(minutes: Int): String = when {
    minutes <= 0 -> "到点"
    minutes % (24 * 60) == 0 -> "${minutes / (24 * 60)} 天"
    minutes % 60 == 0 -> "${minutes / 60} 小时"
    else -> "$minutes 分钟"
}

/**
 * 从 `GET /api/todos?status=open` 的响应里解析出可排期的待办。
 *
 * 只认 status=open：历史（已完成 / 已超时）不该再提醒。截止时间解析不出来、id 非法的行
 * 直接跳过 —— 留一条永远不响的比不排更糟，用户会以为提醒坏了。
 * 解析层不看时间范围，窗口由 Scheduler 判：这样同一份数据给「本机待办数」用时不丢条目。
 */
fun parseTodoReminders(root: JSONObject): List<TodoReminderItem> {
    if (!root.optBoolean("success")) return emptyList()
    val list = root.optJSONObject("data")?.optJSONArray("list") ?: return emptyList()
    val out = ArrayList<TodoReminderItem>()
    for (i in 0 until list.length()) {
        val row = list.optJSONObject(i) ?: continue
        if (row.optString("status") != "open") continue
        val id = row.optInt("id", 0)
        if (id <= 0) continue
        val due = parseServerTime(row.optString("due_at")) ?: continue
        val title = row.optString("title").trim().ifBlank { "待办" }
        val tag = row.optJSONArray("tags")?.optString(0)?.trim().orEmpty()
        out.add(TodoReminderItem(id, title, due, tag))
    }
    return out.sortedBy { it.dueMillis }
}

/** 本地存的一份待办快照（Store.todoItemsJson），给断网 / 下次排期用 */
fun todoItemsJson(items: List<TodoReminderItem>): String {
    val arr = JSONArray()
    for (item in items) {
        arr.put(
            JSONObject()
                .put("id", item.id)
                .put("title", item.title)
                .put("due", item.dueMillis)
                .put("tag", item.tag)
        )
    }
    return arr.toString()
}

fun parseTodoItemsJson(json: String?): List<TodoReminderItem> {
    if (json.isNullOrBlank()) return emptyList()
    return try {
        val arr = JSONArray(json)
        val out = ArrayList<TodoReminderItem>()
        for (i in 0 until arr.length()) {
            val row = arr.optJSONObject(i) ?: continue
            val id = row.optInt("id", 0)
            val due = row.optLong("due", 0L)
            if (id <= 0 || due <= 0) continue
            out.add(
                TodoReminderItem(
                    id = id,
                    title = row.optString("title").trim().ifBlank { "待办" },
                    dueMillis = due,
                    tag = row.optString("tag").trim()
                )
            )
        }
        out.sortedBy { it.dueMillis }
    } catch (e: Exception) {
        emptyList()
    }
}
