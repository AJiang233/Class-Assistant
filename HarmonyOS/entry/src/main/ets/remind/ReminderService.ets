import reminderAgentManager from '@ohos.reminderAgentManager';
import notificationManager from '@ohos.notificationManager';
import { SchoolEvent, formatDayClock } from '../model/SchoolEvent';
import { ReminderEntry, Store } from '../data/Store';
import { Constants } from '../common/Constants';
import { DeepLink } from '../common/DeepLink';

/**
 * 活动到点提醒：使用系统 reminderAgentManager 发布日历类提醒，
 * 由系统统一调度（App 未打开、重启后仍可触发），语义对应安卓端的 AlarmManager。
 *
 * 同一活动重复同步时不重复发布；活动被删除、改期或已开始后取消旧提醒（改期则按新时间重排）。
 */
export class ReminderService {
  /** 按最新活动列表重排提醒 */
  static async reschedule(events: SchoolEvent[]): Promise<void> {
    const map: Map<number, ReminderEntry> = await Store.getReminderMap();
    const wanted: Set<number> = new Set<number>();
    const now: number = Date.now();

    for (let i = 0; i < events.length; i++) {
      const event: SchoolEvent = events[i];
      // 已经开始的活动不再提醒（缓存里留着它们只是为了桌面卡片显示「今天」）
      if (event.startMillis <= now) {
        continue;
      }
      wanted.add(event.id);
      const triggerAt: number = event.startMillis - Constants.REMIND_LEAD_MS;
      // 已经进入提前量窗口（例如活动是开始前半小时内才同步到的）：补排一条立即提醒。
      // 以前这里直接放弃，导致这类活动永远不会响。
      // 日历提醒只精确到分钟（dateTime 的 second 固定为 0），所以取「下一分钟整点」——
      // 直接用 now 会落到已经过去的时间上。
      const effective: number = triggerAt <= now ? ReminderService.nextMinute(now) : triggerAt;
      const entry: ReminderEntry | undefined = map.get(event.id);
      // 排过、且触发时刻没变 → 系统里那条提醒还在（reminderAgent 的提醒重启后也不丢），不动它
      if (entry !== undefined && entry.triggerAt === effective) {
        continue;
      }
      // 排过但时刻变了（活动被改期）：必须先撤掉旧的，否则旧时间的提醒照响、新时间又没有提醒。
      // 安卓端每次都 setWindow 覆盖所以天然跟得上改期，这边得靠账本里记的旧 id 才撤得掉。
      if (entry !== undefined) {
        await ReminderService.cancelReminder(entry.reminderId);
        map.delete(event.id);
      }
      const reminderId: number = await ReminderService.publish(event, effective);
      if (reminderId > 0) {
        map.set(event.id, { reminderId: reminderId, triggerAt: effective });
      }
    }

    // 取消已删除活动、或已开始活动的旧提醒
    const oldIds: number[] = Array.from(map.keys());
    for (let i = 0; i < oldIds.length; i++) {
      const eventId: number = oldIds[i];
      if (!wanted.has(eventId)) {
        await ReminderService.cancelReminder((map.get(eventId) as ReminderEntry).reminderId);
        map.delete(eventId);
      }
    }

    await Store.saveReminderMap(map);
  }

  /** 下一分钟整点（dateTime 精确到分，直接给 now 会落到已过去的时间） */
  private static nextMinute(now: number): number {
    return (Math.floor(now / 60000) + 1) * 60000;
  }

  private static async publish(event: SchoolEvent, triggerAtMillis: number): Promise<number> {
    const d: Date = new Date(triggerAtMillis);
    let content: string = formatDayClock(event.startMillis) + ' 开始';
    if (event.location.length > 0) {
      content += ' · ' + event.location;
    }
    // 点提醒直达该活动详情，与安卓端 Notifier.notifyActivity 的深链拼法一致
    const params: Record<string, Object> = {};
    params[Constants.DEEP_LINK_KEY] = DeepLink.activity(event.id);
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
      // 通知 id 直接用活动 id，与安卓端 Notifier.notifyActivity 同号
      notificationId: event.id,
      slotType: notificationManager.SlotType.SOCIAL_COMMUNICATION,
      wantAgent: {
        pkgName: Constants.BUNDLE_NAME,
        abilityName: Constants.ENTRY_ABILITY,
        parameters: params
      },
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
    const map: Map<number, ReminderEntry> = await Store.getReminderMap();
    const eventIds: number[] = Array.from(map.keys());
    for (let i = 0; i < eventIds.length; i++) {
      await ReminderService.cancelReminder((map.get(eventIds[i]) as ReminderEntry).reminderId);
    }
    map.clear();
    await Store.saveReminderMap(map);
  }
}
