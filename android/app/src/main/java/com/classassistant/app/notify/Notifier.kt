package com.classassistant.app.notify

import android.app.Notification
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

    /**
     * 通知 / 表单待办的渠道 id。末尾那个 v2 **不能去掉**。
     *
     * 渠道重要性只在创建时生效，之后应用只能**下调**不能上调（用户手动改的更是永远优先）。
     * 老版本这个 id 是 "class_notice"，重要性 IMPORTANCE_DEFAULT（只响铃、不弹横幅）；
     * 直接给老 id 传 HIGH 对已安装用户毫无作用 —— 那条渠道早就建好了，参数会被忽略。
     * 所以想让通知也弹横幅，只能换一个新 id 重建渠道（用户的新渠道默认跟着 app 的设置走）。
     */
    const val CHANNEL_NOTICE = "class_notice_v2"

    /** 换到 v2 之后的老渠道 id：留着没用，还会继续在系统设置里占一条，让用户分不清该关哪个 */
    private const val CHANNEL_NOTICE_LEGACY = "class_notice"

    /**
     * 课程提醒单独一条渠道：上课提醒和班级活动/通知是两件事，学生想静音的可能只是其中一类。
     * 新建的 id 不需要 v2 那套后缀 —— 只有「要改变一条已存在渠道的重要性」时才必须换新 id。
     */
    const val CHANNEL_COURSE = "course_reminder"

    /**
     * 前台服务那条常驻通知的渠道。IMPORTANCE_MIN：不响铃、不弹横幅、不进锁屏，
     * 只在通知栏里占一行 —— 这是「让用户知道有东西在后台跑」的最低调形式。
     *
     * 为什么不能干脆不要通知：前台服务**必须**有可见通知，这是系统要求不是我们的选择。
     * 用户想彻底去掉，要么去系统设置里关掉这条渠道（服务会继续跑），
     * 要么到「个人中心 → 后台通知」把常驻关掉。
     */
    const val CHANNEL_BACKGROUND = "background_running"

    /**
     * 常驻通知的 id。**不能用小数字**：活动提醒直接用活动 id（1、2、3…），撞上就互相顶掉。
     * 沿用通知 / 表单那套「分段留空间」的做法（见 SyncRunner.NOTICE_ID_BASE）。
     */
    const val ONGOING_ID = 300_000

    /** 点通知要直达的页面深链（?view=…&id=…），MainActivity 启动时拼到站点地址后面 */
    const val EXTRA_DEEP_LINK = "ca_deep_link"

    /**
     * 系统里「本应用能不能发通知」。Android 13+ 是用户在权限弹窗里选的，
     * 更早的版本是通知渠道被关掉 —— areNotificationsEnabled() 两类都覆盖。
     * 关掉之后 notify() 会抛 SecurityException（见下面 send 的 catch），也就是所有本地提醒
     * 都被默默丢掉；个人页要能把这件事说出来（见 HostBridge.appStatus），所以单独查一次。
     */
    fun notificationsEnabled(context: Context): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled()

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
        // HIGH = 横幅（浮动通知）+ 响铃；与活动提醒一致。用户仍可在系统设置里单独把它调成静音
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_NOTICE,
                context.getString(R.string.channel_notice),
                NotificationManager.IMPORTANCE_HIGH
            ).apply { description = context.getString(R.string.channel_notice_desc) }
        )
        // 删掉旧的 "class_notice"：不删就白留一条永远不弹横幅的渠道在设置里（幂等，不存在时是空操作）
        manager.deleteNotificationChannel(CHANNEL_NOTICE_LEGACY)
        // 课程提醒
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_COURSE,
                context.getString(R.string.channel_course),
                NotificationManager.IMPORTANCE_HIGH
            ).apply { description = context.getString(R.string.channel_course_desc) }
        )
        // 前台服务那条常驻通知：最低重要级，不响不弹，只在通知栏占一行（见 CHANNEL_BACKGROUND 的注释）
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_BACKGROUND,
                context.getString(R.string.channel_background),
                NotificationManager.IMPORTANCE_MIN
            ).apply { description = context.getString(R.string.channel_background_desc) }
        )
    }

    /** 活动到点提醒。notificationId 就是活动 id（Scheduler → AlarmReceiver 传的 event.id），
     *  所以能直接拼深链；也正因为通知 id 被活动占用，通知那边得另开一段号（见 SyncRunner.NOTICE_ID_BASE）。 */
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

    /**
     * 上课提醒。落地页是网页的课表页 —— 课表没有「单节课详情」这种页面，
     * 深链只能到列表；用户点进来看到的就是整周课表，够用。
     */
    fun notifyCourse(context: Context, notificationId: Int, title: String, body: String) {
        send(context, CHANNEL_COURSE, notificationId, title, body, "?view=academic")
    }

    /**
     * 前台服务要的那条常驻通知。点击回到通知页，复用与正式提醒同一套深链。
     *
     * 不复用 send()：那条是「提醒」—— 高重要级 + autoCancel（点掉就消失）；
     * 这条是「公告」—— 最低重要级 + ongoing（不该被顺手划掉，它是服务还在跑的凭据）。
     */
    fun ongoingNotification(context: Context): Notification {
        ensureChannels(context)
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_DEEP_LINK, "?view=notices")
        }
        val pending = PendingIntent.getActivity(
            context,
            ONGOING_ID,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(context, CHANNEL_BACKGROUND)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(context.getString(R.string.background_title))
            .setContentText(context.getString(R.string.background_text))
            .setContentIntent(pending)
            // 渠道重要级在 26+ 说了算，这两行是给更老的系统兜底
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setShowWhen(false)
            .setOngoing(true)
            .build()
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
            // 用户未授予通知权限，静默跳过。这条提醒就这么没了 —— 个人页会显示
            // 「本机通知：未开启」把原因指出来（见 Notifier.notificationsEnabled / HostBridge.appStatus）
        }
    }
}
