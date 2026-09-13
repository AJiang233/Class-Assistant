/**
 * 全局常量：站点地址、教务系统、提醒参数、通知与任务 ID。
 */
export class Constants {
  /** 门户站点根地址（接口同源，都在 /api 下） */
  static readonly BASE_URL: string = 'https://class.qxwkstudio.top';
  static readonly START_URL: string = 'https://class.qxwkstudio.top';

  /** 教务系统源（服务端代理与 Cookie 归属域） */
  static readonly SCHOOL_ORIGIN: string = 'https://szjw.njau.edu.cn';

  /** 教务系统对手机 UA 兼容有问题，登录流程统一用桌面 UA */
  static readonly DESKTOP_UA: string =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

  /** 活动开始前 30 分钟提醒 */
  static readonly REMIND_LEAD_MS: number = 30 * 60 * 1000;
  /** 只同步未来 7 天内的活动 */
  static readonly HORIZON_MS: number = 7 * 24 * 60 * 60 * 1000;

  /** 新通知聚合提醒使用的通知 ID */
  static readonly NOTICE_NOTIFICATION_ID: number = 9001;
  /** 活动提醒通知 ID 基数（实际 ID = 基数 + 活动 id） */
  static readonly ACTIVITY_NOTIFICATION_BASE: number = 1000;

  /** workScheduler 后台同步任务 ID */
  static readonly SYNC_WORK_ID: number = 1;
  /** 后台同步间隔（分钟，workScheduler 周期下限为 30 分钟） */
  static readonly SYNC_INTERVAL_MINUTES: number = 60;

  static readonly BUNDLE_NAME: string = 'com.classassistant.app';
}

/** 页面与 JS 桥之间通过 emitter 传递的事件 ID */
export class BridgeEvents {
  static readonly PULL_READY: number = 1001;
  static readonly TOKEN: number = 1002;
  static readonly ACADEMIC_START: number = 1003;
  static readonly THEME: number = 1004;
}
