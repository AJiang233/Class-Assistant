package com.classassistant.app.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 开机后恢复：WorkManager 的周期任务本身能跨重启存活，这里再兜一次底，
 * 并立即同步一次以重新排上提醒闹钟（闹钟在重启后会丢失）。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        Scheduler.ensurePeriodic(context)
        Scheduler.syncNow(context)
    }
}
