import reminderAgentManager from '@ohos.reminderAgentManager';
import notificationManager from '@ohos.notificationManager';
import { SchoolEvent, formatDayClock } from '../model/SchoolEvent';
import { Store } from '../data/Store';
import { Constants } from '../common/Constants';

/**
 * 活动到点提醒：使用系统 reminderAgentManager 发布日历类提醒，
 * 由系统统一调度（App 未打开、重启后仍可触发），语义对应安卓端的 AlarmManager。
 *
 * 同一活动重复同步时不重复发布；活动被删除或过期后取消旧提醒。
 */
export class ReminderService {
  /** 按最新活动列表重排提醒 */
  static async reschedule(events: SchoolEvent[]): Promise<void> {
    const map: Map<number, number> = await Store.getReminderMap();
    const wanted: Set<number> = new Set<number>();
    const now: number = Date.now();

    for (let i = 0; i < events.length; i++) {
      wanted.add(events[i].id);
    }

    // 取消已删除活动、或已来不及提前提醒的活动的旧提醒
    const oldIds: number[] = Array.from(map.keys());
    for (let i = 0; i < oldIds.length; i++) {
      const eventId: number = oldIds[i];
      if (!wanted.has(eventId)) {
        await ReminderService.cancelReminder(map.get(eventId) as number);
        map.delete(eventId);
      }
    }

    // 发布新的提醒
    for (let i = 0; i < events.length; i++) {
      const event: SchoolEvent = events[i];
      const triggerAt: number = event.startMillis - Constants.REMIND_LEAD_MS;
      if (triggerAt <= now) {
        // 来不及提前提醒：若之前排过也取消掉
        if (map.has(event.id)) {
          await ReminderService.cancelReminder(map.get(event.id) as number);
          map.delete(event.id);
        }
        continue;
      }
      if (map.has(event.id)) {
        continue;
      }
      const reminderId: number = await ReminderService.publish(event, triggerAt);
      if (reminderId > 0) {
        map.set(event.id, reminderId);
      }
    }

    await Store.saveReminderMap(map);
  }

  private static async publish(event: SchoolEvent, triggerAtMillis: number): Promise<number> {
    const d: Date = new Date(triggerAtMillis);
    let content: string = formatDayClock(event.startMillis) + ' 开始';
    if (event.location.length > 0) {
      content += ' · ' + event.location;
    }
    const request: reminderAgentManager.ReminderRequestCalendar = {
      reminderType: reminderAgentManager.ReminderType.REMINDER_TYPE_CALENDAR,
      dateTime: {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        hour: d.getHours(),
        minute: d.getMinutes(),
        second: 0
      },
      title: event.title,
      content: content,
      notificationId: Constants.ACTIVITY_NOTIFICATION_BASE + event.id,
      slotType: notificationManager.SlotType.SOCIAL_COMMUNICATION,
      actionButton: [
        {
          title: '查看',
          type: reminderAgentManager.ActionButtonType.ACTION_BUTTON_TYPE_CLOSE
        }
      ]
    };
    try {
      return await reminderAgentManager.publishReminder(request);
    } catch (e) {
      return 0;
    }
  }

  private static async cancelReminder(reminderId: number): Promise<void> {
    try {
      await reminderAgentManager.cancelReminder(reminderId);
    } catch (e) {
      // 已不存在的提醒忽略
    }
  }

  /** 退出登录时清空全部提醒 */
  static async cancelAll(): Promise<void> {
    const map: Map<number, number> = await Store.getReminderMap();
    const reminderIds: number[] = Array.from(map.values());
    for (let i = 0; i < reminderIds.length; i++) {
      await ReminderService.cancelReminder(reminderIds[i]);
    }
    map.clear();
    await Store.saveReminderMap(map);
  }
}
