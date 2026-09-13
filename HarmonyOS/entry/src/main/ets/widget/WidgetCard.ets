let storage = new LocalStorage();

/**
 * 桌面卡片「今日活动」：显示当天最多 3 条班级活动。
 * 数据由 EntryFormAbility / 同步任务通过 formProvider.updateForm 推送，
 * 键名与 WidgetFormData 一一对应。
 */
@Entry(storage)
@Component
struct WidgetCard {
  @LocalStorageProp('widgetTitle') widgetTitle: string = '今日活动';
  @LocalStorageProp('line1') line1: string = '';
  @LocalStorageProp('line2') line2: string = '';
  @LocalStorageProp('line3') line3: string = '';
  @LocalStorageProp('has1') has1: number = 0;
  @LocalStorageProp('has2') has2: number = 0;
  @LocalStorageProp('has3') has3: number = 0;
  @LocalStorageProp('hasEmpty') hasEmpty: number = 1;

  build() {
    Column() {
      Row() {
        Text(this.widgetTitle)
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.widget_title_color'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      }
      .width('100%')

      if (this.hasEmpty === 1) {
        Column() {
          Text($r('app.string.widget_empty'))
            .fontSize(14)
            .fontColor($r('app.color.widget_text_color'))
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        Column({ space: 10 }) {
          if (this.has1 === 1) {
            Text(this.line1)
              .fontSize(14)
              .fontColor($r('app.color.widget_text_color'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
          }
          if (this.has2 === 1) {
            Text(this.line2)
              .fontSize(14)
              .fontColor($r('app.color.widget_text_color'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
          }
          if (this.has3 === 1) {
            Text(this.line3)
              .fontSize(14)
              .fontColor($r('app.color.widget_text_color'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
          }
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Start)
      }
    }
    .width('100%')
    .height('100%')
    .padding(16)
    .backgroundColor($r('app.color.widget_background'))
    .borderRadius(20)
    .onClick(() => {
      postCardAction(this, {
        'action': 'router',
        'abilityName': 'EntryAbility',
        'params': {}
      });
    })
  }
}
