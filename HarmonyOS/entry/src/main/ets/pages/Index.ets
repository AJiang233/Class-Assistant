import web_webview from '@ohos.web.webview';
import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@ohos.base';
import bundleManager from '@ohos.bundle.bundleManager';
import promptAction from '@ohos.promptAction';
import emitter from '@ohos.events.emitter';
import common from '@ohos.app.ability.common';
import notificationManager from '@ohos.notificationManager';
import { Constants, BridgeEvents } from '../common/Constants';
import { DeepLink } from '../common/DeepLink';
import { SystemBar } from '../common/SystemBar';
import { Store } from '../data/Store';
import { Api } from '../net/Api';
import { SyncService } from '../sync/SyncService';
import { Scheduler } from '../sync/Scheduler';
import { PROBE_JS } from './ProbeJs';

interface ReadyData {
  ready: boolean;
}

interface TokenData {
  token: string;
}

interface ThemeData {
  dark: boolean;
}

/** CAHost.appStatus() 回给网页的 JSON 结构，契约见 web/account.html 的 refreshAppStatus() */
interface AppStatus {
  notifications: boolean;
  lastSyncAt: number;
}

/** 从常量地址里取主机名（地址都写死在 Constants 里，不为此引地址解析库） */
function hostOf(origin: string): string {
  return origin.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
}

/**
 * 留在应用内加载的主机（含子域）：门户自己 + 教务系统。从 Constants 派生，避免两处地址漂移。
 * 与安卓端 MainActivity.inAppHosts 是同一份名单 —— 别自作聪明放宽到顶级域：
 * 按后缀截 szjw.njau.edu.cn 得到的是 edu.cn，那样任何 *.edu.cn 都会被当成站内。
 */
const IN_APP_HOSTS: string[] = [hostOf(Constants.START_URL), hostOf(Constants.SCHOOL_ORIGIN)];

/**
 * 页面与网页之间的 JS 桥（CAHost）。
 * 桥方法可能在非 UI 线程被调用，因此只通过 emitter 投递给页面处理，
 * 不直接操作 UI 状态。
 */
class HostBridge {
  /**
   * 当前 WebView 主文档 URL（由页面 onPageBegin 更新）。桥方法据此判断调用方是不是本应用页面。
   * Web 会导航到教务系统这类外部站点，而 javaScriptProxy 挂上的 CAHost 在那些页面里同样可调用 ——
   * 不校验的话，外部页面可以改本地 token、甚至触发教务绑定流程（拿到教务 Cookie 后
   * 上报到当前本地 token 名下）。与安卓端 MainActivity.fromAppPage 同一套判断。
   */
  currentUrl: string = '';

  private fromAppPage(): boolean {
    const url: string = this.currentUrl;
    return url === Constants.START_URL ||
      url.startsWith(Constants.START_URL + '/') ||
      url.startsWith(Constants.START_URL + '?') ||
      url.startsWith(Constants.START_URL + '#');
  }

  setPullRefreshReady(ready: boolean): void {
    if (!this.fromAppPage()) {
      return;
    }
    emitter.emit({ eventId: BridgeEvents.PULL_READY }, { data: { ready: ready } });
  }

  setToken(token: string): void {
    if (!this.fromAppPage()) {
      return;
    }
    emitter.emit({ eventId: BridgeEvents.TOKEN }, { data: { token: token } });
  }

  startAcademicLogin(): void {
    if (!this.fromAppPage()) {
      return;
    }
    emitter.emit({ eventId: BridgeEvents.ACADEMIC_START }, { data: {} });
  }

  setTheme(dark: boolean): void {
    if (!this.fromAppPage()) {
      return;
    }
    emitter.emit({ eventId: BridgeEvents.THEME }, { data: { dark: dark } });
  }

  /** 网页据此读 version.json 里自己那段；没有桥（纯网页版）则不读任何一段 */
  platform(): string {
    if (!this.fromAppPage()) {
      return '';
    }
    return Constants.PLATFORM;
  }

