package com.classassistant.app.sync

import android.content.Context
import com.classassistant.app.data.OfflineCache
import com.classassistant.app.data.Store
import com.classassistant.app.notify.Notifier
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 一轮同步的真实逻辑：拉取活动 / 通知 / 待填表单 → 更新本地缓存 → 重排提醒闹钟 →
 * 对新通知与新表单逐条发提醒。未登录（没有 token）时直接跳过。
 *
 * 为什么从 SyncWorker 里抽出来：现在有两个调用方 —— 15 分钟的周期任务（SyncWorker）
 * 和前台服务（BackgroundSyncService，3 分钟一轮）。两处各写一份的话，
 * 「首轮只记基线、不把历史内容补推一遍」这种口径迟早会走偏，而它一旦走偏就是刷屏级的事故。
 */
object SyncRunner {

    /** 一轮的结局。由调用方翻译成自己的说法：Worker → Result，前台服务 → 记日志/下一轮 */
    enum class Outcome { Done, Retry }

    /**
     * 同一时刻只跑一轮。
     *
     * 现在有两条触发链（服务里的 3 分钟定时器、深 Doze 的兜底闹钟），时机可能撞上。
     * 撞上本身不危险 —— 同一条通知的 id 相同，后发的覆盖先发的 —— 但会白跑一轮网络请求，
     * 而基线也会被两边各写一次。加个闸门最省事：撞上了就直接跳过，反正另一条正在做同一件事。
     */
    private val running = AtomicBoolean(false)

    /**
     * 跑一轮。
     *
     * @param deep 是否连**离线缓存预热**一起做（那 5 个接口）。前台服务每 3 分钟来一发，
     *   那一趟只做「赶紧发现新东西并弹通知」这件事（3 个接口）；预热这种重活留给
     *   15 分钟的周期任务 —— 否则一个班几十号人一天能把 Cloudflare 的免费额度啃穿。
     */
    fun run(context: Context, deep: Boolean = true): Outcome {
        if (!running.compareAndSet(false, true)) return Outcome.Done
        return try {
            runOnce(context, deep)
        } finally {
            running.set(false)
        }
    }

    private fun runOnce(context: Context, deep: Boolean): Outcome {
        val token = Store.token(context) ?: return Outcome.Done
        Notifier.ensureChannels(context)

        // 401 单独处理：token 已失效，重试不会成功，清掉本地会话后收手
        val activitiesRes = Api.get("/api/activities?scope=all&limit=100", token)
        if (activitiesRes is Api.Res.Unauthorized) return logOut(context)
        val noticesRes = Api.get("/api/notices?limit=50", token)
        if (noticesRes is Api.Res.Unauthorized) return logOut(context)
        val todosRes = Api.get("/api/forms/mine", token)
        if (todosRes is Api.Res.Unauthorized) return logOut(context)

        // 这一轮拉到的响应顺手留给离线用（不额外发请求）
        cacheResponse(context, "/api/activities?scope=all&limit=100", activitiesRes)
        cacheResponse(context, "/api/notices?limit=50", noticesRes)
        cacheResponse(context, "/api/forms/mine", todosRes)

        val activities = activitiesRes.listOrNull() ?: return Outcome.Retry
        val notices = noticesRes.listOrNull() ?: return Outcome.Retry
        // 表单拉不到（网络抖动 / 5xx）不拖垮整轮：活动与通知才是主线，
        // 少提醒一条表单待办，比「活动闹钟也一起不排了」轻得多，所以这里按空处理继续往下走。
        val todos = todosRes.dataOrNull()?.optJSONArray("pending")

        val me = Api.decodeUser(token)
        if (me != null) Store.saveUser(context, me.first, me.second)
        val meId = me?.first.orEmpty()
        val meName = me?.second.orEmpty()

        val now = System.currentTimeMillis()
        val horizon = now + HORIZON_MILLIS
        // 缓存下限取「今天 00:00」而不是「现在」：小工具只读这份缓存，标题又叫「今日活动」，
        // 所以一条今天已经开始（甚至已经结束）的活动也必须留着，否则正在进行的活动
        // 会显示成「今日暂无安排」。提醒不受影响 —— rescheduleAlarms 自己会跳过已开始的活动。
        // 判据用的是**活动最后一天**而不是开始时间（下一行的注释），一条跨天的活动因此也留得住。
        val earliest = startOfToday(now)
        val rows = mutableListOf<Event>()

        for (row in activities) {
            val start = parseServerTime(row.optString("start_time")) ?: continue
            // end_time 服务端允许为空（空 = 只占开始那天），解析不出来时也按空处理
            val end = parseServerTime(row.optString("end_time"))
            // 下界按「活动的最后一天」判、上界按开始时间判：一条昨天开始、今天才结束的活动
            // 今天仍在办（主页也还显示它），要是在这里按 start >= 今天 一刀切掉，小组件就会漏。
            // earliest 就是「今天 00:00」，所以这一比就是比日期，与 Event.isEventActiveOnDay 同口径。
            if (startOfToday(end ?: start) < earliest) continue
            if (start > horizon) continue
            if (!isMine(row, meId, meName)) continue
            val id = row.optInt("id", 0)
            if (id == 0) continue
            val title = row.optString("title").ifBlank { "班级活动" }
            val location = row.optString("location").orEmpty()
            rows.add(Event(id, title, start, end, location))
        }

        val sorted = rows.sortedBy { it.startMillis }
        Store.saveEvents(context, JSONArray(sorted.map { event ->
            JSONObject().apply {
                put("id", event.id)
                put("title", event.title)
                put("start", event.startMillis)
                // 没有结束时间就**不写这个键**：小组件那边 optLong 取不到自然是 0，等于「没结束时间」，
                // 写个 0 进去只是让缓存里多一个没意义的字段
                event.endMillis?.let { put("end", it) }
                put("location", event.location)
            }
        }))
        Scheduler.rescheduleAlarms(context, sorted)
        notifyNewNotices(context, notices, meId, meName)
        notifyNewTodos(context, todos)
        if (deep) prewarmOfflineCache(context, token)
        // 课表排期不依赖预热的结果：断网或教务没绑定时预热会失败，但设置改了、
        // 或者滚动的 7 天窗口过期了，仍然要按本地缓存重排一次
        Scheduler.rescheduleCourseAlarms(context)
        // 放在预热之后：课表小组件要读到这一轮刚落地的那份课表
        Scheduler.refreshWidgets(context)
        // 只有整轮拉完才记「上次同步」：失败时这个时间不前进，回前台同步的节流就不会
        // 把重试挡住（见 Scheduler.syncNow），个人页显示的也是真拉到过数据的时间
        Store.setLastSyncAt(context, System.currentTimeMillis())
        return Outcome.Done
    }

