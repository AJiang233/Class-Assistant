package com.classassistant.app.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 开机后恢复：WorkManager 的周期任务本身能跨重启存活，这里再兜一次底，
 * 并立即同步一次以重新排上提醒闹钟（闹钟在重启后会丢失）。
 * 另外把「后台常驻」的前台服务也重新挂上 —— 它和闹钟一样，进程一没就没了。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        Scheduler.ensurePeriodic(context)
        // 开机后必须立刻重排闹钟，不能被回前台的 60 秒节流挡掉
        Scheduler.syncNow(context, force = true)
        // 课程提醒只靠本地课表就能排，不必等上面那次同步的结果：
        // 断网开机时同步拉不到东西，只等它等于「开机后一条课程提醒都没有」。
        Scheduler.rescheduleCourseAlarms(context)
        // 跨过一夜再开机是常态，小组件得先按当天刷一遍
        Scheduler.refreshWidgets(context)
        Scheduler.scheduleMidnightRefresh(context)
        // 前台服务随重启一起没了，这里重新挂上。开机广播是「后台启动前台服务」的合法豁免时机之一，
        // 但还要 ROM 放行自启动、且应用不是 stopped 状态（首次安装后没打开过就收不到这个广播）
        BackgroundMode.apply(context)
    }
}
