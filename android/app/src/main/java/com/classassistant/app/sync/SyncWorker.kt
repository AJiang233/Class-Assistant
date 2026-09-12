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
 * 后台同步：拉取活动与通知 → 更新本地缓存 → 重排提醒闹钟 → 对新通知逐条发提醒。
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
        // 缓存下限取「今天 00:00」而不是「现在」：小工具只读这份缓存，标题又叫「今日活动」，
        // 所以一条今天已经开始（甚至已经结束）的活动也必须留着，否则正在进行的活动
        // 会显示成「今日暂无安排」。提醒不受影响 —— rescheduleAlarms 自己会跳过已开始的活动。
        val earliest = startOfToday(now)
        val rows = mutableListOf<Event>()

        for (row in activities) {
            val start = parseServerTime(row.optString("start_time")) ?: continue
            if (start < earliest || start > horizon) continue
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
        TodayWidgetProvider.refreshAll(ctx)
        return Result.success()
    }

    /** 同步时发现比上次更新更晚的通知，逐条提醒一次 */
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
        // 每条新通知单独发一条、各带自己的深链（网页侧 index.html 读 ?view= / ?id= 后落到该条），互不覆盖
        for (row in fresh) {
            val id = row.optInt("id", 0)
            if (id == 0) continue
            Notifier.notifyNotice(
                context,
                NOTICE_ID_BASE + id,
                row.optString("title").ifBlank { "新的班级通知" },
                row.optString("content").replace("\n", " ").take(120).ifBlank { "点击查看详情" },
                "?view=notices&id=$id"
            )
        }
        if (newest > lastSeen) Store.setLastNoticeTime(context, newest)
    }

    /**
     * token 已被服务端判为失效（401）。再重试也不会有结果，清掉本地会话后返回成功，
     * 等用户在网页重新登录时由探针把新 token 推过来。
     */
    private fun logOut(context: Context): Result {
        logOutSession(context)
        return Result.success()
    }

    companion object {
        const val HORIZON_MILLIS = 7L * 24 * 60 * 60 * 1000

        /**
         * 退出登录（网页里退出 → 探针回传空 token，或服务端判 401）：取消已排闹钟、
         * 清掉同步缓存与凭据、重绘小组件。两处调用点必须共用这一份 —— 少做一步就会留下
         * 上一个账号的活动显示，或让旧闹钟继续响。
         */
        fun logOutSession(context: Context) {
            // 顺序要紧：rescheduleAlarms 是照着 scheduled_alarm_ids 里的记录逐个取消的，
            // 若先把存储清了，这些 id 就丢了，闹钟会留在系统里继续响。
            Scheduler.rescheduleAlarms(context, emptyList())
            Store.clearSession(context)
            TodayWidgetProvider.refreshAll(context)
        }

        /**
         * 个人页「推送通知测试」用：拉最新一条真实活动 / 通知，按其 id 与深链发一条本地通知，
         * 让用户自查推送是否可达、点通知能否跳到对应详情。
         * kind 为 "activity" / "notice"；返回值是一句结果提示，网页直接展示（不做二次判断）。
         * 复用真实 id：和正式提醒同号，重复点会覆盖而不是叠一堆，深链也一致。
         */
        fun pushTestNotification(context: Context, kind: String): String {
            val token = Store.token(context) ?: return "请先登录后再测试推送"
            val res = when (kind) {
                "activity" -> Api.get("/api/activities?scope=all&limit=1", token)
                "notice" -> Api.get("/api/notices?scope=all&limit=1", token)
                else -> return "未知的推送类型"
            }
            if (res is Api.Res.Unauthorized) return "登录态已失效，请重新登录后再试"
            // 取最新一条：两个列表接口都是最新在前（活动按 start_time DESC，通知按 publish_time DESC）
            val row = res.listOrNull()?.firstOrNull() ?: return "没有拉到数据，请检查网络"
            val id = row.optInt("id", 0)
            if (id == 0) return "数据缺少 id，无法推送"

            Notifier.ensureChannels(context)
            return if (kind == "activity") {
                val title = row.optString("title").ifBlank { "班级活动" }
                val start = parseServerTime(row.optString("start_time"))
                Notifier.notifyActivity(
                    context,
                    id,
                    title,
                    if (start != null) "${formatDayClock(start)} 开始" else "即将开始",
                    row.optString("location")
                )
                "已推送活动：$title"
            } else {
                val title = row.optString("title").ifBlank { "班级通知" }
                Notifier.notifyNotice(
                    context,
                    NOTICE_ID_BASE + id,
                    title,
                    row.optString("content").replace("\n", " ").take(120).ifBlank { "点击查看详情" },
                    "?view=notices&id=$id"
                )
                "已推送通知：$title"
            }
        }

        /**
         * 通知 id 基数：每条通知用 NOTICE_ID_BASE + 通知 id，天然去重（同一条重复同步不会叠加）。
         * 必须与活动提醒的 id（直接用活动 id，见 Notifier.notifyActivity）拉开距离，
         * 否则两个列表里 id 相同的记录会互相顶掉。
         */
        const val NOTICE_ID_BASE = 100_000
    }
}
