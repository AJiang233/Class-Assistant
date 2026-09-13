import UIAbility from '@ohos.app.ability.UIAbility';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import Want from '@ohos.app.ability.Want';
import window from '@ohos.window';
import emitter from '@ohos.events.emitter';
import { Configuration } from '@ohos.app.ability.Configuration';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import notificationManager from '@ohos.notificationManager';
import { Store } from '../data/Store';
import { Scheduler } from '../sync/Scheduler';
import { SyncService } from '../sync/SyncService';
import { SystemBar } from '../common/SystemBar';
import { BridgeEvents } from '../common/Constants';
import { DeepLink } from '../common/DeepLink';

/**
 * 班级助理 — Web 套壳宿主。
 * Web 页面、JS 桥、同步与提醒调度的总入口。
 */
export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 首选项需要在所有同步/卡片逻辑之前就绪
    Store.init(this.context);
    // 从通知/提醒点进来（冷启动）：先存下深链，Index 建页时取走做起始地址
    DeepLink.set(DeepLink.fromWant(want));
  }

  /**
   * App 已在运行时点通知/提醒：系统走 onNewWant，onCreate 不会再执行，
   * 少了这一段就会「App 被拉到前台，但停在原来的页面，不跳那条活动/通知」。
   * 对应安卓端 MainActivity.onNewIntent。
   */
  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    const deep: string = DeepLink.fromWant(want);
    // 只有带深链才跳。桌面卡片的启动 want 不带深链，若不判断就会把用户正在看的页面重载回主页。
    if (deep.length === 0) {
      return;
    }
    DeepLink.set(deep);
    // 让页面立刻跳（是否打断教务登录由页面判断）
    emitter.emit({ eventId: BridgeEvents.DEEP_LINK }, { data: {} });
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
      }
    });
  }

  /**
   * 每次回到前台都同步一次（对应安卓端 MainActivity.onResume）。
   *
   * 原来只在 onWindowStageCreate 里同步：App 从后台切回来时它不会再跑，于是会出现
   * 「用户明明开着 App，新通知却还躺在服务端」。冷启动 onCreate → onWindowStageCreate
   * → onForeground 是紧挨着的，所以这一处也覆盖了原来那次「打开就同步」。
   *
   * 不会堆请求：60 秒节流与「上一轮没跑完就跳过」都在 SyncService.run 里。
   * 背景是周期任务最小 30 分钟、还不保证准点（见 Scheduler），只靠它会让临近开始的活动漏提醒。
   */
  onForeground(): void {
    SyncService.run(this.context);
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    SystemBar.apply(this.context,
      newConfig.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
  }
}
