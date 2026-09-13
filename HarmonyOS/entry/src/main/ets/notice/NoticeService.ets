import notificationManager from '@ohos.notificationManager';
import { DeepLink } from '../common/DeepLink';

/**
 * 通知槽位与发送。活动提醒与新通知分开两个槽位，方便用户分别开关。
 */
export class NoticeService {
  /** 创建/更新两个通知槽位，重复调用安全 */
  static async ensureSlots(): Promise<void> {
    try {
      await notificationManager.addSlot(notificationManager.SlotType.SOCIAL_COMMUNICATION);
    } catch (e) {
      // 已存在时系统会更新，忽略错误
    }
    try {
      await notificationManager.addSlot(notificationManager.SlotType.CONTENT_INFORMATION);
    } catch (e) {
      // 同上
    }
  }

  /**
   * 新通知提醒：一条通知发一条系统通知，各带自己的深链（点通知落到该条详情），互不覆盖。
   * notificationId 必须用 NOTICE_ID_BASE + 通知 id —— 与活动提醒的 id（直接用活动 id）拉开距离，
   * 否则两个列表里 id 相同的记录会互相顶掉，与安卓端 SyncWorker.notifyNewNotices 同号。
   */
  static async publishNotice(notificationId: number, title: string, body: string, deepLink: string): Promise<void> {
    await NoticeService.send(notificationId, notificationManager.SlotType.CONTENT_INFORMATION,
      title, body, deepLink);
  }

  /**
   * 活动提醒通知（与活动提醒同一槽位）。正常到点提醒走 reminderAgentManager（见 ReminderService），
   * 这里只给个人页的「推送通知测试」复现一条真实的活动提醒用。
   */
  static async publishActivity(notificationId: number, title: string, whenText: string,
    location: string): Promise<void> {
    let body: string = whenText;
    if (location.length > 0) {
      body += ' · ' + location;
    }
    await NoticeService.send(notificationId, notificationManager.SlotType.SOCIAL_COMMUNICATION,
      title, body, DeepLink.activity(notificationId));
  }

  private static async send(notificationId: number, slotType: notificationManager.SlotType,
    title: string, body: string, deepLink: string): Promise<void> {
    const content: notificationManager.NotificationContent = {
      notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
      normal: {
        title: title,
        text: body,
        additionalText: ''
      }
    };
    const request: notificationManager.NotificationRequest = {
      id: notificationId,
      notificationSlotType: slotType,
      content: content
    };
    // 系统通知不会自己打开 Ability，点通知要跳详情必须挂 wantAgent
    const agent = await DeepLink.buildWantAgent(notificationId, deepLink);
    if (agent !== undefined) {
      request.wantAgent = agent;
    }
    try {
      await notificationManager.publish(request);
    } catch (e) {
      // 用户未开启通知或权限受限，静默跳过
    }
  }
}
