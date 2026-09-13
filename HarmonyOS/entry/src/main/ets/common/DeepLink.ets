import wantAgent from '@ohos.app.ability.wantAgent';
import Want from '@ohos.app.ability.Want';
import { Constants } from './Constants';

/**
 * 通知 / 提醒点击后的目标页深链，语义与安卓端 Notifier.EXTRA_DEEP_LINK 一致。
 *
 * 冷启动：UIAbility.onCreate 先把它存进 pending，Index 建页时取走（作为起页地址）；
 * 已在运行：onNewWant 存 pending 后再 emit DEEP_LINK 让页面立即跳。
 * 两条路都写 pending：emitter 不留历史事件，页面还没建好时 emit 会丢，pending 是兜底。
 */
export class DeepLink {
  private static pending: string = '';

  /** 从 want 里取深链；没有则返回空串 */
  static fromWant(want: Want | undefined): string {
    if (want === undefined || want === null ||
      want.parameters === undefined || want.parameters === null) {
      return '';
    }
    // 显式声明成 Object | undefined：want.parameters 的值类型是 Object，
    // 不显式声明就直接和 undefined 比，会被判成「两边类型没有交集」的比较
    const raw: Object | undefined = want.parameters[Constants.DEEP_LINK_KEY];
    if (raw === undefined || raw === null) {
      return '';
    }
    return String(raw).trim();
  }

  static set(deep: string): void {
    DeepLink.pending = deep;
  }

  /** 取走并清空，保证只消费一次 */
  static consume(): string {
    const value: string = DeepLink.pending;
    DeepLink.pending = '';
    return value;
  }

  /** 深链（?view=…&id=…）→ 完整地址；没有深链就回主页 */
  static toUrl(deep: string): string {
    return deep.length === 0 ? Constants.START_URL : Constants.START_URL + '/' + deep;
  }

  /** 某条活动详情页的深链，拼法与安卓端 Notifier.notifyActivity 一致 */
  static activity(activityId: number): string {
    return '?view=activities&id=' + activityId.toString();
  }

  /** 某条通知详情页的深链，拼法与安卓端 SyncWorker.notifyNewNotices 一致 */
  static notice(noticeId: number): string {
    return '?view=notices&id=' + noticeId.toString();
  }

  /**
   * 某条待填表单的深链，拼法与安卓端 SyncWorker.notifyNewTodos 一致。
   *
   * 和上面两个不一样，表单不在应用壳的视图白名单里（首页只列待填清单，没有单条详情页），
   * 所以直接指向网页的填写页 forms.html —— 与 Web Push 那条 url 是同一个落地页。
   * 因此这里是相对站点的完整页路径，不是 ?view=… 那种壳内深链。
   */
  static form(formId: number): string {
    return 'forms.html?id=' + formId.toString();
  }

  /**
   * 通知点击的目标：打开 EntryAbility，并把深链塞进 want.parameters
   * （EntryAbility 冷/热启动都从 parameters[DEEP_LINK_KEY] 里取，两条路共用一份解析）。
   * requestCode 用通知 id，同一条通知重复发拿到的是同一个 agent —— 深链本来就由这个 id 推出来，
   * 所以不设 wantAgentFlags 去强制覆盖。
   */
  static async buildWantAgent(notificationId: number, deep: string): Promise<wantAgent.WantAgent | undefined> {
    const params: Record<string, Object> = {};
    params[Constants.DEEP_LINK_KEY] = deep;
    const want: Want = {
      bundleName: Constants.BUNDLE_NAME,
      moduleName: Constants.ENTRY_MODULE,
      abilityName: Constants.ENTRY_ABILITY,
      parameters: params
    };
    try {
      // actionType 是 API 11 起的名字（旧名 operationType 已废弃），SDK 报错就换回 operationType
      return await wantAgent.getWantAgent({
        wants: [want],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: notificationId
      });
    } catch (e) {
      // 拿不到 agent 就不带跳转，通知本身照发
      return undefined;
    }
  }
}
