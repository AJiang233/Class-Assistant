import common from '@ohos.app.ability.common';
import { Store } from '../data/Store';
import { Api, ApiStatus, ActivityRow, ListResult, NoticeRow, UserInfo } from '../net/Api';
import { SchoolEvent, EventData, parseServerTime, startOfToday, formatDayClock } from '../model/SchoolEvent';
import { ReminderService } from '../remind/ReminderService';
import { NoticeService } from '../notice/NoticeService';
import { WidgetUpdater } from '../widget/WidgetUpdater';
import { Constants } from '../common/Constants';
import { DeepLink } from '../common/DeepLink';

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
    await NoticeService.ensureSlots();

    // 401 单独处理：token 已失效，重试不会成功，清掉本地会话后收手
    const activities: ListResult<ActivityRow> =
      await Api.getActivities('/api/activities?scope=all&limit=100', token);
    if (activities.status === ApiStatus.UNAUTHORIZED) {
      await SyncService.logOutSession(context);
      return;
    }
    const notices: ListResult<NoticeRow> =
      await Api.getNotices('/api/notices?limit=50', token);
    if (notices.status === ApiStatus.UNAUTHORIZED) {
      await SyncService.logOutSession(context);
      return;
    }
    // 网络/服务端异常：这轮什么都不动，等下次同步
    if (activities.status !== ApiStatus.OK || notices.status !== ApiStatus.OK) {
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
    // 缓存下限取「今天 00:00」而不是「现在」：桌面卡片只读这份缓存、标题又叫「今日活动」，
    // 所以今天已经开始（甚至已经结束）的活动也必须留着，否则正在进行的活动会显示成「今日暂无安排」。
    // 提醒不受影响 —— ReminderService.reschedule 自己会跳过已开始的活动。
    const earliest: number = startOfToday(now);
    const rows: SchoolEvent[] = [];

    for (let i = 0; i < activities.list.length; i++) {
      const row: ActivityRow = activities.list[i];
      const id: number = SyncService.idOf(row.id);
      if (id === 0) {
        continue;
      }
      const start: number = parseServerTime(row.start_time);
      if (start === 0 || start < earliest || start > horizon) {
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
      const title: string = row.title.length > 0 ? row.title : '班级活动';
      const location: string = row.location !== undefined && row.location !== null ? row.location : '';
      rows.push(new SchoolEvent(id, title, start, location));
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
    await SyncService.notifyNewNotices(notices.list);
    await WidgetUpdater.refreshAll(context);
  }

  /**
   * token 已被服务端判为失效（401）。再重试也不会有结果，清掉本地会话后收手，
   * 等用户在网页重新登录时由探针把新 token 推过来。
   */
  static async logOutSession(context: common.Context): Promise<void> {
    // 顺序要紧：cancelAll 是照着 reminder_map 里的记录逐个取消的，
    // 若先把存储清了，这些 id 就丢了，提醒会留在系统里继续响。
    await ReminderService.cancelAll();
    await Store.clearSession();
    await WidgetUpdater.refreshAll(context);
  }

  /** 同步时发现比上次更新更晚的通知，逐条提醒一次 */
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

    // 每条新通知单独发一条、各带自己的深链（网页侧读 ?view=notices&id= 后落到该条），互不覆盖
    for (let i = 0; i < rows.length; i++) {
      const row: NoticeRow = rows[i];
      const t: number = parseServerTime(row.publish_time);
      const id: number = SyncService.idOf(row.id);
      if (t <= lastSeen || id === 0) {
        continue;
      }
      const title: string = row.title.length > 0 ? row.title : '新的班级通知';
      const content: string = row.content.replace(/\n/g, ' ');
      const body: string = content.length > 0 ? content.substring(0, 120) : '点击查看详情';
      await NoticeService.publishNotice(Constants.NOTICE_ID_BASE + id, title, body,
        DeepLink.notice(id));
    }

    if (newest > lastSeen) {
      await Store.setLastNoticeTime(newest);
    }
  }

  /**
   * 个人页「推送通知测试」用：拉最新一条真实活动 / 通知，按其 id 与深链发一条本地通知，
   * 让用户自查推送是否可达、点通知能否跳到对应详情。kind 为 "activity" / "notice"。
   * 复用真实 id：和正式提醒同号，重复点会覆盖而不是叠一堆，深链也一致。
   * 这里只管发、不返回结果：「本地没登录」这一分支由桥（Index.HostBridge.testNotification）用同步接口挡掉
   * 并回一句提示，其余结果网页显示兜底文案 —— 对比安卓端能同步阻塞拿回完整提示，是有损的。
   */
  static async pushTestNotification(kind: string): Promise<void> {
    const token: string = await Store.getToken();
    if (token.length === 0) {
      return;
    }
    await NoticeService.ensureSlots();
    // 两个列表接口都是最新在前（活动按 start_time DESC，通知按 publish_time DESC），取第一条即可
    if (kind === 'activity') {
      const res: ListResult<ActivityRow> =
        await Api.getActivities('/api/activities?scope=all&limit=1', token);
      if (res.status !== ApiStatus.OK || res.list.length === 0) {
        return;
      }
      const row: ActivityRow = res.list[0];
      const id: number = SyncService.idOf(row.id);
      if (id === 0) {
        return;
      }
      const start: number = parseServerTime(row.start_time);
      const when: string = start > 0 ? formatDayClock(start) + ' 开始' : '即将开始';
      const title: string = row.title.length > 0 ? row.title : '班级活动';
      const location: string = row.location !== undefined && row.location !== null ? row.location : '';
      await NoticeService.publishActivity(id, title, when, location);
      return;
    }
    if (kind === 'notice') {
      const res: ListResult<NoticeRow> =
        await Api.getNotices('/api/notices?scope=all&limit=1', token);
      if (res.status !== ApiStatus.OK || res.list.length === 0) {
        return;
      }
      const row: NoticeRow = res.list[0];
      const id: number = SyncService.idOf(row.id);
      if (id === 0) {
        return;
      }
      const title: string = row.title.length > 0 ? row.title : '班级通知';
      const content: string = row.content.replace(/\n/g, ' ');
      const body: string = content.length > 0 ? content.substring(0, 120) : '点击查看详情';
      await NoticeService.publishNotice(Constants.NOTICE_ID_BASE + id, title, body,
        DeepLink.notice(id));
    }
  }

  /** 服务端可能不给 id（解析后是 undefined），统一按 0 处理，对应安卓端的 optInt("id", 0) */
  private static idOf(value: number | undefined): number {
    return value === undefined || value === null ? 0 : value;
  }
}
