import WorkSchedulerExtensionAbility from '@ohos.WorkSchedulerExtensionAbility';
import workScheduler from '@ohos.resourceschedule.workScheduler';
import { SyncService } from './SyncService';

/**
 * 后台周期同步任务：由系统按 workScheduler 调度策略触发。
 */
export default class SyncWorkAbility extends WorkSchedulerExtensionAbility {
  onWorkStart(workInfo: workScheduler.WorkInfo): void {
    SyncService.run(this.context);
  }

  onWorkStop(workInfo: workScheduler.WorkInfo): void {
    // 任务条件不满足被系统停止时无需处理，等待下次调度
  }
}
