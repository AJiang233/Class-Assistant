import window from '@ohos.window';
import common from '@ohos.app.ability.common';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';

/**
 * 状态栏 / 导航栏图标明暗色跟随页面主题。
 */
export class SystemBar {
  static async apply(context: common.UIAbilityContext, dark: boolean): Promise<void> {
    try {
      const win: window.Window = await window.getLastWindow(context);
      const contentColor: string = dark ? '#FFFFFF' : '#000000';
      await win.setWindowSystemBarProperties({
        statusBarContentColor: contentColor,
        navigationBarContentColor: contentColor
      });
    } catch (e) {
      // 设备不支持时忽略
    }
  }

  static isSystemDark(context: common.UIAbilityContext): boolean {
    const config = context.config;
    if (config === undefined || config === null) {
      return false;
    }
    return config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }
}
