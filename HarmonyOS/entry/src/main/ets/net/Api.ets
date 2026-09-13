import http from '@ohos.net.http';
import util from '@ohos.util';
import { Constants } from '../common/Constants';

/** 后端统一响应体（绑定接口） */
interface ApiReply {
  success: boolean;
  data?: ReplyData;
  error?: string;
}

interface ReplyData {
  list?: ActivityRow[];
}

/** 活动行（只声明同步用到的字段） */
export interface ActivityRow {
  /** 服务端可能不给 id，解析后是 undefined —— 用 SyncService.idOf 归一 */
  id?: number;
  title: string;
  start_time: string;
  location: string;
  remind_people?: string | string[] | null;
}

/** 通知行（只声明同步用到的字段） */
export interface NoticeRow {
  /** 服务端可能不给 id，解析后是 undefined —— 用 SyncService.idOf 归一 */
  id?: number;
  title: string;
  content: string;
  publish_time: string;
  remind_people?: string | string[] | null;
}

/**
 * 待填表单行（只声明同步用到的字段）。对应网页侧的 /api/forms/mine → data.pending。
 * 名字用 Todo 而不是 Form：本端 Form 已经是 ArkTS 桌面卡片（WidgetUpdater / EntryFormAbility），
 * 与班委下发的「表单」是两件事。
 */
export interface TodoRow {
  id?: number;
  title: string;
  /** 下发时刻，与通知的 publish_time 同一口径（服务端本地时间串），用来判「这条提醒过没有」 */
  created_at?: string;
}

/** 列表请求结果：401 重试没意义（要清本地会话），必须与「其它失败」分开 */
export enum ApiStatus {
  OK = 0,
  UNAUTHORIZED = 1,
  FAILED = 2
}

/** 列表接口结果；成功但没有数据是 { OK, [] }，失败是 { FAILED, [] } / { UNAUTHORIZED, [] } */
export interface ListResult<T> {
  status: ApiStatus;
  list: T[];
}

/** 原始响应：状态码归一成 ApiStatus，text 只在 OK 时有效 */
interface RawReply {
  status: ApiStatus;
  text: string;
}

interface ActivityListReply {
  success: boolean;
  data?: ActivityListData;
  error?: string;
}

interface ActivityListData {
  list?: ActivityRow[];
}

interface NoticeListReply {
  success: boolean;
  data?: NoticeListData;
  error?: string;
}

interface NoticeListData {
  list?: NoticeRow[];
}

/** /api/forms/mine 回的是 data.pending / data.editable 两个数组，没有 data.list */
interface TodoListReply {
  success: boolean;
  data?: TodoListData;
  error?: string;
}

interface TodoListData {
  pending?: TodoRow[];
}

export interface UserInfo {
  id: string;
  name: string;
}

interface JwtPayload {
  id?: string;
  name?: string;
}

interface BindBody {
  cookies: string;
}

/**
 * 极简接口客户端：只用到少量 GET/POST，不引第三方网络库。
 * 站点与门户同源，接口都在 https://class.qxwkstudio.top/api 下。
 */
export class Api {
  /** 发 GET 请求：401 单独标出来（token 失效，重试无意义），其余非 2xx 与网络异常都算失败 */
  private static async getRaw(path: string, token: string, timeout: number): Promise<RawReply> {
    const req = http.createHttp();
    try {
      const header: Record<string, string> = {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json'
      };
      const resp = await req.request(Constants.BASE_URL + path, {
        method: http.RequestMethod.GET,
        header: header,
        connectTimeout: timeout,
        readTimeout: timeout,
        expectDataType: http.HttpDataType.STRING
      });
      if (resp.responseCode === 401) {
        return { status: ApiStatus.UNAUTHORIZED, text: '' };
      }
      if (resp.responseCode < 200 || resp.responseCode > 299) {
        return { status: ApiStatus.FAILED, text: '' };
      }
      return { status: ApiStatus.OK, text: resp.result as string };
    } catch (e) {
      return { status: ApiStatus.FAILED, text: '' };
    } finally {
      req.destroy();
    }
  }

