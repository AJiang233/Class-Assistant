import formProvider from '@ohos.app.form.formProvider';
import formBindingData from '@ohos.app.form.formBindingData';
import common from '@ohos.app.ability.common';
import { Store } from '../data/Store';
import { EventData, formatClock, isSameDay } from '../model/SchoolEvent';

/** 卡片可绑定的数据（扁平字段，ArkTS 卡片通过 LocalStorage 按同名键接收） */
export interface WidgetFormData {
  widgetTitle: string;
  line1: string;
  line2: string;
  line3: string;
  has1: number;
  has2: number;
  has3: number;
  hasEmpty: number;
}

const MAX_ROWS: number = 3;

/**
 * 桌面卡片渲染：数据来自同步任务写入的本地缓存，渲染过程不联网。
 */
export class WidgetUpdater {
  static async buildFormData(context: common.Context): Promise<WidgetFormData> {
    const events: EventData[] = await Store.getEvents();
    const userName: string = await Store.getUserName();
    const rm = context.resourceManager;

    let title: string = rm.getStringSync($r('app.string.widget_title').id);
    if (userName.length > 0) {
      title = rm.getStringSync($r('app.string.widget_title_of').id, userName);
    }

    const lines: string[] = [];
    const now: number = Date.now();
    for (let i = 0; i < events.length; i++) {
      const event: EventData = events[i];
      if (event.start === 0 || !isSameDay(event.start, now)) {
        continue;
      }
      const eventTitle: string = event.title.length > 0 ? event.title : '班级活动';
      lines.push(formatClock(event.start) + '  ' + eventTitle);
      if (lines.length >= MAX_ROWS) {
        break;
      }
    }

    const emptyText: string = rm.getStringSync($r('app.string.widget_empty').id);
    return {
      widgetTitle: title,
      line1: lines.length > 0 ? lines[0] : '',
      line2: lines.length > 1 ? lines[1] : '',
      line3: lines.length > 2 ? lines[2] : '',
      has1: lines.length > 0 ? 1 : 0,
      has2: lines.length > 1 ? 1 : 0,
      has3: lines.length > 2 ? 1 : 0,
      hasEmpty: lines.length === 0 ? 1 : 0,
      // 空态文案固定走资源，卡片端直接渲染自己的文本即可
    } as WidgetFormData;
  }

  /** 同步完成后刷新所有卡片实例 */
  static async refreshAll(context: common.Context): Promise<void> {
    const formIds: string[] = await Store.getFormIds();
    if (formIds.length === 0) {
      return;
    }
    const data: WidgetFormData = await WidgetUpdater.buildFormData(context);
    const formData = formBindingData.createFormBindingData(data);
    for (let i = 0; i < formIds.length; i++) {
      try {
        await formProvider.updateForm(formIds[i], formData);
      } catch (e) {
        // 卡片实例可能已被移除，忽略单个失败
      }
    }
  }

  /** 卡片新增或定时更新时渲染单个实例 */
  static async renderOne(context: common.Context, formId: string): Promise<void> {
    const data: WidgetFormData = await WidgetUpdater.buildFormData(context);
    const formData = formBindingData.createFormBindingData(data);
    try {
      await formProvider.updateForm(formId, formData);
    } catch (e) {
      // 忽略
    }
  }
}
