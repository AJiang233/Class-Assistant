import common from '@ohos.app.ability.common';
import { Store } from '../data/Store';
import { Api, ApiStatus, ActivityRow, ListResult, NoticeRow, TodoRow, UserInfo } from '../net/Api';
import { SchoolEvent, EventData, parseServerTime, startOfToday, formatDayClock } from '../model/SchoolEvent';
import { ReminderService } from '../remind/ReminderService';
import { NoticeService } from '../notice/NoticeService';
import { WidgetUpdater } from '../widget/WidgetUpdater';
import { Constants } from '../common/Constants';
import { DeepLink } from '../common/DeepLink';

/**
 * 后台同步：拉取活动 / 通知 / 待填表单 → 更新本地缓存 → 重排提醒 → 对新通知与新表单发提醒 → 刷新卡片。
 * 未登录（没有 token）时直接跳过，等用户在网页里登录后由页面触发。
 */
export class SyncService {
  /** 回前台同步的节流窗口（毫秒），与安卓端 Scheduler.SYNC_THROTTLE_MILLIS 同值 */
  private static readonly SYNC_THROTTLE_MILLIS: number = 60 * 1000;

  /**
   * 正在跑的那一轮同步。回前台（EntryAbility.onForeground）与 30 分钟周期任务
   * （SyncWorkAbility）可能几乎同时进来，没有它就会并发拉两轮相同请求。
   * 安卓端靠「唯一任务名 + KEEP」达到同样效果，这边没有等价机制，只能自己挡一道。
   */
  private static running: boolean = false;

  /**
   * 同步入口：只负责节流与去重，真正干活在 sync()。
   *
   * 默认带 60 秒节流（对应安卓端 Scheduler.syncNow）：回前台触发得非常频繁
   * （切一下应用、锁屏解锁都算），每次都拉一轮完整请求纯属白耗流量和电。
   * 判据取「上次同步**完成**时间」而不是「上次触发时间」，所以同步一直失败时不会被
   * 节流卡住 —— 下次回前台照常重试（这个时间由本轮拉完数据后写入，见 sync 末尾）。
   *
   * 登录成功、卡片手动刷新这类「必须马上拉到」的场景传 force = true 绕过节流。
   */
  static async run(context: common.Context, force: boolean = false): Promise<void> {
    if (SyncService.running) {
      return;
    }
    if (!force && Date.now() - Store.getLastSyncTimeSync() < SyncService.SYNC_THROTTLE_MILLIS) {
      return;
    }
    SyncService.running = true;
    try {
      await SyncService.sync(context);
    } finally {
      SyncService.running = false;
    }
  }

  private static async sync(context: common.Context): Promise<void> {
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
    const todos: ListResult<TodoRow> =
      await Api.getMyTodos('/api/forms/mine', token);
    if (todos.status === ApiStatus.UNAUTHORIZED) {
      await SyncService.logOutSession(context);
      return;
    }
    // 网络/服务端异常：这轮什么都不动，等下次同步
    if (activities.status !== ApiStatus.OK || notices.status !== ApiStatus.OK) {
      return;
    }
    // 表单拉不到（网络抖动 / 5xx）不拖垮整轮：活动与通知才是主线，
    // 少提醒一条表单待办，比「活动提醒也一起不排了」轻得多，所以这里当成空清单继续往下走
    const todoList: TodoRow[] = todos.status === ApiStatus.OK ? todos.list : [];

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
      if (!SyncService.isMine(row.remind_people, meId, meName)) {
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
    await SyncService.notifyNewNotices(notices.list, meId, meName);
    await SyncService.notifyNewTodos(todoList);
    await WidgetUpdater.refreshAll(context);
    await Store.setLastSyncTime(Date.now());
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

  /**
   * 这条活动 / 通知该不该提醒当前用户：remind_people 为空按「全班」处理，否则只提醒名单里的人
   * （名单里存的是姓名或用户 id，见 Api.parsePeople）。
   *
   * 活动、通知两条路都走这一份判定 —— 只在活动那边写一遍的话，通知就会「没被点名也弹」，
   * 与网页列表的 remindMe()、服务端「推给谁」的口径都不一致（见后端 utils/audience.js）。
   * 待填表单不走这里：/api/forms/mine 服务端已按提醒对象滤过，客户端再滤一遍是白做。
   */
  private static isMine(raw: string | string[] | null | undefined, meId: string, meName: string): boolean {
    const people: string[] = Api.parsePeople(raw);
    if (people.length === 0) {
      return true;
    }
    return (meName.length > 0 && people.indexOf(meName) >= 0) ||
      (meId.length > 0 && people.indexOf(meId) >= 0);
  }

  /** 同步时发现比上次更新更晚的通知，逐条提醒一次（只提醒提醒对象里的，见 isMine） */
  private static async notifyNewNotices(rows: NoticeRow[], meId: string, meName: string): Promise<void> {
    // 先按提醒对象筛一道再算基线：last_notice_time 记的必须是「我该看到的」最新时间，
    // 否则会拿别人的通知时间当基线，回头真点名我的那条反倒被当成旧的漏掉。
    const mine: NoticeRow[] = rows.filter((row: NoticeRow): boolean =>
      SyncService.isMine(row.remind_people, meId, meName));
    let newest: number = 0;
    for (let i = 0; i < mine.length; i++) {
      const t: number = parseServerTime(mine[i].publish_time);
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
    for (let i = 0; i < mine.length; i++) {
      const row: NoticeRow = mine[i];
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
   * 同步时发现比上次更新更晚的待填表单，逐条提醒一次。
   *
   * 与 notifyNewNotices 同一套「首次同步只记基线」的逻辑：装机时把当前所有待填表单一起推
   * 不是提醒，是刷屏。判新用 created_at（服务端下发时刻），口径与通知的 publish_time 一致。
   * 表单在本端没有列表页，点通知直接开网页的填写页（forms.html?id=…，见 DeepLink.form），
   * 与 Web Push 那条 url 是同一个落地页。
   */
  private static async notifyNewTodos(rows: TodoRow[]): Promise<void> {
    let newest: number = 0;
    for (let i = 0; i < rows.length; i++) {
      const created: string = rows[i].created_at !== undefined ? rows[i].created_at : '';
      const t: number = parseServerTime(created);
      if (t > newest) {
        newest = t;
      }
    }
    if (newest === 0) {
      return;
    }
    const lastSeen: number = await Store.getLastTodoTime();
    if (lastSeen === 0) {
      // 首次同步只记录基线，避免装机时把历史表单全推一遍
      await Store.setLastTodoTime(newest);
      return;
    }

    for (let i = 0; i < rows.length; i++) {
      const row: TodoRow = rows[i];
      const created: string = row.created_at !== undefined ? row.created_at : '';
      const t: number = parseServerTime(created);
      const id: number = SyncService.idOf(row.id);
      if (t <= lastSeen || id === 0) {
        continue;
      }
      const title: string = row.title.length > 0 ? row.title : '待填表单';
      await NoticeService.publishNotice(Constants.TODO_ID_BASE + id, '新的待填表单：' + title,
        '待填表单，点击打开填写', DeepLink.form(id));
    }

    if (newest > lastSeen) {
      await Store.setLastTodoTime(newest);
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
