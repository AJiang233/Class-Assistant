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
  id: number;
  title: string;
  start_time: string;
  location: string;
  remind_people?: string | string[] | null;
}

/** 通知行（只声明同步用到的字段） */
export interface NoticeRow {
  title: string;
  content: string;
  publish_time: string;
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
  /** 发 GET 请求，返回响应文本；网络或状态码异常返回 null */
  private static async getText(path: string, token: string, timeout: number): Promise<string | null> {
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
      if (resp.responseCode < 200 || resp.responseCode > 299) {
        return null;
      }
      const text = resp.result as string;
      return text.length > 0 ? text : null;
    } catch (e) {
      return null;
    } finally {
      req.destroy();
    }
  }

  /** 取 data.list；请求失败返回 null（区分「失败」与「确实没有数据」） */
  static async getActivities(path: string, token: string): Promise<ActivityRow[] | null> {
    const text = await Api.getText(path, token, 15000);
    if (text === null) {
      return null;
    }
    try {
      const root = JSON.parse(text) as ActivityListReply;
      if (root.data === undefined || root.data === null || root.data.list === undefined) {
        return [];
      }
      return root.data.list;
    } catch (e) {
      return null;
    }
  }

  static async getNotices(path: string, token: string): Promise<NoticeRow[] | null> {
    const text = await Api.getText(path, token, 15000);
    if (text === null) {
      return null;
    }
    try {
      const root = JSON.parse(text) as NoticeListReply;
      if (root.data === undefined || root.data === null || root.data.list === undefined) {
        return [];
      }
      return root.data.list;
    } catch (e) {
      return null;
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
