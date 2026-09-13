import UIAbility from '@ohos.app.ability.UIAbility';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import Want from '@ohos.app.ability.Want';
import window from '@ohos.window';
import { Configuration } from '@ohos.app.ability.Configuration';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import notificationManager from '@ohos.notificationManager';
import { Store } from '../data/Store';
import { Scheduler } from '../sync/Scheduler';
import { SyncService } from '../sync/SyncService';
import { SystemBar } from '../common/SystemBar';

/**
 * 班级助理 — Web 套壳宿主。
 * Web 页面、JS 桥、同步与提醒调度的总入口。
 */
export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 首选项需要在所有同步/卡片逻辑之前就绪
    Store.init(this.context);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    SystemBar.apply(this.context, SystemBar.isSystemDark(this.context));
    windowStage.loadContent('pages/Index');

    // 请求用户允许通知（拒绝也不影响浏览）
    notificationManager.requestEnableNotification(this.context).catch((): void => {
      // 用户拒绝则后续通知静默失败
    });

    // 上次已登录：先把周期同步挂上，进页面后探针会再确认一次 token
    Store.getToken().then((token: string): void => {
      if (token.length > 0) {
        Scheduler.ensurePeriodic();
        SyncService.run(this.context);
      }
    });
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    SystemBar.apply(this.context,
      newConfig.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
  }
}