    /**
     * 顺手把本次响应留一份给离线用。只在形状对得上时才写（见 OfflineApi 的白名单），
     * 写失败/不符合形状都安静跳过 —— 离线缓存是锦上添花，不能影响同步本身。
     *
     * 注意这几条的 URL 与网页请求的不完全一样（同步取的是给提醒用的窗口），
     * 所以它们主要给「详情回退」当数据源：断网点开某条通知时，是从这些列表缓存里按 id 找回来的。
     */
    private fun cacheResponse(ctx: Context, path: String, res: Api.Res) {
        val body = (res as? Api.Res.Ok)?.body?.toString() ?: return
        val pathOnly = path.substringBefore("?")
        if (!OfflineApi.isCacheablePath(pathOnly)) return
        OfflineCache.write(
            ctx,
            path,
            body,
            if (OfflineApi.isListPath(pathOnly)) OfflineCache.Shape.LIST else OfflineCache.Shape.OTHER
        )
    }

    /**
     * 预热离线缓存：把**网页会请求的**那几份 URL 也拉一遍存下来（清单见 OfflineApi.prewarmPaths），
     * 这样即使某个页面用户很久没打开过，断网时照样有内容可看 ——
     * 离线数据的新鲜度因此跟着后台同步走，而不是「上次打开那个页面时」。
     *
     * 课表那一份还顺带解析成本地课表（见 saveTimetable）：课表小组件与课程提醒都读它。
     * 同一个响应只用一次，所以在这里一并处理，而不是再单独拉一遍。
     *
     * 逐条独立、失败即跳过：教务那三份在没绑定时本来就会失败，属正常情况，不该让整轮同步变红。
     * 顺序上放在主流程之后、记 lastSyncAt 之前，所以这里慢了也只会推迟「上次同步」的显示。
     */
    private fun prewarmOfflineCache(ctx: Context, token: String) {
        for (path in OfflineApi.prewarmPaths()) {
            val res = Api.get(path, token)
            if (res is Api.Res.Unauthorized) return
            cacheResponse(ctx, path, res)
            if (path == OfflineApi.TIMETABLE_PATH) {
                (res as? Api.Res.Ok)?.body?.let { saveTimetable(ctx, it) }
            }
        }
    }

