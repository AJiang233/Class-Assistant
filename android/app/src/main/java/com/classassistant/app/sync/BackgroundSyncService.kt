package com.classassistant.app.sync

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import com.classassistant.app.data.Store
import com.classassistant.app.notify.Notifier
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 后台常驻的前台服务：把进程钉住，按分钟级的间隔跑一轮同步，好让新通知尽快弹出来。
 *
 * 为什么需要它：AOSP 能给的后台定时**下限就是 15 分钟**（JobScheduler / WorkManager 一致），
 * 而且手机进 Doze 之后还会被进一步推迟到维护窗口 —— 这正是「刚用过 App 才收得到通知」的成因。
 * 想比 15 分钟更及时，原生世界里只有两个出口：前台服务或推送；本项目选了前者
 * （推送的取舍见方案文档 `.claude/artifacts/plans/android-background-notify.md`）。
 *
 * 它**买不到**的东西，别指望它：
 *   - 买不到「Doze 期间还能联网」—— 那是免电池优化白名单的事。所以服务与白名单必须配套，
 *     少了白名单，手机放着不动时照样收不到（见 BackgroundMode 与个人页的那张卡片）。
 *   - 买不到「被划掉后自己起来」—— 从最近任务划掉会让应用进入 stopped 状态，谁都救不回来。
 *     `START_STICKY` 只在「进程被系统按内存回收」时有用，照写但不依赖。
 *
 * 为什么服务里直接调 SyncRunner 而不排 WorkManager：Android 16 起，**从前台服务里启动的
 * 后台任务要受各自的运行时配额**（不看 targetSdk）。直接跑就没有这层。
 */
class BackgroundSyncService : Service() {

    /** 单线程 + 定时：一轮跑完才排下一轮（scheduleWithFixedDelay 的语义），也天然不会并发两轮 */
    private val worker = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "ca-background-sync").apply { isDaemon = true }
    }

    /** 是否已经排过循环。onStartCommand 可能被调用多次（重复 start、系统重建），不能重复排 */
    private var loopStarted = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 必须最先做：startForegroundService 之后 5 秒内不 startForeground 会直接崩
        // （ForegroundServiceDidNotStartInTimeException），那是 ANR 级的报错。
        // 抬不起来就当场收手，别让系统等满 5 秒再来判我们死刑。
        if (!startInForeground()) return START_NOT_STICKY

        if (!loopStarted) {
            loopStarted = true
            worker.scheduleWithFixedDelay(
                ::syncOnce,
                0,
                BackgroundMode.INTERVAL_MINUTES,
                TimeUnit.MINUTES
            )
            // 上面那个定时器叫不醒睡着的 CPU（深 Doze 会把 CPU 一起挂起），
            // 所以另排一个「深 Doze 兜底」的闹钟。它自己每轮会重新排，这里只负责起头 ——
            // 覆盖了「打开 App / 登录 / 开机 / 覆盖安装」四条进入路径（它们都会走到这里）
            BackgroundMode.scheduleDozeWake(this)
        }
        // 被系统按内存回收后让系统重建它；ROM 的「一键清理」是强停，这条救不回来（见类注释）
        return START_STICKY
    }

    override fun onDestroy() {
        instance = null
        worker.shutdownNow()
        super.onDestroy()
    }

    /**
     * 一轮。异常必须在这里吃掉：scheduleWithFixedDelay 的任务一旦抛出，**后续执行会被取消**，
     * 于是「某一次网络抖动让整个后台常驻静默死掉」—— 那是最难查的一类故障。
     */
    private fun syncOnce() {
        val outcome = try {
            // deep = false：这一趟只做「赶紧发现新东西并弹通知」（3 个接口）。
            // 离线缓存预热那 5 个接口留给 15 分钟的周期任务 —— 3 分钟一轮还带预热的话，
            // 一个班几十号人一天就能把后端的免费额度啃穿。
            SyncRunner.run(applicationContext, deep = false)
        } catch (e: Exception) {
            Log.w(TAG, "同步抛了异常，这一轮跳过：${e.javaClass.simpleName} ${e.message}")
            return
        }
        Log.i(TAG, "一轮完成：$outcome，上次同步时间=${Store.lastSyncAt(applicationContext)}")
    }

    /**
     * 升成前台。类型按版本分支传，不能只写一个常量：
     *   ≥ 34 用 specialUse —— 它没有时长上限，而且 targetSdk 升到 35 以后
     *         「BOOT_COMPLETED 不能启动的 6 种类型」名单里没有它，开机自启这条路将来也不会断
     *   29–33 用 dataSync —— 那时还没有 specialUse 这个值；6 小时上限也还没生效
     *         （那条只对 targetSdk ≥ 35 的应用）
     *   < 29 不传类型 —— 那时还没有「必须声明类型」的要求
     * manifest 里两个类型都声明了（见 AndroidManifest.xml），所以每一支都合法。
     */
    private fun startInForeground(): Boolean {
        val type = when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            else -> 0
        }
        return try {
            ServiceCompat.startForeground(
                this,
                Notifier.ONGOING_ID,
                Notifier.ongoingNotification(this),
                type
            )
            true
        } catch (e: Exception) {
            // 抬不起来（被后台启动限制拒了 / 类型声明不被这个系统接受 / 别的 ROM 说法）：
            // 自己停掉。最坏的结果只是「没有常驻」，15 分钟的周期任务照旧在跑 ——
            // 而硬撑下去会在 5 秒后变成应用级崩溃，那严重得多。
            Log.w(TAG, "升成前台失败，停掉自己：${e.javaClass.simpleName} ${e.message}")
            stopSelf()
            false
        }
    }

    companion object {
        private const val TAG = "CABackground"

        /**
         * 当前是否有服务实例。**进程内的标记而不是去问系统**：
         * ActivityManager.getRunningServices 早就废弃且被限制了，问不出来的。
         * 个人页那张卡片据此如实显示「后台常驻：运行中 / 已停止」。
         */
        @Volatile
        private var instance: BackgroundSyncService? = null

        fun isRunning(): Boolean = instance != null
    }
}
