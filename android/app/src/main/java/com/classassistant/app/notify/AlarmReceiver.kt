package com.classassistant.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.classassistant.app.R
import com.classassistant.app.sync.formatDayClock

/**
 * 到点提醒：由 AlarmManager 触发（App 未打开也能收到）。
 * 活动与课程各走一个 action，提醒内容通过 Intent extras 带过来，避免再去查数据。
 */
class AlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_REMIND -> remindActivity(context, intent)
            ACTION_COURSE_REMIND -> remindCourse(context, intent)
        }
    }

    private fun remindActivity(context: Context, intent: Intent) {
        val id = intent.getIntExtra(EXTRA_ID, 0)
        val title = intent.getStringExtra(EXTRA_TITLE) ?: return
        val start = intent.getLongExtra(EXTRA_START, 0L)
        val location = intent.getStringExtra(EXTRA_LOCATION)
        val whenText = if (start > 0) "${formatDayClock(start)} 开始" else "即将开始"
        Notifier.notifyActivity(context, id, title, whenText, location)
    }

    /**
     * 上课提醒。[EXTRA_COURSE_LEAD] 为 0 表示「开课时」那一条，> 0 表示提前 N 分钟那一条。
     * 通知 id 直接用排期时的 requestCode：一个 (课, 日期, 类型) 一个号，
     * 同一条重复触发只会覆盖，不会叠出两条 —— 与活动提醒用活动 id 是同一个思路。
     */
    private fun remindCourse(context: Context, intent: Intent) {
        val id = intent.getIntExtra(EXTRA_ID, 0)
        val name = intent.getStringExtra(EXTRA_COURSE_NAME) ?: return
        val room = intent.getStringExtra(EXTRA_COURSE_ROOM).orEmpty()
        val lead = intent.getIntExtra(EXTRA_COURSE_LEAD, 0)
        val body = buildString {
            append(
                if (lead > 0) context.getString(R.string.course_notify_lead, lead)
                else context.getString(R.string.course_notify_start)
            )
            if (room.isNotBlank()) append(" · ").append(room)
        }
        Notifier.notifyCourse(context, id, name, body)
    }

    companion object {
        const val ACTION_REMIND = "com.classassistant.app.action.REMIND"
        const val EXTRA_ID = "event_id"
        const val EXTRA_TITLE = "event_title"
        const val EXTRA_START = "event_start"
        const val EXTRA_LOCATION = "event_location"

        const val ACTION_COURSE_REMIND = "com.classassistant.app.action.COURSE_REMIND"
        const val EXTRA_COURSE_NAME = "course_name"
        const val EXTRA_COURSE_ROOM = "course_room"
        const val EXTRA_COURSE_LEAD = "course_lead"
    }
}
