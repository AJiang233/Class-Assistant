package com.classassistant.app.sync

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SyncSnapshotTest {
    private fun change(seq: Long, id: Int, deleted: Boolean = false): JSONObject = JSONObject()
        .put("seq", seq).put("kind", "notices").put("id", id).put("deleted", deleted)
        .put("row", JSONObject().put("id", id).put("title", "同一秒发布的通知"))

    private fun page(cursor: Long, until: Long = cursor, more: Boolean = false,
                     vararg changes: JSONObject): JSONObject = JSONObject()
        .put("version", 1).put("rules", "规则一").put("cursor", cursor).put("until", until)
        .put("hasMore", more).put("changes", JSONArray(changes))

    @Test fun `首次完整基线不补推历史，后续同秒通知都进入待提醒队列`() {
        val first = SyncSnapshot()
        assertTrue(first.applyPage(page(1, 2, true, change(1, 1))))
        assertFalse(first.initialized)
        assertTrue(first.requestPath().contains("until=2"))
        assertFalse(first.applyPage(page(2, 2, false, change(2, 2))))
        assertTrue(first.pendingItems().isEmpty())
        val next = SyncSnapshot(first.encode())
        next.applyPage(page(4, 4, false, change(3, 3), change(4, 4)))
        assertEquals(setOf("notices:3", "notices:4"), next.pendingItems().map { it.first }.toSet())
        val restored = SyncSnapshot(next.encode())
        assertEquals(4, restored.rows("notices").size)
        assertEquals(2, restored.pendingItems().size)
    }

    @Test fun `删除撤回本地条目及尚未发出的提醒，编辑不重复提醒`() {
        val state = SyncSnapshot()
        state.applyPage(page(0))
        val next = SyncSnapshot(state.encode())
        next.applyPage(page(1, 1, false, change(1, 1)))
        val edit = SyncSnapshot(next.encode())
        edit.acknowledge("notices:1")
        edit.applyPage(page(2, 2, false, change(2, 1)))
        assertTrue(edit.pendingItems().isEmpty())
        val deletion = SyncSnapshot(edit.encode())
        deletion.applyPage(page(3, 3, false, change(3, 1, true)))
        assertTrue(deletion.rows("notices").isEmpty())
    }

    @Test fun `分页中断不修改原持久快照，重试可以从原游标开始`() {
        val state = SyncSnapshot()
        state.applyPage(page(0))
        val saved = state.encode()
        val attempt = SyncSnapshot(saved)
        attempt.applyPage(page(1, 3, true, change(1, 1)))
        val retry = SyncSnapshot(saved)
        assertEquals(0, retry.cursor)
        retry.applyPage(page(3, 3, false, change(1, 1), change(2, 2), change(3, 3)))
        assertEquals(3, retry.rows("notices").size)
    }

    @Test fun `拒绝倒退和重复序号、变化的上界和不同规则`() {
        val first = SyncSnapshot()
        first.applyPage(page(1, 3, true, change(1, 1)))
        assertThrows(IllegalArgumentException::class.java) { first.applyPage(page(0, 3, true)) }
        assertThrows(IllegalArgumentException::class.java) { first.applyPage(page(2, 4, true, change(2, 2))) }
        assertThrows(IllegalArgumentException::class.java) { first.applyPage(page(2, 3, true, change(1, 1))) }
        assertThrows(IllegalArgumentException::class.java) { first.applyPage(page(2, 3, true).put("rules", "规则二")) }
    }

    @Test fun `首次同步保留未来生效提醒，联动通知不重复提醒`() {
        val future = change(1, 1)
        future.getJSONObject("row").put("publish_time", "2030-01-01 08:00:00")
        val linked = change(2, 2)
        linked.getJSONObject("row").put("publish_time", "2030-01-01 08:00:00").put("source", "form")
        val first = SyncSnapshot(now = 0)
        first.applyPage(page(2, 2, false, future, linked))
        assertEquals(listOf("notices:1"), first.pendingItems().map { it.first })
    }
}
