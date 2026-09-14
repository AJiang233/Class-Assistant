package com.classassistant.app.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.classassistant.app.sync.BackgroundMode
import com.classassistant.app.sync.Scheduler

/**
 * 小组件的「换天」触发器。
 *
 * 两个小组件的内容都按**设备本地日期**算（今日活动 / 今日课程），但原本没有任何东西会在
 * 零点叫它们一声：后台同步会被 Doze 推迟，updatePeriodMillis 最少也是 30 分钟 ——
 * 于是第二天早上打开手机，桌面还挂着昨天那一屏，而 render() 里的日期过滤根本没机会重跑。
 * 这里接管三类时机：
 *
 *   1. Scheduler.scheduleMidnightRefresh 排的本地零点闹钟（主力），刷完自己再排下一次
 *   2. 系统时间被改 / 时区变了 —— RTC 闹钟按绝对毫秒存，时区一变「09:50 上课」的含义就变了，
 *      所以这里连课程闹钟也一起重排
 *   3. 应用被覆盖安装 —— 闹钟与 AllowedAlarms 都会被清掉，得重新排
 *
 * 特意**没有**注册 DATE_CHANGED：它不在系统的隐式广播豁免名单里，
 * 清单注册的接收器收不到（Android 8 起隐式广播不再投递给静态接收器）。
 * 换天只能靠上面的零点闹钟兜，这也是那边用闹钟而不是等系统广播的原因。
 */
class WidgetRefreshReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_MIDNIGHT,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED -> {
                Scheduler.refreshWidgets(context)
                Scheduler.scheduleMidnightRefresh(context)
                // 时间/时区变了，课程闹钟的绝对触发时刻要重算
                Scheduler.rescheduleCourseAlarms(context)
                // 换天了，让数据也跟上：同步那一轮会把「今天」那两个列表键按当天日期重新算出来
                // （OfflineApi.prewarmPaths），早上打开 App 才不用等网络。
                //
                // 这一行是「尽量早」，不是唯一保障：周期同步（15 分钟一轮，走的是 deep 轮次）
                // 本来也会按当天日期预热这两个键 —— 只是深夜设备在 Doze 里，那一轮可能被推迟到早上。
                //
                // 两点都不做：**不自己发请求**（被广播拉起的进程还在后台，网络被系统挡着，实测连
                // DNS 都解析不了）、**不自己起线程**（onReceive 一返回进程就悬了，第一版就是这么
                // 写的，两个键一个都没补上）。交给 WorkManager 排队：跑得动就跑，跑不动还有周期同步兜着。
                Scheduler.syncNow(context)
            }
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                // 覆盖安装会把闹钟与 AllowedAlarms 一起清掉，得重新排
                Scheduler.refreshWidgets(context)
                Scheduler.scheduleMidnightRefresh(context)
                Scheduler.rescheduleCourseAlarms(context)
                // 前台服务也随安装一起没了，这里重新挂上
                BackgroundMode.apply(context)
            }
        }
    }

    companion object {
        /** 自定义 action，由 Scheduler 用显式 Intent（点名组件）发过来，不需要进清单的 intent-filter */
        const val ACTION_MIDNIGHT = "com.classassistant.app.action.MIDNIGHT_REFRESH"
    }
}
