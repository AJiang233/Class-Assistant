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

  /**
   * 通知 id 基数：每条通知用 NOTICE_ID_BASE + 通知 id，天然去重（同一条重复同步不会叠加）。
   * 必须与活动提醒的 id（直接用活动 id）拉开距离，否则两个列表里 id 相同的记录会互相顶掉。
   * 与安卓端 SyncWorker.NOTICE_ID_BASE 保持同值。
   */
  static readonly NOTICE_ID_BASE: number = 100000;

  /**
   * 通知/提醒带出去的目标页深链参数名。
   * 值必须与安卓端 Notifier.EXTRA_DEEP_LINK 一致 —— 这是跨端契约，
   * 网页靠 ?view=…&id=… 落到对应详情，改这里等于改两端。
   */
  static readonly DEEP_LINK_KEY: string = 'ca_deep_link';

  /** 桥方法 CAHost.platform() 的返回值，网页据此读 version.json 里自己那段 */
  static readonly PLATFORM: string = 'harmony';

  /** workScheduler 后台同步任务 ID */
  static readonly SYNC_WORK_ID: number = 1;
  /** 后台同步间隔（分钟，workScheduler 周期下限为 30 分钟） */
  static readonly SYNC_INTERVAL_MINUTES: number = 60;

  static readonly BUNDLE_NAME: string = 'com.classassistant.app';

  /** 通知 / 提醒点击后要拉起的宿主（wantAgent 的目标，须与 module.json5 里的名字一致） */
  static readonly ENTRY_MODULE: string = 'entry';
  static readonly ENTRY_ABILITY: string = 'EntryAbility';
}

/** 页面与 JS 桥之间通过 emitter 传递的事件 ID */
export class BridgeEvents {
  static readonly PULL_READY: number = 1001;
  static readonly TOKEN: number = 1002;
  static readonly ACADEMIC_START: number = 1003;
  static readonly THEME: number = 1004;
  /** 已在运行时点通知进来（对应安卓端 MainActivity.onNewIntent） */
  static readonly DEEP_LINK: number = 1005;
}
