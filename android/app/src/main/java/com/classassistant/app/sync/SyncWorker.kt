package com.classassistant.app.sync

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.classassistant.app.data.Store
import com.classassistant.app.notify.Notifier
import com.classassistant.app.widget.TodayWidgetProvider
import org.json.JSONArray
import org.json.JSONObject

/**
 * 后台同步：拉取活动与通知 → 更新本地缓存 → 重排提醒闹钟 → 对新通知发一条提醒。
 * 未登录（没有 token）时直接跳过，等用户在网页里登录后由 MainActivity 触发。
 */
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val ctx = applicationContext
        val token = Store.token(ctx) ?: return Result.success()
        Notifier.ensureChannels(ctx)

        // 401 单独处理：token 已失效，重试不会成功，清掉本地会话后收手
        val activitiesRes = Api.get("/api/activities?scope=all&limit=100", token)
        if (activitiesRes is Api.Res.Unauthorized) return logOut(ctx)
        val noticesRes = Api.get("/api/notices?limit=50", token)
        if (noticesRes is Api.Res.Unauthorized) return logOut(ctx)

        val activities = activitiesRes.listOrNull() ?: return Result.retry()
        val notices = noticesRes.listOrNull() ?: return Result.retry()

        val me = Api.decodeUser(token)
        if (me != null) Store.saveUser(ctx, me.first, me.second)
        val meId = me?.first.orEmpty()
        val meName = me?.second.orEmpty()

        val now = System.currentTimeMillis()
        val horizon = now + HORIZON_MILLIS
        val rows = mutableListOf<Event>()

        for (row in activities) {
            val start = parseServerTime(row.optString("start_time")) ?: continue
            if (start < now - 60_000L || start > horizon) continue
            // remind_people 为空按「全班」处理；否则只提醒名单里的人
            val people = Api.parsePeople(row.opt("remind_people"))
            val mine = people.isEmpty() ||
                (meName.isNotBlank() && people.contains(meName)) ||
                (meId.isNotBlank() && people.contains(meId))
            if (!mine) continue
            val id = row.optInt("id", 0)
            if (id == 0) continue
            val title = row.optString("title").ifBlank { "班级活动" }
            val location = row.optString("location").orEmpty()
            rows.add(Event(id, title, start, location))
        }

        val sorted = rows.sortedBy { it.startMillis }
        Store.saveEvents(ctx, JSONArray(sorted.map { event ->
            JSONObject().apply {
                put("id", event.id)
                put("title", event.title)
                put("start", event.startMillis)
                put("location", event.location)
            }
        }))
        Scheduler.rescheduleAlarms(ctx, sorted)
        notifyNewNotices(ctx, notices)
        Store.markSynced(ctx)
        TodayWidgetProvider.refreshAll(ctx)
        return Result.success()
    }

    /** 同步时发现比上次更新更晚的通知，就提醒一次 */
    private fun notifyNewNotices(context: Context, rows: List<JSONObject>) {
        val times = rows.mapNotNull { parseServerTime(it.optString("publish_time")) }
        val newest = times.maxOrNull() ?: return
        val lastSeen = Store.lastNoticeTime(context)

        if (lastSeen == 0L) {
            // 首次同步只记录基线，避免装机时把历史通知全推一遍
            Store.setLastNoticeTime(context, newest)
            return
        }

        val fresh = rows.filter { row ->
            val t = parseServerTime(row.optString("publish_time"))
            t != null && t > lastSeen
        }
        if (fresh.isNotEmpty()) {
            val title = if (fresh.size == 1) {
                fresh.first().optString("title").ifBlank { "新的班级通知" }
            } else {
                "有 ${fresh.size} 条新的班级通知"
            }
            val body = if (fresh.size == 1) {
                fresh.first().optString("content").replace("\n", " ").take(120).ifBlank { "点击查看详情" }
            } else {
                fresh.take(3).joinToString("、") { it.optString("title") }.take(120)
            }
            Notifier.notifyNotice(context, NOTICE_NOTIFICATION_ID, title, body)
        }
        if (newest > lastSeen) Store.setLastNoticeTime(context, newest)
    }

    /**
     * token 已被服务端判为失效（401）。再重试也不会有结果，清掉本地会话后返回成功，
     * 等用户在网页重新登录时由探针把新 token 推过来。
     */
    private fun logOut(context: Context): Result {
        Store.clearSession(context)
        return Result.success()
    }

    private companion object {
        const val HORIZON_MILLIS = 7L * 24 * 60 * 60 * 1000
        const val NOTICE_NOTIFICATION_ID = 9001
    }
}
