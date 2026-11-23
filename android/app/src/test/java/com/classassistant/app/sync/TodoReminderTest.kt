package com.classassistant.app.sync

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 待办提醒的纯逻辑：解析、号段、提前量换算、本地快照的序列化。
 *
 * 这些算错了不会崩，只会表现成「提醒不响 / 响错时间 / 换账号后还响」，
 * 在真机上很难复现，所以把形状钉在这里。
 */
class TodoReminderTest {

    private fun body(vararg rows: JSONObject): JSONObject = JSONObject()
        .put("success", true)
        .put("data", JSONObject().put("list", org.json.JSONArray().apply { rows.forEach { put(it) } }))

    private fun row(id: Int, title: String, due: String, status: String = "open", tags: List<String> = emptyList()) =
        JSONObject()
            .put("id", id)
            .put("title", title)
            .put("due_at", due)
            .put("status", status)
            .put("tags", org.json.JSONArray(tags))

    @Test
    fun `只解析进行中且字段完整的待办`() {
        val items = parseTodoReminders(
            body(
                row(1, "交作业", "2099-01-01 10:00:00"),
                row(2, "已完成的", "2099-01-02 10:00:00", status = "done"),
                row(3, "已过期的", "2099-01-03 10:00:00", status = "expired"),
                row(0, "没有 id", "2099-01-04 10:00:00"),
                row(4, "截止时间坏了", "not-a-time")
            )
        )
        assertEquals(1, items.size)
        assertEquals(1, items[0].id)
        assertEquals("交作业", items[0].title)
    }

    @Test
    fun `标签取第一个，没有标签就是空串`() {
        val items = parseTodoReminders(
            body(
                row(1, "带标签", "2099-01-01 10:00:00", tags = listOf("作业", "考试")),
                row(2, "无标签", "2099-01-02 10:00:00")
            )
        )
        assertEquals("作业", items[0].tag)
        assertEquals("", items[1].tag)
    }

    @Test
    fun `解析失败或没有列表时返回空，不抛异常`() {
        assertTrue(parseTodoReminders(JSONObject().put("success", false)).isEmpty())
        assertTrue(parseTodoReminders(JSONObject().put("success", true)).isEmpty())
        assertTrue(parseTodoReminders(JSONObject().put("success", true).put("data", "not-an-object")).isEmpty())
    }

    @Test
    fun `闹钟 requestCode 落在 200 万号段`() {
        assertEquals(2_000_001, todoAlarmId(1))
        assertEquals(2_000_000 + 99, todoAlarmId(99))
    }

    @Test
    fun `触发时刻是截止时间往前推提前量`() {
        val due = 1_700_000_000_000L
        assertEquals(due, todoTriggerAt(due, 0))
        assertEquals(due - 60 * 60_000L, todoTriggerAt(due, 60))
        assertEquals(due - 24 * 60 * 60_000L, todoTriggerAt(due, 24 * 60))
    }

    @Test
    fun `提前量按整天整小时说人话`() {
        assertEquals("到点", formatTodoLead(0))
        assertEquals("30 分钟", formatTodoLead(30))
        assertEquals("1 小时", formatTodoLead(60))
        assertEquals("2 小时", formatTodoLead(120))
        assertEquals("90 分钟", formatTodoLead(90))
        assertEquals("1 天", formatTodoLead(24 * 60))
        assertEquals("2 天", formatTodoLead(2 * 24 * 60))
    }

    @Test
    fun `本地快照能原样存取`() {
        val source = listOf(
            TodoReminderItem(1, "交作业", 1_700_000_000_000L, "作业"),
            TodoReminderItem(2, "无标签", 1_700_100_000_000L, "")
        )
        val restored = parseTodoItemsJson(todoItemsJson(source))
        assertEquals(source, restored)
    }

    @Test
    fun `坏掉的本地快照当空处理`() {
        assertTrue(parseTodoItemsJson(null).isEmpty())
        assertTrue(parseTodoItemsJson("").isEmpty())
        assertTrue(parseTodoItemsJson("not json").isEmpty())
        assertTrue(parseTodoItemsJson("""[{"id":0,"due":1},{"id":1,"due":0}]""").isEmpty())
    }
}
