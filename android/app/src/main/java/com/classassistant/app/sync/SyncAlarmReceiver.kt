package com.classassistant.app.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log
import com.classassistant.app.data.Store

/**
 * 深 Doze 里唯一能把我们叫起来的东西。
 *
 * 为什么需要它：前台服务能保住进程，但**保不住 CPU** —— 深 Doze 会把 CPU 一起挂起，
 * 而 BackgroundSyncService 里那个 `ScheduledExecutorService` 是进程内的定时器，
 * 没有任何办法把睡着的 CPU 叫醒。真机实测（见方案文档第九节）：`force-idle` 之后
 * `mState=IDLE` 期间一轮都没跑，服务本身还活着；`unforce` 一唤醒就立刻补上一轮。
 * 也就是说，少了这个闹钟，「手机搁在桌上不动」时是收不到通知的。
 *
 * 闹钟用 `setAndAllowWhileIdle`：它在 Doze 里**允许触发**，但被系统限流到约 9 分钟一次、
 * 且不精确 —— 所以深 Doze 下最快也就 9 分钟一轮，做不到前台服务那 3 分钟。
 *
 * **只在深 Doze 里真的干活**（下面 `isDeviceIdleMode` 那个判断）：不在 Doze 时定时器是准的，
 * 这里再跑一遍纯属重复请求 —— 一个班几十号人，白跑的量很可观。
 *
 * 用广播接收器而不是去拉前台服务：Android 12+ 禁止从后台启动前台服务，而
 * 「不精确的闹钟」不在豁免名单里（只有精确闹钟才算），拉服务会被拒。
 * 接收器自己跑一轮则完全绕开这条限制。
 */
class SyncAlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DOZE_WAKE) return

        // 先把下一轮排上：这一轮无论成败（甚至下面直接 return）都不能把链条断掉
        BackgroundMode.scheduleDozeWake(context)

        // 开关关掉或没登录时不起：那两种情况都不该有后台请求
        if (!BackgroundMode.isEnabled(context) || Store.token(context) == null) return
        // 不在深 Doze 就别插手：定时器此刻是准的，这里再跑一遍只是白耗请求
        if (!isDeviceIdle(context)) {
            Log.i(TAG, "闹钟到了，但设备不在深 Doze，交给服务里的定时器")
            return
        }

        // goAsync()：普通广播接收器只有约 10 秒，而这一轮要发 3 个网络请求。
        // 拿到 PendingResult 之后系统会给进程一小段额外时间，跑完必须 finish()。
        val pending = goAsync()
        Thread {
            try {
                Log.i(TAG, "深 Doze 里被闹钟叫醒，跑一轮")
                SyncRunner.run(context, deep = false)
            } catch (e: Exception) {
                Log.w(TAG, "这一轮失败：${e.javaClass.simpleName} ${e.message}")
            } finally {
                pending.finish()
            }
        }.start()
    }

    private fun isDeviceIdle(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return pm.isDeviceIdleMode
    }

    companion object {
        private const val TAG = "CABackground"

        /** 自定义 action，由 BackgroundMode 用显式 Intent 发过来，不需要进清单的 intent-filter */
        const val ACTION_DOZE_WAKE = "com.classassistant.app.action.DOZE_WAKE"
    }
}
