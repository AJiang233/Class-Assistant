import notificationManager from '@ohos.notificationManager';
import { DeepLink } from '../common/DeepLink';

/**
 * 通知槽位与发送。活动提醒与新通知分开两个槽位，方便用户分别开关。
 */
export class NoticeService {
  /**
   * 创建/更新两个通知槽位，重复调用安全。
   *
   * level 必须显式给 LEVEL_HIGH（横幅 / 弹窗 + 响铃）：系统给槽位的默认级别只会在通知栏里
   * 静默堆着，用户根本注意不到 —— 对应安卓端把渠道重要性提到 IMPORTANCE_HIGH，那边还把渠道
   * 换成了新 id（class_notice_v2），因为重要性在渠道创建后只能下调不能上调。
   *
   * 待真机确认：鸿蒙文档说 addSlot 对已存在的槽位是「更新」，但**能不能把级别往上调**
   * 没有实测过（安卓就是调不上去的）。若老用户升上来仍不弹横幅，只能走 removeSlot + addSlot
   * 重建，代价是该槽位里用户改过的偏好会被一并重置 —— 所以没验证前先别改成重建。
   */
  static async ensureSlots(): Promise<void> {
    try {
      await notificationManager.addSlot(notificationManager.SlotType.SOCIAL_COMMUNICATION, {
        type: notificationManager.SlotType.SOCIAL_COMMUNICATION,
        level: notificationManager.SlotLevel.LEVEL_HIGH
      });
    } catch (e) {
      // 已存在时系统会更新，忽略错误
    }
    try {
      await notificationManager.addSlot(notificationManager.SlotType.CONTENT_INFORMATION, {
        type: notificationManager.SlotType.CONTENT_INFORMATION,
        level: notificationManager.SlotLevel.LEVEL_HIGH
      });
    } catch (e) {
      // 同上
    }
  }

  /**
   * 新通知 / 新待填表单提醒：一条内容发一条系统通知，各带自己的深链（点通知落到该条详情），互不覆盖。
   * 两者共用 CONTENT_INFORMATION 槽位 —— 表单本来就是「班委发的通知」的一种措辞，
   * 单独开槽位只会让用户在系统设置里多一个开关要管。
   * notificationId 必须用 NOTICE_ID_BASE + 通知 id（表单则是 Constants.TODO_ID_BASE + 表单 id）——
   * 与活动提醒的 id（直接用活动 id）拉开距离，否则两个列表里 id 相同的记录会互相顶掉，
   * 与安卓端 SyncWorker.notifyNewNotices / notifyNewTodos 同号。
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
