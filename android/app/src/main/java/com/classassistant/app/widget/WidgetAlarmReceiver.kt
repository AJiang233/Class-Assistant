package com.classassistant.app.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.classassistant.app.sync.Scheduler

/**
 * 小组件的闹钟接收器：零点换天刷新（ACTION_MIDNIGHT）与上课期间每分钟重绘
 * （ACTION_CLASS_TICK，进度条往前走一格，issue #61）。
 *
 * 只由 Scheduler 用显式 Intent（点名组件）发送，所以 exported=false 且不带 intent-filter：
 * 系统广播进不来、第三方也调不动。原来这两个 action 挂在 WidgetRefreshReceiver 上 ——
 * 那个接收器为了收系统受保护广播（TIME_SET 等）必须 exported=true，等于让任何应用都能
 * 广播触发重绘 / 重排闹钟 / 排一轮同步（低危：无数据泄露，可被滥用成耗电，issue #84 项 14）。
 */
class WidgetAlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_CLASS_TICK -> {
                // 纯重绘，**不要**顺手排同步：每分钟排一轮网络任务，代价远大于进度条晚一格。
                // 也不碰零点闹钟与课程闹钟 —— 时间没变，那不是这个 action 的事。
                CoursesWidgetProvider.refreshAll(context)
            }
            ACTION_MIDNIGHT -> {
                Scheduler.refreshWidgets(context)
                Scheduler.scheduleMidnightRefresh(context)
                // 换天了，课程闹钟也重排一次（与原 WidgetRefreshReceiver 时间分支同一口径，
                // 见那条注释：绝对毫秒的触发时刻过了零点含义就变了）
                Scheduler.rescheduleCourseAlarms(context)
                // 换天了，让数据也跟上：同步那一轮会把「今天」那两个列表键按当天日期重新算出来
                // （OfflineApi.prewarmPaths），早上打开 App 才不用等网络。具体取舍见
                // WidgetRefreshReceiver 时间分支的同款注释。
                Scheduler.syncNow(context)
            }
        }
    }

    companion object {
        /** 自定义 action，由 Scheduler 用显式 Intent（点名组件）发过来，不需要进清单的 intent-filter */
        const val ACTION_MIDNIGHT = "com.classassistant.app.action.MIDNIGHT_REFRESH"

        /** 同上：上课期间每分钟一次的重绘（进度条往前走一格），由 Scheduler.scheduleClassTick 排 */
        const val ACTION_CLASS_TICK = "com.classassistant.app.action.CLASS_TICK"
    }
}