  /** 关于软件卡片显示的 App 版本号，对应安卓端 HostBridge.appVersion（BuildConfig.VERSION_NAME） */
  appVersion(): string {
    if (!this.fromAppPage()) {
      return '';
    }
    try {
      const info: bundleManager.BundleInfo =
        bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      return info.versionName;
    } catch (e) {
      return '';
    }
  }

  /**
   * 个人页「开发功能」那一行状态：本机通知开没开 + 上次同步时间，对应安卓端 HostBridge.appStatus。
   *
   * 返回 JSON 字符串而不是两个布尔/长整型参数 —— 桥的返回值类型在各端解释不完全一致，
   * 字符串最稳，而且一次取回省掉一次桥调用。契约见 web/account.html 的 refreshAppStatus()：
   *   {"notifications":true,"lastSyncAt":1789300000000}
   * lastSyncAt 为 0 表示这台设备一次都没成功同步过（由 SyncService 写入，见 Store.getLastSyncTimeSync）。
   * 通知开关这一项最要紧：关掉后 NoticeService.send 里 publish 的异常被静默吞掉，
   * 个人页再显示「已发送」就是骗人，所以这里如实报出来。
   */
  appStatus(): string {
    if (!this.fromAppPage()) {
      return '';
    }
    let enabled: boolean = false;
    try {
      enabled = notificationManager.isNotificationEnabledSync();
    } catch (e) {
      // 查询本身失败时保守报「未开启」：让用户去系统设置确认，总好过谎报已开启
      enabled = false;
    }
    const status: AppStatus = {
      notifications: enabled,
      lastSyncAt: Store.getLastSyncTimeSync()
    };
    return JSON.stringify(status);
  }

  /**
   * 个人页「推送通知测试」：用最新一条真实活动 / 通知发一条本地通知，让用户自查推送是否可达、
   * 点通知能否跳到对应详情。kind 为 "activity" / "notice"。
   * 桥方法必须同步返回，而拉数据要发网络请求，所以这里只能同步做一件事：本地没 token 时
   * 直接给出提示（这是最常见的失败分支，与安卓端 SyncWorker.pushTestNotification 同一句话）。
   * 其余结果一律返回空串，网页那边显示兜底文案 —— 对比安卓端能同步阻塞拿回完整结果，这是有损的。
   */
  testNotification(kind: string): string {
    if (!this.fromAppPage()) {
      return '';
    }
    if (Store.getTokenSync().length === 0) {
      return '请先登录后再测试推送';
    }
    // 通知权限被关掉时，NoticeService.send 里 publish 的异常会被静默吞掉，
    // 网页那边只能显示「已发送」—— 用户去通知栏找不到东西，只会以为推送坏了。
    // 所以同步查一次权限，把真实原因说出来（与安卓端 SyncWorker.pushTestNotification 同一句话）。
    try {
      if (!notificationManager.isNotificationEnabledSync()) {
        return '通知权限未开启，收不到提醒。请到「系统设置 → 通知」里允许「班级助理」发通知';
      }
    } catch (e) {
      // 查询本身失败就不拦，照常尝试推送
    }
    SyncService.pushTestNotification(kind);
    return '';
  }
}

/**
 * 班级助理 — Web 套壳主页。
 * 加载 https://class.qxwkstudio.top，支持登录态持久化、下拉刷新、返回回退，
 * 登录后触发本地到点提醒（活动/通知）与桌面卡片；
 * 另负责「绑定教务系统」：桌面 UA 打开教务登录页，登录完成后读 Cookie 上报后端。
 */
