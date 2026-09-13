package com.classassistant.app.data

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray

/**
 * 本地存储：登录凭据 + 同步任务写入的日程缓存。
 * 提醒闹钟与桌面小组件都从这里读数据，避免各自重复请求接口。
 */
object Store {

    private const val NAME = "class_assistant"

    private const val KEY_TOKEN = "token"
    private const val KEY_USER_ID = "user_id"
    private const val KEY_USER_NAME = "user_name"
    private const val KEY_LAST_NOTICE_TIME = "last_notice_time"
    private const val KEY_LAST_TODO_TIME = "last_todo_time"
    private const val KEY_LAST_SYNC_AT = "last_sync_at"
    private const val KEY_EVENTS = "events"
    private const val KEY_SCHEDULED = "scheduled_alarm_ids"

    private var cached: SharedPreferences? = null

    private fun sp(context: Context): SharedPreferences {
        cached?.let { return it }
        val s = context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)
        cached = s
        return s
    }

    // ===== 登录凭据（由 WebView 的 localStorage 同步过来） =====

    fun token(context: Context): String? =
        sp(context).getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }

    fun saveToken(context: Context, token: String) {
        sp(context).edit().putString(KEY_TOKEN, token).apply()
    }

    fun saveUser(context: Context, userId: String, userName: String) {
        sp(context).edit()
            .putString(KEY_USER_ID, userId)
            .putString(KEY_USER_NAME, userName)
            .apply()
    }

    fun userId(context: Context): String? = sp(context).getString(KEY_USER_ID, null)

    fun userName(context: Context): String? = sp(context).getString(KEY_USER_NAME, null)

    /**
     * 退出登录：清凭据 + 同步缓存。
     * events 不清的话，小组件会继续显示上一个账号当天的活动；last_notice_time 不清的话，
     * 换账号后首次同步会把历史通知当新的逐条补推（「首次同步只记基线」那一支进不去）。
     * last_todo_time（待填表单，见 SyncWorker.notifyNewTodos）同理。
     * last_sync_at 不清的话，退出后 60 秒内重新登录会被回前台同步的节流挡掉，新账号要等一分钟才拉数据。
     * 注意：取消提醒闹钟与重绘小组件不在这里做，退出登录请统一走 SyncWorker.logOutSession()。
     */
    fun clearSession(context: Context) {
        sp(context).edit()
            .remove(KEY_TOKEN).remove(KEY_USER_ID).remove(KEY_USER_NAME)
            .remove(KEY_EVENTS).remove(KEY_LAST_NOTICE_TIME).remove(KEY_LAST_TODO_TIME)
            .remove(KEY_LAST_SYNC_AT).remove(KEY_SCHEDULED)
            .apply()
    }

    // ===== 同步状态 =====

    /** 上次同步时看到的最新通知时间，用于判断同步后哪些是新通知 */
    fun lastNoticeTime(context: Context): Long = sp(context).getLong(KEY_LAST_NOTICE_TIME, 0L)

    fun setLastNoticeTime(context: Context, value: Long) {
        sp(context).edit().putLong(KEY_LAST_NOTICE_TIME, value).apply()
    }

    /**
     * 上次同步时看到的最新**待填表单**下发时间（毫秒时间戳，由服务端 created_at 解析而来，0 = 没同步过）。
     *
     * 名字用 todo 而不是 form：这里的「表单」是班委下发的待填表单（网页侧的 /api/forms/mine，
     * 首页「待填表单」那一栏）。鸿蒙端 form 已经被 ArkTS 桌面卡片占用了，两端统一叫 todo
     * 才不会跟卡片混起来。
     */
    fun lastTodoTime(context: Context): Long = sp(context).getLong(KEY_LAST_TODO_TIME, 0L)

    fun setLastTodoTime(context: Context, value: Long) {
        sp(context).edit().putLong(KEY_LAST_TODO_TIME, value).apply()
    }

    /**
     * 上次**成功**同步的完成时间（毫秒），由 SyncWorker 拉完数据后写入；没同步过是 0。
     * 两个用途：回前台同步的节流判据（见 Scheduler.syncNow），以及个人页显示的「上次同步」。
     * 用「完成时间」而不是「发起时间」：同步一直失败时它不会前进，于是不会被节流卡住、下次回前台照常重试。
     */
    fun lastSyncAt(context: Context): Long = sp(context).getLong(KEY_LAST_SYNC_AT, 0L)

    fun setLastSyncAt(context: Context, value: Long) {
        sp(context).edit().putLong(KEY_LAST_SYNC_AT, value).apply()
    }

    // ===== 日程缓存（未来若干天的活动，按开始时间升序） =====

    fun events(context: Context): JSONArray {
        val raw = sp(context).getString(KEY_EVENTS, null) ?: return JSONArray()
        return try {
            JSONArray(raw)
        } catch (e: Exception) {
            JSONArray()
        }
    }

    fun saveEvents(context: Context, events: JSONArray) {
        sp(context).edit().putString(KEY_EVENTS, events.toString()).apply()
    }

    // ===== 已排的提醒闹钟（用于取消已删除/已改动活动的旧闹钟） =====

    fun scheduledAlarmIds(context: Context): Set<String> =
        sp(context).getStringSet(KEY_SCHEDULED, emptySet()) ?: emptySet()

    fun saveScheduledAlarmIds(context: Context, ids: Set<String>) {
        sp(context).edit().putStringSet(KEY_SCHEDULED, ids).apply()
    }
}
