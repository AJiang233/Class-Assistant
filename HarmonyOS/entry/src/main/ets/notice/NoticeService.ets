import notificationManager from '@ohos.notificationManager';
import resourceManager from '@ohos.resourceManager';
import { Constants } from '../common/Constants';

/**
 * 通知槽位与发送。活动提醒与新通知分开两个槽位，方便用户分别开关。
 */
export class NoticeService {
  /** 创建/更新两个通知槽位，重复调用安全 */
  static async ensureSlots(rm: resourceManager.ResourceManager): Promise<void> {
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

  /** 新通知提醒 */
  static async publishNotice(title: string, body: string): Promise<void> {
    const content: notificationManager.NotificationContent = {
      notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
      normal: {
        title: title,
        text: body,
        additionalText: ''
      }
    };
    const request: notificationManager.NotificationRequest = {
      id: Constants.NOTICE_NOTIFICATION_ID,
      notificationSlotType: notificationManager.SlotType.CONTENT_INFORMATION,
      content: content
    };
    try {
      await notificationManager.publish(request);
    } catch (e) {
      // 用户未开启通知或权限受限，静默跳过
    }
  }
}