@Entry
@Component
struct Index {
  private controller: web_webview.WebviewController = new web_webview.WebviewController();
  private host: HostBridge = new HostBridge();
  @State progress: number = 0;
  @State pullReady: boolean = true;
  @State isRefreshing: boolean = false;
  @State userAgent: string = '';
  /** 起始地址：从通知/提醒点进来时是那条详情页，否则是主页 */
  @State startSrc: string = Constants.START_URL;
  private defaultUserAgent: string = '';
  private academicLogin: boolean = false;
  private bindingInProgress: boolean = false;
  private context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;

  aboutToAppear(): void {
    const uiContext: common.UIAbilityContext = this.context;
    SystemBar.apply(uiContext, SystemBar.isSystemDark(uiContext));

    // 冷启动带进来的深链（EntryAbility.onCreate 存的）只取一次，作为首屏地址
    const pending: string = DeepLink.consume();
    if (pending.length > 0) {
      this.startSrc = DeepLink.toUrl(pending);
    }

    emitter.on({ eventId: BridgeEvents.PULL_READY }, (eventData: emitter.EventData): void => {
      const data = eventData.data as ReadyData;
      this.pullReady = data.ready;
    });
    emitter.on({ eventId: BridgeEvents.TOKEN }, (eventData: emitter.EventData): void => {
      const data = eventData.data as TokenData;
      this.handleToken(data.token);
    });
    emitter.on({ eventId: BridgeEvents.ACADEMIC_START }, (): void => {
      this.beginAcademicLogin();
    });
    emitter.on({ eventId: BridgeEvents.THEME }, (eventData: emitter.EventData): void => {
      const data = eventData.data as ThemeData;
      SystemBar.apply(this.context, data.dark);
    });
    emitter.on({ eventId: BridgeEvents.DEEP_LINK }, (): void => {
      this.applyDeepLink();
    });
  }

  aboutToDisappear(): void {
    emitter.off(BridgeEvents.PULL_READY);
    emitter.off(BridgeEvents.TOKEN);
    emitter.off(BridgeEvents.ACADEMIC_START);
    emitter.off(BridgeEvents.THEME);
    emitter.off(BridgeEvents.DEEP_LINK);
  }

  /** App 已在运行时点通知/提醒：跳到对应详情页 */
  private applyDeepLink(): void {
    if (this.academicLogin) {
      // 教务登录中途点通知：不打断登录流程（对应安卓端 onNewIntent 的判断）
      return;
    }
    const deep: string = DeepLink.consume();
    if (deep.length === 0) {
      return;
    }
    this.controller.loadUrl(DeepLink.toUrl(deep));
  }

  /** 网页里的登录 token 变化时保存下来，并触发一次同步 */
  private async handleToken(token: string): Promise<void> {
    if (token.length === 0) {
      // 网页里退出了登录，本地也清掉，避免继续用旧身份提醒
      if ((await Store.getToken()).length > 0) {
        await SyncService.logOutSession(this.context);
      }
      return;
    }
    if (token === await Store.getToken()) {
      return;
    }
    await Store.saveToken(token);
    const me = Api.decodeUser(token);
    if (me !== null) {
      await Store.saveUser(me.id, me.name);
    }
    try {
      await notificationManager.requestEnableNotification(this.context);
    } catch (e) {
      // 用户拒绝通知不影响主流程
    }
    Scheduler.ensurePeriodic();
    // 刚换了登录凭据，这一次必须真拉：不能让它被回前台的 60 秒节流挡掉
    SyncService.run(this.context, true);
  }

  /**
   * 进入教务系统登录：教务对手机 UA 有兼容问题，整个过程固定桌面 UA。
   * 登录成功后由 onPageEnd 触发 Cookie 上报，再回到门户。
   */
  private beginAcademicLogin(): void {
    if (this.academicLogin) {
      return;
    }
    Store.getToken().then((token: string): void => {
      if (token.length === 0) {
        promptAction.showToast({ message: '请先登录班级助理', duration: 3000 });
        return;
      }
      this.academicLogin = true;
      this.bindingInProgress = false;
      this.userAgent = Constants.DESKTOP_UA;
      promptAction.showToast({ message: '请登录教务系统，登录完成后会自动返回', duration: 4000 });
      // UA 属性在下一次加载时生效，稍后再发起跳转
      setTimeout((): void => {
        this.controller.loadUrl(Constants.SCHOOL_ORIGIN);
      }, 50);
    });
  }

