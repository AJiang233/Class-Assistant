import preferences from '@ohos.data.preferences';
import common from '@ohos.app.ability.common';
import { EventData } from '../model/SchoolEvent';

/**
 * 已排提醒的账本项（存在 KEY_REMINDER_MAP 里，key 是活动 id）。
 *
 * reminderId 用来取消系统里那条提醒；triggerAt 是当初排的触发时刻（毫秒），
 * 活动被改期时靠它判断「时刻变了没有」——变了就撤旧排新。
 * 安卓端每次同步都无条件 setWindow（同 requestCode 覆盖，改期自然跟上）；
 * 这边的 reminderAgent 提醒在设备重启后仍留在系统里，不需要每次都重排，
 * 所以只在时刻真的变了才动系统，省掉每小时的无效增删。
 */
export interface ReminderEntry {
  reminderId: number;
  triggerAt: number;
}

/**
 * 本地存储：登录凭据 + 同步任务写入的日程缓存。
 * 提醒与桌面卡片都从这里读数据，避免各自重复请求接口。
 */
export class Store {
  private static readonly STORE_NAME: string = 'class_assistant';

  private static readonly KEY_TOKEN: string = 'token';
  private static readonly KEY_USER_ID: string = 'user_id';
  private static readonly KEY_USER_NAME: string = 'user_name';
  private static readonly KEY_LAST_NOTICE_TIME: string = 'last_notice_time';
  private static readonly KEY_LAST_TODO_TIME: string = 'last_todo_time';
  private static readonly KEY_LAST_SYNC_AT: string = 'last_sync_at';
  private static readonly KEY_EVENTS: string = 'events';
  private static readonly KEY_FORM_IDS: string = 'form_ids';
  private static readonly KEY_REMINDER_MAP: string = 'reminder_map';

  private static prefs: preferences.Preferences | null = null;

  /** 在各 Ability 的 onCreate 中调用，内部幂等 */
  static async init(context: common.Context): Promise<void> {
    if (Store.prefs !== null) {
      return;
    }
    Store.prefs = await preferences.getPreferences(context, Store.STORE_NAME);
  }

  private static sp(): preferences.Preferences {
    if (Store.prefs === null) {
      throw new Error('Store not initialized');
    }
    return Store.prefs;
  }

  private static async getString(key: string): Promise<string> {
    const value = await Store.sp().get(key, '');
    return value as string;
  }

  private static async putString(key: string, value: string): Promise<void> {
    await Store.sp().put(key, value);
    await Store.sp().flush();
  }

  // ===== 登录凭据（由网页 localStorage 经 JS 桥同步过来） =====

  static async getToken(): Promise<string> {
    const token: string = await Store.getString(Store.KEY_TOKEN);
    return token.trim().length > 0 ? token : '';
  }

  static async saveToken(token: string): Promise<void> {
    await Store.putString(Store.KEY_TOKEN, token);
  }

  /**
   * 同步读 token。JS 桥方法必须同步返回，网页的「推送通知测试」靠它判断本地有没有登录态
   * （对应安卓端 HostBridge 里那句同步的 Store.token()）。
   * 首选项的 getSync 是同步接口，异步的 getToken 在桥里用不了。
   * prefs 还没就绪时返回空串 —— 桥被调用时 EntryAbility.onCreate 早已跑完，实际不会走到这。
   */
  static getTokenSync(): string {
    if (Store.prefs === null) {
      return '';
    }
    const value = Store.prefs.getSync(Store.KEY_TOKEN, '') as string;
    return value.trim().length > 0 ? value : '';
  }

  static async saveUser(userId: string, userName: string): Promise<void> {
    await Store.sp().put(Store.KEY_USER_ID, userId);
    await Store.sp().put(Store.KEY_USER_NAME, userName);
    await Store.sp().flush();
  }

  static async getUserId(): Promise<string> {
    return Store.getString(Store.KEY_USER_ID);
  }

  static async getUserName(): Promise<string> {
    return Store.getString(Store.KEY_USER_NAME);
  }

  /**
   * 退出登录：清凭据 + 同步缓存。
   * events 不清的话，桌面卡片会继续显示上一个账号当天的活动；last_notice_time 不清的话，
   * 换账号后首次同步会把历史通知当新的逐条补推（「首次同步只记基线」那一支进不去）；
   * last_todo_time（待填表单，见 SyncService.notifyNewTodos）同理；
   * reminder_map 是已排提醒的账本，留着会被下一个账号拿去取消不存在的提醒。
   * 注意：取消提醒与重绘卡片不在这里做 —— 退出登录请统一走 SyncService.logOutSession()。
   */
  static async clearSession(): Promise<void> {
    const sp = Store.sp();
    await sp.delete(Store.KEY_TOKEN);
    await sp.delete(Store.KEY_USER_ID);
    await sp.delete(Store.KEY_USER_NAME);
    await sp.delete(Store.KEY_EVENTS);
    await sp.delete(Store.KEY_LAST_NOTICE_TIME);
    await sp.delete(Store.KEY_LAST_TODO_TIME);
    await sp.delete(Store.KEY_LAST_SYNC_AT);
    await sp.delete(Store.KEY_REMINDER_MAP);
    await sp.flush();
  }

