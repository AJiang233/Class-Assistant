import FormExtensionAbility from '@ohos.app.form.FormExtensionAbility';
import formBindingData from '@ohos.app.form.formBindingData';
import formInfo from '@ohos.app.form.formInfo';
import Want from '@ohos.app.ability.Want';
import { Store } from '../data/Store';
import { WidgetUpdater } from './WidgetUpdater';
import { SyncService } from '../sync/SyncService';

/**
 * 桌面卡片的生命周期宿主：卡片添加/移除/定时更新时维护实例集合并渲染内容。
 */
export default class EntryFormAbility extends FormExtensionAbility {
  onAddForm(want: Want): formBindingData.FormBindingData {
    const params: Record<string, Object> =
      want.parameters !== undefined ? want.parameters : {};
    const formId: string = params[formInfo.FormParam.IDENTITY_KEY] as string;

    Store.init(this.context).then((): void => {
      Store.addFormId(formId).then((): void => {
        WidgetUpdater.renderOne(this.context, formId);
      });
    });

    // 先返回空数据，随后通过 updateForm 推送真实内容
    return formBindingData.createFormBindingData({});
  }

  onCastToNormalForm(formId: string): void {
    Store.init(this.context).then((): void => {
      WidgetUpdater.renderOne(this.context, formId);
    });
  }

  onUpdateForm(formId: string): void {
    Store.init(this.context).then((): void => {
      WidgetUpdater.renderOne(this.context, formId);
    });
  }

  onRemoveForm(formId: string): void {
    Store.init(this.context).then((): void => {
      Store.removeFormId(formId);
    });
  }

  onFormEvent(formId: string, message: string): void {
    // 预留：卡片消息事件（如手动刷新）
    if (message === 'sync') {
      Store.init(this.context).then((): void => {
        SyncService.run(this.context);
      });
    }
  }
}
