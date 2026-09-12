package com.classassistant.app.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.classassistant.app.MainActivity
import com.classassistant.app.R

/**
 * 通知渠道与发送。活动提醒与新通知分开两个渠道，方便用户分别开关。
 */
object Notifier {

    const val CHANNEL_ACTIVITY = "activity_reminder"
    const val CHANNEL_NOTICE = "class_notice"

    /** 点通知要直达的页面深链（?view=…&id=…），MainActivity 启动时拼到站点地址后面 */
    const val EXTRA_DEEP_LINK = "ca_deep_link"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ACTIVITY,
                context.getString(R.string.channel_activity),
                NotificationManager.IMPORTANCE_HIGH
            ).apply { description = context.getString(R.string.channel_activity_desc) }
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_NOTICE,
                context.getString(R.string.channel_notice),
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply { description = context.getString(R.string.channel_notice_desc) }
        )
    }

    /** 活动到点提醒。notificationId 就是活动 id（Scheduler → AlarmReceiver 传的 event.id），
     *  所以能直接拼深链；也正因为通知 id 被活动占用，通知那边得另开一段号（见 SyncWorker.NOTICE_ID_BASE）。 */
    fun notifyActivity(
        context: Context,
        notificationId: Int,
        title: String,
        whenText: String,
        location: String?
    ) {
        val body = buildString {
            append(whenText)
            if (!location.isNullOrBlank()) append(" · ").append(location)
        }
        send(context, CHANNEL_ACTIVITY, notificationId, title, body, "?view=activities&id=$notificationId")
    }

    /** 新通知提醒（每个 id 一条独立通知，重复发同一 id 会覆盖而不是叠加） */
    fun notifyNotice(
        context: Context,
        notificationId: Int,
        title: String,
        body: String,
        deepLink: String? = null
    ) {
        send(context, CHANNEL_NOTICE, notificationId, title, body, deepLink)
    }

    private fun send(
        context: Context,
        channel: String,
        id: Int,
        title: String,
        body: String,
        deepLink: String?
    ) {
        ensureChannels(context)
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (!deepLink.isNullOrBlank()) putExtra(EXTRA_DEEP_LINK, deepLink)
        }
        val pending = PendingIntent.getActivity(
            context,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(id, notification)
        } catch (e: SecurityException) {
            // 用户未授予通知权限，静默跳过
        }
    }
}