    /**
     * 把教务课表落到本地。
     *
     * **只认解析成功的那一份**，失败时保留上一次的课表：教务没绑定 / 登录态过期时后端回
     * `success:false`，这时把本地课表清掉，小组件就会变成「还没同步到课表」、
     * 课程提醒也全没了 —— 可用户的课表明明一学期都不怎么变，刚绑定过的人更是完全没理由被清。
     */
    private fun saveTimetable(ctx: Context, body: JSONObject) {
        if (parseTimetable(body) == null) return
        Store.saveTimetableJson(ctx, body.toString())
    }

    /**
     * 这条活动 / 通知该不该提醒当前用户：remind_people 为空按「全班」处理，否则只提醒名单里的人
     * （名单里存的是姓名或用户 id，见 Api.parsePeople）。
     *
     * 活动、通知两条路都走这一份判定 —— 只在活动那边写一遍的话，通知就会「没被点名也弹」，
     * 与网页列表的 remindMe()、服务端「推给谁」的口径都不一致（见后端 utils/audience.js）。
     * 待填表单不走这里：/api/forms/mine 服务端已按提醒对象滤过，客户端再滤一遍是白做。
     */
    private fun isMine(row: JSONObject, meId: String, meName: String): Boolean {
        val people = Api.parsePeople(row.opt("remind_people"))
        if (people.isEmpty()) return true
        return (meName.isNotBlank() && people.contains(meName)) ||
            (meId.isNotBlank() && people.contains(meId))
    }

    /** 同步时发现比上次更新更晚的通知，逐条提醒一次（只提醒提醒对象里的，见 isMine） */
    private fun notifyNewNotices(context: Context, rows: List<JSONObject>, meId: String, meName: String) {
        // 先按提醒对象筛一道再算基线：lastNoticeTime 记的必须是「我该看到的」最新时间，
        // 否则会拿别人的通知时间当基线，回头真点名我的那条反倒被当成旧的漏掉。
        val mine = rows.filter { isMine(it, meId, meName) }
        val pick = pickFresh(mine.map { parseServerTime(it.optString("publish_time")) }, Store.lastNoticeTime(context))

        // 每条新通知单独发一条、各带自己的深链（网页侧 index.html 读 ?view= / ?id= 后落到该条），互不覆盖
        for (i in pick.fresh) {
            val row = mine[i]
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
        pick.baseline?.let { Store.setLastNoticeTime(context, it) }
    }

    /**
     * 同步时发现比上次更新更晚的待填表单，逐条提醒一次。
     *
     * 与 notifyNewNotices 同一套「首次同步只记基线」的逻辑（共用 pickFresh）：装机时把当前
     * 所有待填表单一起推不是提醒，是刷屏。判新用 created_at（服务端下发时刻），
     * 口径与通知的 publish_time 一致。表单在 App 里没有列表页，点通知直接开网页的填写页
     * （forms.html?id=…），与 Web Push 那条 url 是同一个落地页；通知 id 另开一段号，避免互相顶掉。
     */
    private fun notifyNewTodos(context: Context, rows: JSONArray?) {
        if (rows == null) return

        val items = mutableListOf<Triple<Int, Long, String>>() // id, created_at, title
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val id = row.optInt("id", 0)
            val time = parseServerTime(row.optString("created_at")) ?: continue
            if (id == 0) continue
            items.add(Triple(id, time, row.optString("title").ifBlank { "待填表单" }))
        }
        val pick = pickFresh(items.map { it.second }, Store.lastTodoTime(context))

        for (i in pick.fresh) {
            val (id, _, title) = items[i]
            Notifier.notifyNotice(
                context,
                FORM_ID_BASE + id,
                "新的待填表单：$title",
                "待填表单，点击打开填写",
                "forms.html?id=$id"
            )
        }
        pick.baseline?.let { Store.setLastTodoTime(context, it) }
    }

    /**
     * token 已被服务端判为失效（401）。再重试也不会有结果，清掉本地会话后返回成功，
     * 等用户在网页重新登录时由探针把新 token 推过来。
     */
    private fun logOut(context: Context): Outcome {
        logOutSession(context)
        return Outcome.Done
    }

    internal data class FreshPick(val fresh: List<Int>, val baseline: Long?)

    /**
     * 「哪些是新出现的 + 新基线该记到哪」。两个提醒入口共用这一份判定，它值得单独抽成纯函数
     * 是因为它是**刷屏的唯一防线**：前台服务 3 分钟来一轮，判定写错一次，用户一屏都是旧通知。
     *
     * 两条规则：
     *   1. 首次同步（lastSeen == 0）只记基线、什么都不弹 —— 装机时把历史上的通知全推一遍不是提醒
     *   2. 时间戳解析不出来的条目一律不算新（宁可漏一条，也不要把解析失败的 0 当成「很旧」而误判）
     *
     * @param stamps 与待判定条目一一对应的时间戳；null = 这条解析不出时间
     * @return fresh 是新条目的下标；baseline 为 null 表示这一轮不需要写回基线
     */
    internal fun pickFresh(stamps: List<Long?>, lastSeen: Long): FreshPick {
        val newest = stamps.filterNotNull().maxOrNull() ?: return FreshPick(emptyList(), null)
        if (lastSeen == 0L) return FreshPick(emptyList(), newest)
        val fresh = stamps.indices.filter { stamps[it]?.let { t -> t > lastSeen } == true }
        return FreshPick(fresh, if (newest > lastSeen) newest else null)
    }

