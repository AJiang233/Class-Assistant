package com.classassistant.app.sync

import org.json.JSONArray
import org.json.JSONObject

/** 一轮固定上界的服务端变更在内存中归并，完整收齐之后才替换持久快照。 */
class SyncSnapshot(raw: String? = null, private val now: Long = System.currentTimeMillis()) {
    private val state = if (raw == null) JSONObject() else JSONObject(raw)
    var cursor: Long = state.optLong("cursor", 0)
        private set
    var rules: String = state.optString("rules", "")
        private set
    var initialized: Boolean = state.optBoolean("initialized", false)
        private set
    private var until: Long? = null
    private val items = state.optJSONObject("items") ?: JSONObject()
    private val pending = state.optJSONObject("pending") ?: JSONObject()
    private val baseline = initialized

    fun requestPath(): String = "/api/sync?after=$cursor&limit=100" +
        (if (rules.isEmpty()) "" else "&rules=$rules") + (until?.let { "&until=$it" } ?: "") +
        (if (!baseline) "&snapshot=1" else "")

    /** 协议错误拒绝整轮，不能在数据不完整时推进游标。 */
    fun applyPage(page: JSONObject): Boolean {
        require(page.getInt("version") == 1) { "同步协议版本不支持" }
        val next = page.getLong("cursor")
        val bound = page.getLong("until")
        val nextRules = page.getString("rules")
        require(next >= cursor && next <= bound && (until == null || until == bound)) { "同步游标不连续" }
        require(rules.isEmpty() || rules == nextRules) { "受众规则已变化" }
        val changes = page.getJSONArray("changes")
        var previous = cursor
        for (i in 0 until changes.length()) {
            val change = changes.getJSONObject(i)
            val seq = change.getLong("seq")
            require(seq > previous && seq <= next) { "同步变更顺序不正确" }
            previous = seq
            val kind = change.getString("kind")
            require(kind in setOf("notices", "activities", "forms")) { "同步内容类型不支持" }
            val key = "$kind:${change.getInt("id")}"
            if (change.getBoolean("deleted")) {
                items.remove(key)
                pending.remove(key)
            } else {
                val row = change.getJSONObject("row")
                val futureNotice = kind == "notices" &&
                    (parseServerTime(row.optString("publish_time")) ?: 0) > now
                if ((baseline || futureNotice) && !items.has(key) && kind != "activities" &&
                    !(kind == "notices" && row.optString("source") == "form")) pending.put(key, true)
                items.put(key, row)
            }
        }
        val more = page.getBoolean("hasMore")
        require(!more || next > cursor) { "同步分页未前进" }
        require(more || next == bound) { "同步快照尚未完整" }
        cursor = next
        until = bound
        rules = nextRules
        if (!more) initialized = true
        return more
    }

    fun rows(kind: String): List<JSONObject> = items.keys().asSequence()
        .filter { it.startsWith("$kind:") }.map { items.getJSONObject(it) }.toList()

    fun pendingItems(): List<Pair<String, JSONObject>> = pending.keys().asSequence()
        .filter { items.has(it) }.map { it to items.getJSONObject(it) }.toList()

    fun acknowledge(key: String) { pending.remove(key) }

    fun encode(): String = JSONObject().put("cursor", cursor).put("rules", rules)
        .put("initialized", initialized).put("items", items).put("pending", pending).toString()
}