  /** 取 data.list；请求失败返回 FAILED（区分「失败」与「确实没有数据」） */
  static async getActivities(path: string, token: string): Promise<ListResult<ActivityRow>> {
    const reply: RawReply = await Api.getRaw(path, token, 15000);
    if (reply.status !== ApiStatus.OK) {
      return { status: reply.status, list: [] };
    }
    try {
      const root = JSON.parse(reply.text) as ActivityListReply;
      if (root.data === undefined || root.data === null || root.data.list === undefined) {
        return { status: ApiStatus.OK, list: [] };
      }
      return { status: ApiStatus.OK, list: root.data.list };
    } catch (e) {
      return { status: ApiStatus.FAILED, list: [] };
    }
  }

  static async getNotices(path: string, token: string): Promise<ListResult<NoticeRow>> {
    const reply: RawReply = await Api.getRaw(path, token, 15000);
    if (reply.status !== ApiStatus.OK) {
      return { status: reply.status, list: [] };
    }
    try {
      const root = JSON.parse(reply.text) as NoticeListReply;
      if (root.data === undefined || root.data === null || root.data.list === undefined) {
        return { status: ApiStatus.OK, list: [] };
      }
      return { status: ApiStatus.OK, list: root.data.list };
    } catch (e) {
      return { status: ApiStatus.FAILED, list: [] };
    }
  }

  /**
   * 取 data.pending（待填表单）；已填可改的 data.editable 不用提醒，不取。
   * 失败/无数据的处理与 getNotices 同一套：请求失败是 FAILED，成功但字段缺失算空列表。
   */
  static async getMyTodos(path: string, token: string): Promise<ListResult<TodoRow>> {
    const reply: RawReply = await Api.getRaw(path, token, 15000);
    if (reply.status !== ApiStatus.OK) {
      return { status: reply.status, list: [] };
    }
    try {
      const root = JSON.parse(reply.text) as TodoListReply;
      if (root.data === undefined || root.data === null || root.data.pending === undefined) {
        return { status: ApiStatus.OK, list: [] };
      }
      return { status: ApiStatus.OK, list: root.data.pending };
    } catch (e) {
      return { status: ApiStatus.FAILED, list: [] };
    }
  }

  /** POST JSON（把教务系统 Cookie 上报后端）；网络异常返回 null，业务失败返回错误体 */
  static async postBind(path: string, token: string, cookies: string): Promise<ApiReply | null> {
    const req = http.createHttp();
    try {
      const header: Record<string, string> = {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json'
      };
      const body: BindBody = { cookies: cookies };
      const resp = await req.request(Constants.BASE_URL + path, {
        method: http.RequestMethod.POST,
        header: header,
        extraData: JSON.stringify(body),
        connectTimeout: 20000,
        readTimeout: 20000,
        expectDataType: http.HttpDataType.STRING
      });
      const text = resp.result as string;
      if (text.length === 0) {
        return null;
      }
      return JSON.parse(text) as ApiReply;
    } catch (e) {
      return null;
    } finally {
      req.destroy();
    }
  }

  /** 从 JWT 载荷里取用户 id / 姓名（服务端已签名，这里只读取用于本地筛选） */
  static decodeUser(token: string): UserInfo | null {
    try {
      const parts: string[] = token.split('.');
      if (parts.length < 2) {
        return null;
      }
      const base64: util.Base64 = new util.Base64();
      const bytes: Uint8Array =
        base64.decodeSync(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
      const text: string = new util.TextDecoder('utf-8').decodeToString(bytes);
      const payload = JSON.parse(text) as JwtPayload;
      const id: string = payload.id !== undefined ? payload.id : '';
      const name: string = payload.name !== undefined ? payload.name : '';
      if (id.length === 0 && name.length === 0) {
        return null;
      }
      return { id: id, name: name };
    } catch (e) {
      return null;
    }
  }

  /**
   * remind_people 存的是被提醒人的姓名/ID（JSON 数组字符串如 ["刘科江"]），
   * 也可能是数组、null，或逗号分隔串。
   */
  static parsePeople(value: string | string[] | null | undefined): string[] {
    if (value === null || value === undefined) {
      return [];
    }
    if (Array.isArray(value)) {
      return value as string[];
    }
    const raw: string = (value as string).trim();
    if (raw.length === 0) {
      return [];
    }
    if (!raw.startsWith('[')) {
      return raw.split(',').map((item: string): string => item.trim())
        .filter((item: string): boolean => item.length > 0);
    }
    try {
      const parsed = JSON.parse(raw) as string[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }
}
