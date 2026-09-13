import workScheduler from '@ohos.resourceschedule.workScheduler';
import { Constants } from '../common/Constants';

/**
 * 后台同步调度入口（对应安卓端 WorkManager）。
 * 周期任务由系统持久化调度：满足网络条件时每 30 分钟触发一次 SyncWorkAbility。
 */
export class Scheduler {
  /**
   * 确保周期同步任务已注册（重复调用幂等）。
   *
   * 先 stopWork 再 startWork 不是多余的：周期时长在注册那一刻就定格了，系统按 workId 记着
   * 旧排期，而 startWork 对已存在的 workId 会直接报错 —— 光改 Constants.SYNC_INTERVAL_MINUTES
   * 对已装的用户不生效，他们会一直停在旧周期上（和安卓端把 KEEP 换成 UPDATE 是同一个问题）。
   *
   * 代价只是把计时归零，而调用点只有「进程启动」（EntryAbility）和「登录成功」（Index）两处，
   * 两处都紧接着跑一次 SyncService.run()，所以不影响时效。
   */
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
      // 第二个参数 false：正在执行的那次不取消
      workScheduler.stopWork(info, false);
    } catch (e) {
      // 本来就没注册过，直接往下走
    }
    try {
      workScheduler.startWork(info);
    } catch (e) {
      // 注册失败不影响主流程，下次启动再尝试
    }
  }
}
