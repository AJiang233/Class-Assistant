package com.classassistant.app.sync

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.classassistant.app.data.Store

/**
 * 「后台常驻」的开关与启停。
 *
 * 谁调它：App 启动、登录态变化（登录后拉起 / 退出登录停掉）、开机、覆盖安装。
 * 它只管一件事：按「开关 + 登录态」把 [BackgroundSyncService] 拉起来或停掉。
 *
 * 关掉开关不是关掉功能 —— 15 分钟的周期任务（Scheduler.ensurePeriodic）一直在，
 * 只是及时性退回「最多 15 分钟、Doze 下更久」。这条要说清楚，免得用户以为关了就不提醒了。
 */
object BackgroundMode {

    /**
     * 前台服务的轮询间隔（分钟）。
     *
     * 这是**及时性与后端请求量的直接权衡**：一轮 3 个接口，3 分钟就是每人每天约 1440 次请求。
     * 一个班几十号人算下来仍在 Cloudflare 免费额度内，但没有很多余量 ——
     * 要调大这个值之前先看一眼方案文档第六节的那笔账。
     */
    const val INTERVAL_MINUTES = 3L

    /**
     * 深 Doze 兜底闹钟的间隔。比前台服务那 3 分钟宽，理由见 [scheduleDozeWake]。
     * 9 分钟也是系统在 Doze 里对 `setAndAllowWhileIdle` 的限流下限，再短没用。
     */
    private const val DOZE_WAKE_MINUTES = 9L

    /** 只用于「深 Doze 唤醒」这一个闹钟，与 Scheduler 里那几个（991 零点、活动用 event.id）错开 */
    private const val DOZE_WAKE_REQUEST_CODE = 992

    fun isEnabled(context: Context): Boolean = Store.backgroundAlwaysOn(context)

    /** 改开关：存下来 + 立刻生效。不能等下一次同步 —— 用户点了就该看到变化 */
    fun setEnabled(context: Context, enabled: Boolean) {
        Store.setBackgroundAlwaysOn(context, enabled)
        apply(context)
    }

    /**
     * 按「开关 + 登录态」决定服务该不该跑。幂等，可以随便重复调。
     *
     * 未登录时不起：SyncRunner 没 token 会立刻返回，起了也只是白挂一条常驻通知。
     */
    fun apply(context: Context) {
        if (isEnabled(context) && Store.token(context) != null) start(context) else stop(context)
    }

    /**
     * 拉起服务。用 startForegroundService（API 26+ 起后台启动 service 必须这样），
     * 老的 startService 在后台会抛 IllegalStateException。
     *
     * 调用点都在「应用可见」或「系统广播豁免」的时机（App 打开、登录成功、开机、覆盖安装），
     * 符合 Android 12+ 对后台启动前台服务的限制 —— 从最近任务划掉之后是没法自己起来的，
     * 这一点在方案文档里写明了，属于已知边界。
     */
    private fun start(context: Context) {
        try {
            ContextCompat.startForegroundService(context, Intent(context, BackgroundSyncService::class.java))
        } catch (e: Exception) {
            // 后台启动前台服务在 Android 12+ 是受限的，只有应用可见、开机广播等少数豁免时机合法。
            // 调用点都挑过时机了，但 ROM 可能有自己的说法 —— 真被拒了就在这里收手：
            // 让它从广播接收器里抛出去会变成「后台崩溃」，比「没挂上常驻」严重得多。
            Log.w(TAG, "拉起后台常驻服务失败：${e.javaClass.simpleName} ${e.message}")
        }
    }

    private fun stop(context: Context) {
        context.stopService(Intent(context, BackgroundSyncService::class.java))
        // 服务停了，深 Doze 那个闹钟也要撤掉：留着它会在深 Doze 里醒来跑一轮，
        // 而用户刚刚明确说了不要后台常驻
        cancelDozeWake(context)
    }

