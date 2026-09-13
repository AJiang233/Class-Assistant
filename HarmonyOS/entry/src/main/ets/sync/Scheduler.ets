import workScheduler from '@ohos.resourceschedule.workScheduler';
import { Constants } from '../common/Constants';

/**
 * 后台同步调度入口（对应安卓端 WorkManager）。
 * 周期任务由系统持久化调度：满足网络条件时每小时触发一次 SyncWorkAbility。
 */
export class Scheduler {
  /** 确保周期同步任务已注册（重复调用幂等） */
  static async ensurePeriodic(): Promise<void> {
    const info: workScheduler.WorkInfo = {
      workId: Constants.SYNC_WORK_ID,
      networkType: workScheduler.NetworkType.NETWORK_TYPE_ANY,
      isRepeat: true,
      // WorkInfo.repeatCycleTime 单位为毫秒
      repeatCycleTime: Constants.SYNC_INTERVAL_MINUTES * 60 * 1000,
      bundleName: Constants.BUNDLE_NAME,
      abilityName: 'SyncWorkAbility'
    };
    try {
      // 已注册时 getWorkStatus 正常返回；抛错说明任务不存在，再注册
      await workScheduler.getWorkStatus(Constants.SYNC_WORK_ID);
    } catch (e) {
      try {
        workScheduler.startWork(info);
      } catch (e2) {
        // 注册失败不影响主流程，下次启动再尝试
      }
    }
  }
}
