import preferences from '@ohos.data.preferences';
import common from '@ohos.app.ability.common';
import { EventData } from '../model/SchoolEvent';

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

  static async clearSession(): Promise<void> {
    const sp = Store.sp();
    await sp.delete(Store.KEY_TOKEN);
    await sp.delete(Store.KEY_USER_ID);
    await sp.delete(Store.KEY_USER_NAME);
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

  static async getLastSyncAt(): Promise<number> {
    const value = await Store.sp().get(Store.KEY_LAST_SYNC_AT, 0);
    return value as number;
  }

  static async markSynced(): Promise<void> {
    await Store.sp().put(Store.KEY_LAST_SYNC_AT, Date.now());
    await Store.sp().flush();
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

  // ===== 活动 id -> 系统 reminder id 的映射 =====

  static async getReminderMap(): Promise<Map<number, number>> {
    const result: Map<number, number> = new Map<number, number>();
    const raw: string = await Store.getString(Store.KEY_REMINDER_MAP);
    if (raw.length === 0) {
      return result;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      const keys: string[] = Object.keys(parsed);
      for (let i = 0; i < keys.length; i++) {
        const eventId: number = Number(keys[i]);
        if (!Number.isNaN(eventId)) {
          result.set(eventId, parsed[keys[i]]);
        }
      }
    } catch (e) {
      return result;
    }
    return result;
  }

  static async saveReminderMap(map: Map<number, number>): Promise<void> {
    const obj: Record<string, number> = {};
    const keys: number[] = Array.from(map.keys());
    for (let i = 0; i < keys.length; i++) {
      obj[keys[i].toString()] = map.get(keys[i]) as number;
    }
    await Store.putString(Store.KEY_REMINDER_MAP, JSON.stringify(obj));
  }
}