    /** 未来多久内的活动要缓存并排闹钟 */
    const val HORIZON_MILLIS = 7L * 24 * 60 * 60 * 1000

    /**
     * 通知 id 基数：每条通知用 NOTICE_ID_BASE + 通知 id，天然去重（同一条重复同步不会叠加）。
     * 必须与活动提醒的 id（直接用活动 id，见 Notifier.notifyActivity）拉开距离，
     * 否则两个列表里 id 相同的记录会互相顶掉。
     */
    const val NOTICE_ID_BASE = 100_000

    /**
     * 待填表单的通知 id 基数，理由同上：表单 id 与通知 id 各从 1 开始，
     * 不加偏移的话「通知 3」和「表单 3」会共用同一个通知 id，后发的把先发的顶掉。
     * 三段各自留足 10 万空间，与鸿蒙端 Constants.TODO_ID_BASE 保持同值。
     */
    const val FORM_ID_BASE = 200_000

    /**
     * 退出登录（网页里退出 → 探针回传空 token，或服务端判 401）：取消已排闹钟、
     * 清掉同步缓存与凭据、重绘小组件。两处调用点必须共用这一份 —— 少做一步就会留下
     * 上一个账号的活动显示，或让旧闹钟继续响。
     */
    fun logOutSession(context: Context) {
        // 顺序要紧：rescheduleAlarms 是照着 scheduled_alarm_ids 里的记录逐个取消的，
        // 若先把存储清了，这些 id 就丢了，闹钟会留在系统里继续响。
        Scheduler.rescheduleAlarms(context, emptyList())
        // 课程提醒闹钟同理，得赶在 clearSession 把它们从存储里抹掉之前取消
        Scheduler.cancelCourseAlarms(context)
        Store.clearSession(context)
        // 离线缓存也要清：留着的话换账号后断网能翻到上一个账号的通知与课表
        OfflineCache.clear(context)
        // 两个小组件都要重绘：不然退出登录后桌面还挂着上一个账号的活动与课程
        Scheduler.refreshWidgets(context)
        // 后台常驻的服务也停掉：没登录它每轮都是空跑，留着只是白挂一条常驻通知。
        // 放在最后 —— clearSession 已经清了 token，apply 会据此选择停掉
        BackgroundMode.apply(context)
    }

    /**
     * 个人页「推送通知测试」用：拉最新一条真实活动 / 通知，按其 id 与深链发一条本地通知，
     * 让用户自查推送是否可达、点通知能否跳到对应详情。
     * kind 为 "activity" / "notice"；返回值是一句结果提示，网页直接展示（不做二次判断）。
     * 复用真实 id：和正式提醒同号，重复点会覆盖而不是叠一堆，深链也一致。
     */
    fun pushTestNotification(context: Context, kind: String): String {
        val token = Store.token(context) ?: return "请先登录后再测试推送"
        // 通知权限被关掉时，下面 notify() 抛的 SecurityException 会被静默吞掉，
        // 这一页却回一句「已推送」—— 用户去通知栏找不到东西，只会以为推送坏了。
        // 所以先查一次权限，把真实原因说出来（个人页那一行状态显示的是同一件事）。
        if (!Notifier.notificationsEnabled(context)) {
            return "通知权限未开启，收不到提醒。请到「系统设置 → 通知」里允许「班级助理」发通知"
        }
        val res = when (kind) {
            "activity" -> Api.get("/api/activities?scope=all&limit=1", token)
            "notice" -> Api.get("/api/notices?scope=all&limit=1", token)
            else -> return "未知的推送类型"
        }
        if (res is Api.Res.Unauthorized) return "登录态已失效，请重新登录"
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
            "已发送活动提醒：$title"
        } else {
            val title = row.optString("title").ifBlank { "班级通知" }
            Notifier.notifyNotice(
                context,
                NOTICE_ID_BASE + id,
                title,
                row.optString("content").replace("\n", " ").take(120).ifBlank { "点击查看详情" },
                "?view=notices&id=$id"
            )
            "已发送通知提醒：$title"
        }
    }
}
