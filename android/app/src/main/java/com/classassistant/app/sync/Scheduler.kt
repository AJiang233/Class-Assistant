package com.classassistant.app.sync

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.classassistant.app.data.Store
import com.classassistant.app.notify.AlarmReceiver
import com.classassistant.app.widget.CoursesWidgetProvider
import com.classassistant.app.widget.TodayWidgetProvider
import com.classassistant.app.widget.WidgetRefreshReceiver
import java.util.Calendar
import java.util.concurrent.TimeUnit

/**
 * 后台同步与提醒闹钟的调度入口。
 */
object Scheduler {

    private const val SYNC_WORK_NAME = "class_assistant_sync"
    private const val SYNC_ONCE_NAME = "class_assistant_sync_once"
    /** 后台同步间隔（分钟）。15 是 WorkManager 周期任务的下限，再小会被系统夹上来 */
    private const val SYNC_INTERVAL_MINUTES = 15L
    private const val WINDOW_MILLIS = 5L * 60 * 1000

    /** 回前台同步的最小间隔：短于它就不重复排任务 */
    private const val SYNC_THROTTLE_MILLIS = 60L * 1000

    /** 活动开始前多久提醒 */
    const val REMIND_LEAD_MILLIS = 30L * 60 * 1000

    /**
     * 课程提醒闹钟往前排几天。太短，用户几天不同步就可能断档；太长则白占系统闹钟槽位。
     * 与 requestCode 无关 —— 那个由 CourseSchedule.courseAlarmId 按**绝对日期**算。
     */
    private const val COURSE_DAYS_AHEAD = 7

    /** 同时最多排多少个课程闹钟（一天 6 节课 × 提前+开课 × 7 天 = 84，正常到不了） */
    private const val COURSE_ALARM_LIMIT = 60

    /**
     * 课程提醒的窗口。比活动那 5 分钟紧得多 —— 上课时间是精确的，
     * 「还有 15 分钟上课」晚 5 分钟送到就没意义了。
     * 用 setWindow 而不是 setExact*：精确定时在 Android 12+ 要单独申请「闹钟与提醒」权限，
     * 为一条课前提醒不值得把用户拉去授权页。
     */
    private const val COURSE_ALARM_WINDOW_MILLIS = 60 * 1000L

    /** 零点刷新闹钟的窗口：不唤醒设备，醒来后 10 分钟内刷掉就行 */
    private const val MIDNIGHT_WINDOW_MILLIS = 10 * 60 * 1000L

    private const val MIDNIGHT_REQUEST_CODE = 991

    /**
     * 「上课期间每分钟重绘课表小组件」闹钟的 requestCode。
     *
     * 号段要挨着排、一处一个，别复用：活动闹钟直接用活动 id（小数值）、课程闹钟从 100 万起
     * （见 CourseSchedule.courseAlarmId）、深 Doze 兜底闹钟 992（见 BackgroundMode）、
     * 零点刷新 991 —— 这里取 993。接收方不同（这里发 WidgetRefreshReceiver、Doze 那条发
     * SyncAlarmReceiver）时就算同号也不会互相顶掉，PendingIntent 的相等判定是带组件的；
     * 但编号一一对应才好查「系统里到底排着哪些闹钟」，所以照旧错开。
     */
    private const val CLASS_TICK_REQUEST_CODE = 993

    /**
     * 上课重绘的窗口。给一分钟：进度条本身就是一分钟一格，晚一分钟就是差一格，
     * 再放宽这个闹钟就没意义了（那还不如不排）。
     */
    private const val CLASS_TICK_WINDOW_MILLIS = 60 * 1000L

