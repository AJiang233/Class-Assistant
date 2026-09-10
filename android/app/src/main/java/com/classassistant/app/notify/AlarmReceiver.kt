package com.classassistant.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.classassistant.app.sync.formatDayClock

/**
 * 活动到点提醒：由 AlarmManager 触发（App 未打开也能收到）。
 * 活动信息通过 Intent extras 带过来，避免再去查数据。
 */
class AlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_REMIND) return
        val id = intent.getIntExtra(EXTRA_ID, 0)
        val title = intent.getStringExtra(EXTRA_TITLE) ?: return
        val start = intent.getLongExtra(EXTRA_START, 0L)
        val location = intent.getStringExtra(EXTRA_LOCATION)
        val whenText = if (start > 0) "${formatDayClock(start)} 开始" else "即将开始"
        Notifier.notifyActivity(context, id, title, whenText, location)
    }

    companion object {
        const val ACTION_REMIND = "com.classassistant.app.action.REMIND"
        const val EXTRA_ID = "event_id"
        const val EXTRA_TITLE = "event_title"
        const val EXTRA_START = "event_start"
        const val EXTRA_LOCATION = "event_location"
    }
}
