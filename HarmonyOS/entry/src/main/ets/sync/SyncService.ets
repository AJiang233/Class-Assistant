import common from '@ohos.app.ability.common';
import { Store } from '../data/Store';
import { Api, ActivityRow, NoticeRow, UserInfo } from '../net/Api';
import { SchoolEvent, EventData, parseServerTime } from '../model/SchoolEvent';
import { ReminderService } from '../remind/ReminderService';
import { NoticeService } from '../notice/NoticeService';
import { WidgetUpdater } from '../widget/WidgetUpdater';
import { Constants } from '../common/Constants';

/**
 * 后台同步：拉取活动与通知 → 更新本地缓存 → 重排提醒 → 对新通知发提醒 → 刷新卡片。
 * 未登录（没有 token）时直接跳过，等用户在网页里登录后由页面触发。
 */
export class SyncService {
  static async run(context: common.Context): Promise<void> {
    await Store.init(context);
    const token: string = await Store.getToken();
    if (token.length === 0) {
      return;
    }
    await NoticeService.ensureSlots(context.resourceManager);

    const activities: ActivityRow[] | null =
      await Api.getActivities('/api/activities?scope=all&limit=100', token);
    if (activities === null) {
      return;
    }
    const notices: NoticeRow[] | null =
      await Api.getNotices('/api/notices?limit=50', token);
    if (notices === null) {
      return;
    }

    const me: UserInfo | null = Api.decodeUser(token);
    let meId: string = '';
    let meName: string = '';
    if (me !== null) {
      meId = me.id;
      meName = me.name;
      await Store.saveUser(meId, meName);
    }

    const now: number = Date.now();
    const horizon: number = now + Constants.HORIZON_MS;
    const rows: SchoolEvent[] = [];

    for (let i = 0; i < activities.length; i++) {
      const row: ActivityRow = activities[i];
      const start: number = parseServerTime(row.start_time);
      if (start === 0 || start < now - 60000 || start > horizon) {
        continue;
      }
      // remind_people 为空按「全班」处理；否则只提醒名单里的人
      const people: string[] = Api.parsePeople(row.remind_people);
      const mine: boolean = people.length === 0 ||
        (meName.length > 0 && people.indexOf(meName) >= 0) ||
        (meId.length > 0 && people.indexOf(meId) >= 0);
      if (!mine) {
        continue;
      }
      if (row.id === 0) {
        continue;
      }
      const title: string = row.title.length > 0 ? row.title : '班级活动';
      const location: string = row.location !== undefined && row.location !== null ? row.location : '';
      rows.push(new SchoolEvent(row.id, title, start, location));
    }

    rows.sort((a: SchoolEvent, b: SchoolEvent): number => a.startMillis - b.startMillis);

    const data: EventData[] = [];
    for (let i = 0; i < rows.length; i++) {
      data.push({
        id: rows[i].id,
        title: rows[i].title,
        start: rows[i].startMillis,
        location: rows[i].location
      });
    }
    await Store.saveEvents(data);
    await ReminderService.reschedule(rows);
    await SyncService.notifyNewNotices(notices);
    await Store.markSynced();
    await WidgetUpdater.refreshAll(context);
  }

  /** 同步时发现比上次更新更晚的通知，就提醒一次 */
  private static async notifyNewNotices(rows: NoticeRow[]): Promise<void> {
    let newest: number = 0;
    for (let i = 0; i < rows.length; i++) {
      const t: number = parseServerTime(rows[i].publish_time);
      if (t > newest) {
        newest = t;
      }
    }
    if (newest === 0) {
      return;
    }
    const lastSeen: number = await Store.getLastNoticeTime();
    if (lastSeen === 0) {
      // 首次同步只记录基线，避免装机时把历史通知全推一遍
      await Store.setLastNoticeTime(newest);
      return;
    }

    const fresh: NoticeRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const t: number = parseServerTime(rows[i].publish_time);
      if (t > lastSeen) {
        fresh.push(rows[i]);
      }
    }

    if (fresh.length > 0) {
      let title: string = '';
      let body: string = '';
      if (fresh.length === 1) {
        title = fresh[0].title.length > 0 ? fresh[0].title : '新的班级通知';
        const content: string = fresh[0].content.replace(/\n/g, ' ');
        body = content.length > 0 ? content.substring(0, 120) : '点击查看详情';
      } else {
        title = '有 ' + fresh.length.toString() + ' 条新的班级通知';
        const names: string[] = [];
        const count: number = Math.min(3, fresh.length);
        for (let i = 0; i < count; i++) {
          names.push(fresh[i].title);
        }
        body = names.join('、').substring(0, 120);
      }
      await NoticeService.publishNotice(title, body);
    }

    if (newest > lastSeen) {
      await Store.setLastNoticeTime(newest);
    }
  }
}