  // ===== 同步状态 =====

  static async getLastNoticeTime(): Promise<number> {
    const value = await Store.sp().get(Store.KEY_LAST_NOTICE_TIME, 0);
    return value as number;
  }

  static async setLastNoticeTime(value: number): Promise<void> {
    await Store.sp().put(Store.KEY_LAST_NOTICE_TIME, value);
    await Store.sp().flush();
  }

  /**
   * 上次同步时看到的最新**待填表单**下发时间（毫秒时间戳，由服务端 created_at 解析而来，0 = 没同步过）。
   *
   * 名字用 todo 而不是 form：这里的「表单」是班委下发的待填表单（网页侧的 /api/forms/mine，
   * 首页「待填表单」那一栏），而本仓库鸿蒙端的 form 已经是 ArkTS 桌面卡片（KEY_FORM_IDS、
   * EntryFormAbility）。沿用 form 命名会把两件不相干的东西混在一起，所以两端统一叫 todo。
   */
  static async getLastTodoTime(): Promise<number> {
    const value = await Store.sp().get(Store.KEY_LAST_TODO_TIME, 0);
    return value as number;
  }

  static async setLastTodoTime(value: number): Promise<void> {
    await Store.sp().put(Store.KEY_LAST_TODO_TIME, value);
    await Store.sp().flush();
  }

  /**
   * 上次**成功**同步的完成时间（毫秒），由 SyncService 拉完数据后写入；没同步过是 0。
   * 只用于个人页显示的「上次同步」（经桥 CAHost.appStatus 同步读回）。
   */
  static async setLastSyncTime(value: number): Promise<void> {
    await Store.sp().put(Store.KEY_LAST_SYNC_AT, value);
    await Store.sp().flush();
  }

  /**
   * 同步读上次同步时间。桥方法 CAHost.appStatus() 必须同步返回，异步的 get 在桥里用不了；
   * 与 getTokenSync 同一套写法（见那边的注释）。prefs 还没就绪时返回 0。
   */
  static getLastSyncTimeSync(): number {
    if (Store.prefs === null) {
      return 0;
    }
    return Store.prefs.getSync(Store.KEY_LAST_SYNC_AT, 0) as number;
  }

  // ===== 日程缓存（未来若干天的活动，按开始时间升序） =====

  static async getEvents(): Promise<EventData[]> {
    const raw: string = await Store.getString(Store.KEY_EVENTS);
    if (raw.length === 0) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as EventData[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  static async saveEvents(events: EventData[]): Promise<void> {
    await Store.putString(Store.KEY_EVENTS, JSON.stringify(events));
  }

  // ===== 桌面卡片实例 =====

  static async getFormIds(): Promise<string[]> {
    const raw: string = await Store.getString(Store.KEY_FORM_IDS);
    if (raw.length === 0) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as string[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  static async addFormId(formId: string): Promise<void> {
    const ids: string[] = await Store.getFormIds();
    if (ids.indexOf(formId) < 0) {
      ids.push(formId);
      await Store.putString(Store.KEY_FORM_IDS, JSON.stringify(ids));
    }
  }

  static async removeFormId(formId: string): Promise<void> {
    const ids: string[] = await Store.getFormIds();
    const index: number = ids.indexOf(formId);
    if (index >= 0) {
      ids.splice(index, 1);
      await Store.putString(Store.KEY_FORM_IDS, JSON.stringify(ids));
    }
  }

  // ===== 活动 id -> 已排提醒的账本 =====

  static async getReminderMap(): Promise<Map<number, ReminderEntry>> {
    const result: Map<number, ReminderEntry> = new Map<number, ReminderEntry>();
    const raw: string = await Store.getString(Store.KEY_REMINDER_MAP);
    if (raw.length === 0) {
      return result;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, Object>;
      const keys: string[] = Object.keys(parsed);
      for (let i = 0; i < keys.length; i++) {
        const eventId: number = Number(keys[i]);
        if (Number.isNaN(eventId)) {
          continue;
        }
        const value: Object = parsed[keys[i]];
        if (typeof value === 'number') {
          // 旧格式（值就是裸的 reminder id，没有触发时刻）：triggerAt 记 0，
          // 于是下一轮同步一律判成「时刻变了」，撤旧排新一次，顺手把账本升级成新格式。
          // 不兜这一下的话旧记录解析不出来就被丢掉，系统里那些提醒再也没人取消，只会越积越多。
          result.set(eventId, { reminderId: value as number, triggerAt: 0 });
        } else {
          const entry: ReminderEntry = value as ReminderEntry;
          result.set(eventId, { reminderId: entry.reminderId, triggerAt: entry.triggerAt });
        }
      }
    } catch (e) {
      return result;
    }
    return result;
  }

  static async saveReminderMap(map: Map<number, ReminderEntry>): Promise<void> {
    const obj: Record<string, ReminderEntry> = {};
    const keys: number[] = Array.from(map.keys());
    for (let i = 0; i < keys.length; i++) {
      obj[keys[i].toString()] = map.get(keys[i]) as ReminderEntry;
    }
    await Store.putString(Store.KEY_REMINDER_MAP, JSON.stringify(obj));
  }
}
