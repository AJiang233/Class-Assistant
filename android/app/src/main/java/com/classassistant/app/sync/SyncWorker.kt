package com.classassistant.app.sync

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * WorkManager 侧的同步任务：只把 [SyncRunner] 的结果翻译成 WorkManager 的说法。
 *
 * 真实逻辑在 SyncRunner 里 —— 前台服务（BackgroundSyncService）也调它。这里保持薄，
 * 就是为了不让两处各写一份「怎么同步、弹哪些通知」。
 */
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        // 周期任务走完整流程（含离线缓存预热）：它 15 分钟才来一次，预热这种重活归它
        val outcome = SyncRunner.run(applicationContext, deep = true)
        return if (outcome == SyncRunner.Outcome.Done) Result.success() else Result.retry()
    }
}