    /**
     * 每 15 分钟后台同步一次。15 已经是 WorkManager 周期任务的下限，所以这是不动推送通道
     * 能达到的最快轮询；但 Doze / 后台限制照样会把它推迟，15 分钟只是正常情况下的上限，不是保证。
     */
    fun ensurePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(SYNC_INTERVAL_MINUTES, TimeUnit.MINUTES)
            .setConstraints(networkConstraints())
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            SYNC_WORK_NAME,
            // 必须 UPDATE，不能 KEEP：KEEP 在任务已存在时什么都不做，于是改这个间隔对已装的
            // 用户永远不生效（他们会一直停在旧排期上）。UPDATE 会把新参数应用上去，且不重置已有计时。
            ExistingPeriodicWorkPolicy.UPDATE,
            request
        )
    }

    /**
     * 立即同步一次（登录后 / 开机后 / 每次回到前台调用）。
     *
     * 默认带 60 秒节流：回前台触发得非常频繁（切一下应用、锁屏解锁都算），每次都排一轮完整
     * 拉取（活动 + 通知两个接口）纯属白耗流量和电，换来的新鲜度不到一分钟。
     *
     * 判据取「上次同步**完成**时间」而不是「上次排任务时间」，所以同步一直失败时不会被节流
     * 卡住 —— 下次回前台照常重试。这个时间由 SyncWorker 成功后写入（Store.lastSyncAt）。
     *
     * 登录、开机这类「必须马上拉到」的场景传 force = true 绕过节流。
     */
    fun syncNow(context: Context, force: Boolean = false) {
        if (!force) {
            val elapsed = System.currentTimeMillis() - Store.lastSyncAt(context)
            if (elapsed < SYNC_THROTTLE_MILLIS) return
        }
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(networkConstraints())
            .build()
        // 唯一名 + KEEP：每次打开 App 都会调到这里，不加限制会堆起一串重复任务
        WorkManager.getInstance(context).enqueueUniqueWork(
            SYNC_ONCE_NAME,
            ExistingWorkPolicy.KEEP,
            request
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
            if (event.startMillis <= now) continue // 已经开始的活动不再提醒
            val triggerAt = event.startMillis - REMIND_LEAD_MILLIS
            // 已经进入提前量窗口（例如活动是开始前半小时内才同步到的）：补排一次立即提醒。
            // 这里以前是直接 continue 丢掉，导致这类活动永远不会响。
            wanted.add(event.id.toString())
            manager.setWindow(
                AlarmManager.RTC_WAKEUP,
                if (triggerAt <= now) now else triggerAt,
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

    /**
     * 按本地课表重排课程提醒闹钟。每轮同步后、以及用户在个人页改完设置后都要调一次：
     * 这里只排「未来 COURSE_DAYS_AHEAD 天」的课，滚动窗口靠这两处调用不断往前推。
     *
     * 同一 (课, 日期, 类型) 的 requestCode 固定（见 courseAlarmId），所以重复调用只是覆盖，
     * 不会堆出重复闹钟；该取消的靠 Store 里记的名单逐个撤掉。
     * 课表读的是本地缓存（Store.timetableJson），**不联网** —— 断网时也得能排上。
     */
    fun rescheduleCourseAlarms(context: Context) {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val now = System.currentTimeMillis()
        val wanted = mutableSetOf<String>()

        val timetable = parseTimetableJson(Store.timetableJson(context))
        val lead = Store.courseRemindLead(context)
        val atStart = Store.courseRemindAtStart(context)

        if (timetable != null && (lead > 0 || atStart)) {
            val today = startOfDay(now)
            outer@ for (offset in 0 until COURSE_DAYS_AHEAD) {
                val day = plusDays(today, offset)
                for (course in coursesOn(timetable, day)) {
                    if (wanted.size >= COURSE_ALARM_LIMIT) break@outer
                    val startAt = courseStartAt(day, course.start) ?: continue
                    val index = timetable.courses.indexOf(course)

                    if (lead > 0) {
                        val trigger = startAt - lead * 60_000L
                        // 已经进入提前量窗口（课是刚同步到的）就不补一条「还有 N 分钟」的了，
                        // 那种情况下面那条「开始上课」更接近事实
                        if (trigger > now) {
                            setCourseAlarm(context, manager, wanted, course, day, index, 0, trigger, lead)
                        }
                    }
                    if (atStart && startAt > now) {
                        setCourseAlarm(context, manager, wanted, course, day, index, 1, startAt, 0)
                    }
                }
            }
        }

        for (stale in Store.scheduledCourseAlarms(context) - wanted) {
            val id = stale.toIntOrNull() ?: continue
            manager.cancel(courseCancelIntent(context, id))
        }
        Store.saveScheduledCourseAlarms(context, wanted)
    }

    /**
     * 取消全部课程提醒闹钟。退出登录时用。
     *
     * 这里**不能**图省事调 rescheduleCourseAlarms：那时课表还在本地缓存里，
     * 它会照着旧课表再排一轮，而紧接着 Store.clearSession 会把闹钟名单一起抹掉 ——
     * 那些闹钟就再也取消不掉了，会继续按上一个账号的课表响。
     * 与活动闹钟那边「先 rescheduleAlarms(emptyList()) 再清存储」是同一个道理。
     */
    fun cancelCourseAlarms(context: Context) {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        for (raw in Store.scheduledCourseAlarms(context)) {
            val id = raw.toIntOrNull() ?: continue
            manager.cancel(courseCancelIntent(context, id))
        }
        Store.saveScheduledCourseAlarms(context, emptySet())
    }

    private fun setCourseAlarm(
        context: Context,
        manager: AlarmManager,
        wanted: MutableSet<String>,
        course: Course,
        dayStart: Long,
        index: Int,
        kind: Int,
        triggerAt: Long,
        leadMinutes: Int
    ) {
        val id = courseAlarmId(dayStart, index, kind)
        wanted.add(id.toString())
        manager.setWindow(
            AlarmManager.RTC_WAKEUP,
            triggerAt,
            COURSE_ALARM_WINDOW_MILLIS,
            courseAlarmIntent(context, id, course, leadMinutes)
        )
    }

    private fun courseAlarmIntent(
        context: Context,
        id: Int,
        course: Course,
        leadMinutes: Int
    ): PendingIntent {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = AlarmReceiver.ACTION_COURSE_REMIND
            putExtra(AlarmReceiver.EXTRA_ID, id)
            putExtra(AlarmReceiver.EXTRA_COURSE_NAME, course.name)
            putExtra(AlarmReceiver.EXTRA_COURSE_ROOM, course.room)
            putExtra(AlarmReceiver.EXTRA_COURSE_LEAD, leadMinutes)
        }
        return PendingIntent.getBroadcast(
            context,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /** 取消用的 PendingIntent：同样只需 action + requestCode 一致 */
    private fun courseCancelIntent(context: Context, id: Int): PendingIntent {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = AlarmReceiver.ACTION_COURSE_REMIND
            putExtra(AlarmReceiver.EXTRA_ID, id)
        }
        return PendingIntent.getBroadcast(
            context,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /**
     * 排下一次「零点后刷新小组件」的闹钟。
     *
     * 两个小组件的标题都是「今日 / 明日」，内容按设备本地日期算，可刷新时机只有
     * 「后台同步成功」和 updatePeriodMillis（系统夹到最少 30 分钟，Doze 下更久）。
     * 过了零点没人叫它，桌面就一直挂着昨天那一屏 —— 日期是本地时间说了算的，
     * 所以这里直接按本机零点排一个闹钟，把「换天」这件事钉死。
     * 接收方刷完会自己再排下一次（见 WidgetRefreshReceiver）。
     *
     * 用 RTC 而不是 RTC_WAKEUP：手机睡着就等它醒来再刷，早几小时看到旧内容无所谓，
     * 为刷新一个小组件把设备叫醒不值得。
     */
    fun scheduleMidnightRefresh(context: Context) {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        manager.setWindow(
            AlarmManager.RTC,
            nextMidnight(System.currentTimeMillis()),
            MIDNIGHT_WINDOW_MILLIS,
            PendingIntent.getBroadcast(
                context,
                MIDNIGHT_REQUEST_CODE,
                Intent(context, WidgetRefreshReceiver::class.java).apply {
                    action = WidgetRefreshReceiver.ACTION_MIDNIGHT
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        )
    }

    /**
     * 排下一次「上课期间重绘课表小组件」的闹钟，时刻由调用方按 CourseSchedule.nextClassTickAt
     * 算好（那里是纯函数，有单测）。
     *
     * 为什么需要它：小组件那格的进度条**是渲染那一刻算出来的快照**，只在列表被重新绑定时
     * 才按当时的 now 重算；而系统给小工具的唯一定时档 updatePeriodMillis 最少 30 分钟 ——
     * 一条 45 分钟的课最多蹦一格，看着就是「不会动」（issue #61）。所以上课期间自己排一串
     * 闹钟，每次 render 完顺手续下一格；没课可上时调用方改调 cancelClassTick。
     *
     * 与零点刷新同一套路：非唤醒 RTC（手机睡着就等它醒来）+ setWindow（不申请 Android 12+
     * 的「闹钟与提醒」权限），接收方只重绘、不联网、不排同步。时间排错了只是静静不动，不会崩。
     */
    fun scheduleClassTick(context: Context, atMillis: Long) {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        manager.setWindow(
            AlarmManager.RTC,
            atMillis,
            CLASS_TICK_WINDOW_MILLIS,
            classTickIntent(context)
        )
    }

    /** 撤掉上课重绘闹钟。没课表 / 今天没课 / 课都上完时调用，否则它会一直空转重绘下去 */
    fun cancelClassTick(context: Context) {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        manager.cancel(classTickIntent(context))
    }

    /** 取消用的 PendingIntent：同样只需 action + requestCode 一致即可匹配 */
    private fun classTickIntent(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            CLASS_TICK_REQUEST_CODE,
            Intent(context, WidgetRefreshReceiver::class.java).apply {
                action = WidgetRefreshReceiver.ACTION_CLASS_TICK
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    /** 明天的 00:05。不用 00:00：跨天那一瞬间各种定时任务都在抢，让开一点 */
    private fun nextMidnight(now: Long): Long {
        val c = Calendar.getInstance()
        c.timeInMillis = now
        c.add(Calendar.DAY_OF_YEAR, 1)
        c.set(Calendar.HOUR_OF_DAY, 0)
        c.set(Calendar.MINUTE, 5)
        c.set(Calendar.SECOND, 0)
        c.set(Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }

    /** 只刷新小组件（不联网、不排同步）：跨天、系统时间被改、覆盖安装后调用 */
    fun refreshWidgets(context: Context) {
        TodayWidgetProvider.refreshAll(context)
        CoursesWidgetProvider.refreshAll(context)
    }
}
