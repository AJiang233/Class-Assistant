package com.classassistant.app.sync

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.classassistant.app.data.Store
import com.classassistant.app.notify.AlarmReceiver
import java.util.concurrent.TimeUnit

/**
 * 后台同步与提醒闹钟的调度入口。
 */
object Scheduler {

    private const val SYNC_WORK_NAME = "class_assistant_sync"
    private const val WINDOW_MILLIS = 5L * 60 * 1000

    /** 活动开始前多久提醒 */
    const val REMIND_LEAD_MILLIS = 30L * 60 * 1000

    /** 每小时后台同步一次（WorkManager 周期任务下限为 15 分钟） */
    fun ensurePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(1, TimeUnit.HOURS)
            .setConstraints(networkConstraints())
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            SYNC_WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }

    /** 立即同步一次（登录后 / 开机后调用） */
    fun syncNow(context: Context) {
        WorkManager.getInstance(context).enqueue(
            OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(networkConstraints())
                .build()
        )
    }

    private fun networkConstraints() = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /**
     * 按最新活动列表重排提醒闹钟。
     * 同一活动用同一 requestCode，重复设置即覆盖；已删除或已过期的活动对应闹钟会被取消。
     */
    fun rescheduleAlarms(context: Context, events: List<Event>) {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val now = System.currentTimeMillis()
        val wanted = mutableSetOf<String>()

        for (event in events) {
            val triggerAt = event.startMillis - REMIND_LEAD_MILLIS
            if (triggerAt <= now) continue // 来不及提前提醒的就不排了
            wanted.add(event.id.toString())
            manager.setWindow(
                AlarmManager.RTC_WAKEUP,
                triggerAt,
                WINDOW_MILLIS,
                alarmIntent(context, event)
            )
        }

        for (stale in Store.scheduledAlarmIds(context) - wanted) {
            val id = stale.toIntOrNull() ?: continue
            manager.cancel(cancelIntent(context, id))
        }
        Store.saveScheduledAlarmIds(context, wanted)
    }

    private fun alarmIntent(context: Context, event: Event): PendingIntent {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = AlarmReceiver.ACTION_REMIND
            putExtra(AlarmReceiver.EXTRA_ID, event.id)
            putExtra(AlarmReceiver.EXTRA_TITLE, event.title)
            putExtra(AlarmReceiver.EXTRA_START, event.startMillis)
            putExtra(AlarmReceiver.EXTRA_LOCATION, event.location)
        }
        return PendingIntent.getBroadcast(
            context,
            event.id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /** 取消用的 PendingIntent：只需 action + requestCode 一致即可匹配 */
    private fun cancelIntent(context: Context, id: Int): PendingIntent {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = AlarmReceiver.ACTION_REMIND
            putExtra(AlarmReceiver.EXTRA_ID, id)
        }
        return PendingIntent.getBroadcast(
            context,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