  /** 读取教务域下的会话 Cookie（含 HttpOnly），交给后端代拉课表与学分 */
  private uploadAcademicCookies(): void {
    if (this.bindingInProgress) {
      return;
    }
    webview.WebCookieManager.fetchCookie(Constants.SCHOOL_ORIGIN,
      (err: BusinessError, cookies: string): void => {
        if (err) {
          return;
        }
        if (cookies === undefined || cookies === null || cookies.length === 0) {
          return;
        }
        this.bindingInProgress = true;
        this.doBind(cookies);
      });
  }

  private async doBind(cookies: string): Promise<void> {
    const token: string = await Store.getToken();
    if (token.length === 0) {
      this.finishAcademicLogin(false);
      return;
    }
    const reply = await Api.postBind('/api/academic/bind', token, cookies);
    let ok: boolean = false;
    let message: string;
    if (reply === null) {
      message = '网络异常，绑定失败';
    } else if (reply.success === true) {
      ok = true;
      message = '教务系统绑定成功';
    } else {
      message = reply.error !== undefined && reply.error.length > 0 ? reply.error : '绑定失败，请重试';
    }
    promptAction.showToast({ message: message, duration: 3500 });
    this.finishAcademicLogin(ok);
  }

  /** 结束教务登录流程：还原 UA 并回到门户（成功则直接落到课表页） */
  private finishAcademicLogin(success: boolean): void {
    this.academicLogin = false;
    this.bindingInProgress = false;
    this.userAgent = '';
    const target: string = success ? Constants.START_URL + '/?view=academic' : Constants.START_URL;
    setTimeout((): void => {
      this.controller.loadUrl(target);
    }, 50);
  }

  /** 物理返回 / 侧滑返回：教务中途返回 = 放弃绑定；否则网页内回退 */
  onBackPress(): boolean {
    if (this.academicLogin) {
      this.finishAcademicLogin(false);
      return true;
    }
    if (this.controller.accessBackward()) {
      this.controller.backward();
      return true;
    }
    return false;
  }

  private currentRequestUrl(event?: OnPageEndEvent): string {
    if (event === undefined || event === null) {
      return '';
    }
    try {
      return event.url;
    } catch (e) {
      return '';
    }
  }

  /**
   * 拦截系统协议（拨号 / 短信 / 邮件等）：ArkWeb 自己加载不了，直接拦下不加载。
   * 与安卓端 isSystemScheme 同语义 —— 两端一样只是「拦掉」，不代转给系统，行为保持一致。
   */
  private isSystemScheme(url: string): boolean {
    const index: number = url.indexOf(':');
    if (index <= 0) {
      return false;
    }
    const scheme: string = url.substring(0, index).toLowerCase();
    return scheme === 'tel' || scheme === 'sms' || scheme === 'mailto';
  }

  /**
   * 该交给系统浏览器打开的站外链接：http(s)，且不在门户 / 教务域内（含子域）。
   * 对应安卓端 MainActivity.isExternalLink。
   */
  private isExternalLink(url: string): boolean {
    const lower: string = url.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
      return false;
    }
    let host: string = lower.replace(/^https?:\/\//, '');
    const slash: number = host.indexOf('/');
    if (slash >= 0) {
      host = host.substring(0, slash);
    }
    const colon: number = host.indexOf(':');
    if (colon >= 0) {
      host = host.substring(0, colon);
    }
    if (host.length === 0) {
      return false;
    }
    for (let i = 0; i < IN_APP_HOSTS.length; i++) {
      const known: string = IN_APP_HOSTS[i];
      if (host === known || host.endsWith('.' + known)) {
        return false;
      }
    }
    return true;
  }