    /**
     * 排一个「深 Doze 里把我们叫醒」的闹钟（见 [SyncAlarmReceiver] 里为什么非它不可）。
     *
     * 用 `setAndAllowWhileIdle` 而不是 `setExactAndAllowWhileIdle`：
     *   - 精确闹钟在 Android 12+ 要单独申请「闹钟与提醒」特殊权限，默认是拒绝的，
     *     为一条后台同步把用户拉去授权页不值得；
     *   - 而且 Doze 下**两种都被限流到约 9 分钟一次**，精确也快不了。
     * 直接 `set` 或 `setWindow` 不行：它们会被 Doze 一路推迟到维护窗口。
     *
     * 间隔取 [DOZE_WAKE_MINUTES]（比前台服务那 3 分钟宽）：这条链路的定位是**深 Doze 兜底**，
     * 不在 Doze 时接收器自己会跳过（定时器那时是准的），所以放长一点纯粹是为了少几次无用唤醒。
     *
     * 重复调用只是覆盖同一个 PendingIntent，不会堆闹钟。
     */
    fun scheduleDozeWake(context: Context) {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        manager.setAndAllowWhileIdle(
            AlarmManager.RTC_WAKEUP,
            System.currentTimeMillis() + DOZE_WAKE_MINUTES * 60_000L,
            dozeWakeIntent(context)
        )
    }

    fun cancelDozeWake(context: Context) {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        manager.cancel(dozeWakeIntent(context))
    }

    /** 取消与设置必须用同一个 requestCode + action，否则撤不掉（PendingIntent 的相等判定不看 extras） */
    private fun dozeWakeIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context,
        DOZE_WAKE_REQUEST_CODE,
        Intent(context, SyncAlarmReceiver::class.java).apply {
            action = SyncAlarmReceiver.ACTION_DOZE_WAKE
        },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    /**
     * 该不该允许通知绕过电池优化 —— 也就是「有没有进白名单」。全版本公开 API，可信。
     *
     * 为什么不问「厂商自启动开没开」：**没有那个 API**。AOSP 只到电池优化这一层，
     * 各家自己加的「自启动/后台管理」读不到，所以那一项在页面上只能如实写「需要你自己去确认」。
     */
    fun ignoringBatteryOptimizations(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * 系统给这个应用定的待机档。越靠后越被压（job、闹钟、网络都更受限），
     * 而且它是**跨 ROM 通用**的说法 —— 比「MIUI 好像杀后台」有用得多，能解释「为什么最近收不到」。
     * API 28 以下没有这个概念，返回 unknown。
     */
    fun standbyBucket(context: Context): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return "unknown"
        val um = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
            ?: return "unknown"
        // 直接写数字而不是用 STANDBY_BUCKET_* 常量：RESTRICTED 那个是 API 30 才有的，
        // 而这里要覆盖到 API 28，用常量会被 lint 的 InlinedApi 拦下来
        return when (um.appStandbyBucket) {
            10 -> "active"
            20 -> "working_set"
            30 -> "frequent"
            40 -> "rare"
            45 -> "restricted"
            else -> "unknown"
        }
    }

    /**
     * 各家 ROM 的「自启动 / 后台管理」页。**没有标准 API**，只能按厂商猜组件名。
     *
     * 这些名字随系统更新会失效，所以整串都是 best-effort：一个都打不开就退回应用详情页，
     * 用户自己也能在里面找到「电池 / 权限」。**不要**因为某一家改了名就去加判断逻辑 ——
     * 这张表只是「帮用户省两步」的入口，不是功能的依赖项。
     */
    val AUTO_START_PAGES = listOf(
        // 小米 / Redmi（HyperOS 仍在用这套）
        "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
        // 华为 / 荣耀
        "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
        // OPPO / 一加 / realme：两个包名各版本不同，都试
        "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
        "com.oplus.safecenter" to "com.oplus.safecenter.startupapp.StartupAppListActivity",
        // vivo
        "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
        // 魅族
        "com.meizu.safe" to "com.meizu.safe.security.SHOW_APPSEC",
        // 三星
        "com.samsung.android.lool" to "com.samsung.android.sm.ui.battery.BatteryActivity"
    )

    private const val TAG = "CABackground"
}
