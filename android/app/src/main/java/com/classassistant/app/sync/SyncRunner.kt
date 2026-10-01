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
     *   那一趟只消费增量同步接口；预热这种重活留给
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

        var snapshot = try { SyncSnapshot(Store.syncSnapshot(context)) } catch (_: Exception) { SyncSnapshot() }
        var reset = false
        try {
            var pages = 0
            do {
                val response = Api.get(snapshot.requestPath(), token)
                synchronized(Store) {
                    if (Store.token(context) != token) return Outcome.Done
                    if (response is Api.Res.Unauthorized) return logOut(context)
                }
                val page = response.dataOrNull() ?: return Outcome.Retry
                if (page.optBoolean("reset", false)) {
                    if (reset) return Outcome.Retry
                    reset = true
                    snapshot = SyncSnapshot()
                    continue
                }
                val more = snapshot.applyPage(page)
                pages++
                // 同步历史过大时让调用方重试；完整快照之前不触碰持久游标。
                if (pages > 1000) return Outcome.Retry
                if (!more) break
            } while (true)
        } catch (_: Exception) {
            return Outcome.Retry
        }
        val activities = snapshot.rows("activities")

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
            val id = row.optInt("id", 0)
            if (id == 0) continue
            val title = row.optString("title").ifBlank { "班级活动" }
            val location = row.optString("location").orEmpty()
            rows.add(Event(id, title, start, end, location))
        }

        val sorted = rows.sortedBy { it.startMillis }
        val events = JSONArray(sorted.map { event ->
            JSONObject().apply {
                put("id", event.id)
                put("title", event.title)
                put("start", event.startMillis)
                // 没有结束时间就**不写这个键**：小组件那边 optLong 取不到自然是 0，等于「没结束时间」，
                // 写个 0 进去只是让缓存里多一个没意义的字段
                event.endMillis?.let { put("end", it) }
                put("location", event.location)
            }
        })
        synchronized(Store) {
            if (!Store.commitSync(context, token, snapshot.encode(), events)) return Outcome.Retry
            Scheduler.rescheduleAlarms(context, sorted)
            notifyPending(context, token, snapshot, now)
        }
        if (deep) prewarmOfflineCache(context, token)
        // 课表排期不依赖预热的结果：断网或教务没绑定时预热会失败，但设置改了、
        // 或者滚动的 7 天窗口过期了，仍然要按本地缓存重排一次
        synchronized(Store) {
            if (Store.token(context) != token) return Outcome.Done
            Scheduler.rescheduleCourseAlarms(context)
            // 放在预热之后：课表小组件要读到这一轮刚落地的那份课表
            Scheduler.refreshWidgets(context)
            // 只有整轮拉完才记「上次同步」：失败时这个时间不前进，回前台同步的节流就不会
            // 把重试挡住（见 Scheduler.syncNow），个人页显示的也是真拉到过数据的时间
            Store.setLastSyncAt(context, System.currentTimeMillis())
        }
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
            synchronized(Store) {
                if (Store.token(ctx) != token || res is Api.Res.Unauthorized) return
                cacheResponse(ctx, path, res)
                if (path == OfflineApi.TIMETABLE_PATH) {
                    (res as? Api.Res.Ok)?.body?.let { saveTimetable(ctx, it) }
                }
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

    /** 待提醒项与游标同批持久保存，发送后确认；崩溃重放使用相同系统通知 ID。 */
    private fun notifyPending(context: Context, token: String, snapshot: SyncSnapshot, now: Long) {
        for ((key, row) in snapshot.pendingItems()) {
            if (Store.token(context) != token) return
            val id = row.optInt("id")
            if (key.startsWith("notices:")) {
                val published = parseServerTime(row.optString("publish_time"))
                if (published != null && published > now) continue
                val expires = parseServerTime(row.optString("expire_time"))
                if (expires == null || expires >= now) {
                    Notifier.notifyNotice(context, NOTICE_ID_BASE + id, row.optString("title"),
                        row.optString("content").replace("\n", " ").take(120), "?view=notices&id=$id")
                }
            } else {
                val deadline = parseServerTime(row.optString("deadline"))
                if (row.optString("status") == "open" && !row.optBoolean("submitted") &&
                    (row.optString("edit_policy") == "always" || deadline == null || deadline >= now)) {
                    Notifier.notifyForm(context, FORM_ID_BASE + id, "新的待填表单：${row.optString("title")}",
                        "待填表单，点击打开填写", "forms.html?id=$id")
                }
            }
            snapshot.acknowledge(key)
            if (!Store.commitSync(context, token, snapshot.encode())) return
        }
    }

    /**
     * token 已被服务端判为失效（401）。再重试也不会有结果，清掉本地会话后返回成功，
     * 等用户在网页重新登录时由探针把新 token 推过来。
     */
    private fun logOut(context: Context): Outcome {
        logOutSession(context)
        return Outcome.Done
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
    fun logOutSession(context: Context) = synchronized(Store) {
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
     * 换了一份登录凭据，要不要把上一个账号的本地数据清掉（issue #64）。
     *
     * 判据是**用户 id**，不是 token 字符串：同一个人重新登录也会拿到一条新的 JWT，
     * 按 token 判的话每次重新登录都会把课表与离线缓存清空。三种情况：
     *  - 本地没记过 id（首次登录，或从没写过这个字段的旧版本升上来）：没东西可清，返回 false；
     *  - 新 token 解不出 id：**按换人处理**。正规签发的 token 一定带 id（见后端
     *    authHandler 的 sign({ id, student_id, name })），解不出来就说明这份凭据不可信 ——
     *    宁可多清一次（数据下次同步就回来了），也不能让上一个账号的课表与离线缓存留下来；
     *  - 两个 id 相同：同一个人换了 JWT，本地数据原样留着。
     */
    internal fun isAccountSwitch(prevUserId: String?, nextUserId: String?): Boolean {
        if (prevUserId.isNullOrBlank()) return false
        if (nextUserId.isNullOrBlank()) return true
        return prevUserId != nextUserId
    }

    /**
     * 个人页「推送通知测试」用：拉最新一条真实活动 / 通知 / 表单，按其 id 与深链发一条本地通知，
     * 让用户自查推送是否可达、点通知能否跳到对应详情。
     * kind 为 "activity" / "notice" / "form"；返回值是一句结果提示，网页直接展示（不做二次判断）。
     * 复用真实 id：和正式提醒同号，重复点会覆盖而不是叠一堆，深链也一致 —— 这也是它**必须**
     * 依赖「班里真有一条内容」的原因：通知没法凭空编一条点进去有东西的详情。
     *
     * 「班里还没有内容」与「请求失败」要分两句话：新班级里一条活动都没有属正常空态，
     * 回「请检查网络」会把用户支去查网络（网络其实好好的），得让他知道该先发一条内容。
     */
    fun pushTestNotification(context: Context, kind: String): String {
        val token = Store.token(context) ?: return "请先登录后再测试推送"
        // 通知权限被关掉时，下面 notify() 抛的 SecurityException 会被静默吞掉，
        // 这一页却回一句「已推送」—— 用户去通知栏找不到东西，只会以为推送坏了。
        // 所以先查一次权限，把真实原因说出来（个人页那一行状态显示的是同一件事）。
        if (!Notifier.notificationsEnabled(context)) {
            return "通知权限未开启，收不到提醒。请到「系统设置 → 通知」里允许「班级助理」发通知"
        }

        // 各类型取「最新一条真实内容」：活动 / 通知走列表接口（都是最新在前 —— 活动按
        // start_time DESC、通知按 publish_time DESC），表单走 /api/forms/mine 的 data.pending
        // （ORDER BY created_at DESC）；全交过时 pending 为空，退回 editable，免得「有表单却报没有」。
        val row: JSONObject = when (kind) {
            "activity", "notice" -> {
                val isActivity = kind == "activity"
                val res = Api.get(
                    if (isActivity) "/api/activities?scope=all&limit=1" else "/api/notices?scope=all&limit=1",
                    token
                )
                if (res is Api.Res.Unauthorized) return "登录态已失效，请重新登录"
                res.listOrNull()?.firstOrNull()
                    ?: return if (res is Api.Res.Ok) "班里还没有${if (isActivity) "活动" else "通知"}，先发一条再来测试"
                    else "拉取失败，请检查网络后重试"
            }
            "form" -> {
                val res = Api.get("/api/forms/mine", token)
                if (res is Api.Res.Unauthorized) return "登录态已失效，请重新登录"
                val data = res.dataOrNull()
                data?.optJSONArray("pending")?.optJSONObject(0)
                    ?: data?.optJSONArray("editable")?.optJSONObject(0)
                    ?: return if (res is Api.Res.Ok) "班里还没有表单，先发一个再来测试"
                    else "拉取失败，请检查网络后重试"
            }
            else -> return "未知的推送类型"
        }

        val id = row.optInt("id", 0)
        if (id == 0) return "数据缺少 id，无法推送"

        Notifier.ensureChannels(context)
        return when (kind) {
            "activity" -> {
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
            }
            "form" -> {
                val title = row.optString("title").ifBlank { "待填表单" }
                Notifier.notifyForm(
                    context,
                    FORM_ID_BASE + id,
                    "新的待填表单：$title",
                    "待填表单，点击打开填写",
                    "forms.html?id=$id"
                )
                "已发送表单提醒：$title"
            }
            else -> {
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
}