  /**
   * 站外链接交给系统浏览器；APK 下载也走这里 —— ArkWeb 自己装不了应用。
   * 没有能处理的应用时给句提示，别静默无反应（对应安卓端 openInBrowser）。
   */
  private openInBrowser(url: string): void {
    this.context.startAbility({
      action: 'ohos.want.action.viewData',
      entities: ['entity.system.browsable'],
      uri: url
    }, (err: BusinessError): void => {
      if (err) {
        promptAction.showToast({ message: '没有可以打开该链接的应用', duration: 3000 });
      }
    });
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      Refresh({ refreshing: $$this.isRefreshing, offset: 36 }) {
        Web({ src: this.startSrc, controller: this.controller })
          .width('100%')
          .height('100%')
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .databaseAccess(true)
          .imageAccess(true)
          .mediaPlayGestureAccess(false)
          .userAgent(this.userAgent.length > 0 ? this.userAgent : this.defaultUserAgent)
          .javaScriptProxy({
            object: this.host,
            name: 'CAHost',
            methodList: ['setPullRefreshReady', 'setToken', 'startAcademicLogin', 'setTheme',
              'platform', 'appVersion', 'testNotification'],
            controller: this.controller
          })
          .onControllerAttached(() => {
            try {
              this.defaultUserAgent = this.controller.getUserAgent();
            } catch (e) {
              this.defaultUserAgent = '';
            }
          })
          .onPageBegin((event?: OnPageBeginEvent) => {
            this.isRefreshing = true;
            // 桥的来源校验依赖这个值，必须在本页脚本执行之前更新（只在主 frame 触发）
            if (event !== undefined && event !== null) {
              this.host.currentUrl = event.url;
            }
          })
          .onPageEnd((event?: OnPageEndEvent) => {
            this.isRefreshing = false;
            this.progress = 100;
            const url: string = this.currentRequestUrl(event);
            if (this.academicLogin) {
              // 教务登录流程中：回到教务域即视为登录完成，读取 Cookie 上报；
              // 且不能注入探针——探针在教务页找不到本应用 token 会回传空串清掉登录态
              if (url.startsWith(Constants.SCHOOL_ORIGIN)) {
                this.uploadAcademicCookies();
              }
              return;
            }
            // 安装滚动状态探针（脚本内部幂等，重复注入无副作用）
            this.controller.runJavaScript(PROBE_JS);
          })
          .onProgressChange((event?: OnProgressChangeEvent) => {
            if (event !== undefined && event !== null) {
              this.progress = event.newProgress;
            }
          })
          .onLoadIntercept((event?: OnLoadInterceptEvent): boolean => {
            if (event === undefined || event === null ||
              event.data === undefined || event.data === null) {
              return false;
            }
            try {
              const url: string = event.data.getRequestUrl();
              if (this.isSystemScheme(url)) {
                return true;
              }
              // 只管主框架（子框架里的第三方链接不该被踢到浏览器）；教务登录期间一律不往外跳 ——
              // 认证过程会跨主机，跳走就把登录流程断了。与安卓端 shouldOverrideUrlLoading 同一套判断。
              if (!this.academicLogin && event.data.isMainFrame() && this.isExternalLink(url)) {
                this.openInBrowser(url);
                return true;
              }
              return false;
            } catch (e) {
              return false;
            }
          })
      }
      .onRefreshing(() => {
        // 只有「主页 + 无弹窗 + 已置顶」时才刷新，其余手势交还给页面滚动
        if (!this.pullReady) {
          this.isRefreshing = false;
          return;
        }
        this.controller.refresh();
      })

      if (this.progress > 0 && this.progress < 100) {
        Progress({ value: this.progress, total: 100, type: ProgressType.Linear })
          .width('100%')
          .height(2)
          .color($r('app.color.brand_blue'))
          .backgroundColor(Color.Transparent)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.start_window_background'))
  }
}
