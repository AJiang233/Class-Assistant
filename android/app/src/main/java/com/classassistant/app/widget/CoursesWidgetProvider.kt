package com.classassistant.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import com.classassistant.app.MainActivity
import com.classassistant.app.R
import com.classassistant.app.data.Store
import com.classassistant.app.notify.Notifier
import com.classassistant.app.sync.CourseBoardKind
import com.classassistant.app.sync.decideBoard
import com.classassistant.app.sync.formatMonthDay
import com.classassistant.app.sync.parseTimetableJson
import com.classassistant.app.sync.weekdayName
import com.classassistant.app.sync.weekdayOf

/**
 * 桌面小组件：课表。
 *
 * 今天还有课（正在进行的那节也算）就显示今天；今天的课都上完了、或者今天根本没课，
 * 就往前找**下一个真有课的日子**显示，并在标题里说明是哪天 —— 周末与单双周没课的日子
 * 会被跳过，否则一到周末这个小组件就是一片空白，等于没有。
 *
 * 数据来自 SyncWorker 写入的本地课表缓存（Store.timetableJson），渲染过程不联网。
 * 刷新时机见 WidgetRefreshReceiver（换天）与 refreshAll（同步成功后）。
 *
 * 课程行本身是**可滚动的集合组件**（Controller 见 CoursesWidgetService）：
 * 一天的课有几节就列几行，不再有「最多显示 4 条」这种写死的上限 —— 桌面格子只有
 * 180dp 高，而一张课卡（三行文字）就有 50 多 dp，固定行数的写法必然裁掉最后几节。
 */
class CoursesWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (id in appWidgetIds) render(context, appWidgetManager, id)
    }

    companion object {

        /** 点组件打开课表页用的 requestCode。必须区别于今日活动组件的 0，理由见 render() 里的注释 */
        private const val REQUEST_OPEN_ACADEMIC = 1

        /** 同步完成、换天、改设置之后刷新所有课表小组件实例 */
        fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(
                ComponentName(context, CoursesWidgetProvider::class.java)
            )
            for (id in ids) render(context, manager, id)
        }

        private fun render(context: Context, manager: AppWidgetManager, widgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.widget_courses)
            val now = System.currentTimeMillis()
            // 「显示哪一天」全部交给 decideBoard（纯函数，有单测覆盖），这里只负责挑文案、写标题
            val board = decideBoard(parseTimetableJson(Store.timetableJson(context)), now)

            val date = formatMonthDay(board.dayStart)
            var emptyText = ""
            val title = when (board.kind) {
                CourseBoardKind.TODAY ->
                    context.getString(R.string.courses_widget_title_today, date)
                CourseBoardKind.TOMORROW ->
                    context.getString(R.string.courses_widget_title_tomorrow, date)
                // 更后面的日子用「周几 + 日期」：只写周几的话，隔一周同一块屏会让
                // 「下周三」和「这周三」长得一模一样
                CourseBoardKind.LATER -> context.getString(
                    R.string.courses_widget_title_day,
                    weekdayName(context, weekdayOf(board.dayStart)),
                    date
                )
                CourseBoardKind.NO_DATA -> {
                    // 没绑教务 / 还没同步到课表：说清是「没有数据」，而不是「今天没课」
                    emptyText = context.getString(R.string.courses_widget_nodata)
                    context.getString(R.string.courses_widget_title)
                }
                CourseBoardKind.NONE -> {
                    emptyText = context.getString(R.string.courses_widget_none)
                    context.getString(R.string.courses_widget_title)
                }
            }
            views.setTextViewText(R.id.courses_widget_title, title)

            // 课程行交给集合组件（数据与每一行见 CoursesWidgetService）：几节课就列几行、装不下可以滚。
            // data 必须每个实例各不相同（toUri 出来的串是唯一的），否则多个小组件会共用同一份列表数据。
            val adapter = Intent(context, CoursesWidgetService::class.java).apply {
                data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            }
            views.setRemoteAdapter(R.id.courses_list, adapter)
            // 点某一行进课表页：列表会把整块的点击吃掉，行点击必须走 template。
            // 行那边只放一个空的 fillInIntent（不需要按行传参，深链整条在 template 上）——
            // 少了它，启动器不认这一行是可点的。
            val open = openAcademic(context)
            views.setPendingIntentTemplate(R.id.courses_list, open)

            val empty = board.courses.isEmpty() && emptyText.isNotEmpty()
            views.setViewVisibility(R.id.courses_list, if (empty) View.GONE else View.VISIBLE)
            views.setViewVisibility(
                R.id.courses_widget_empty,
                if (empty) View.VISIBLE else View.GONE
            )
            if (emptyText.isNotEmpty()) views.setTextViewText(R.id.courses_widget_empty, emptyText)

            // 标题那一圈（列表盖不到的标题与内边距）仍然整块可点
            views.setOnClickPendingIntent(R.id.courses_widget_root, open)
            manager.updateAppWidget(widgetId, views)
            // 标题与空态随上一句换掉了，**列表数据只有这一句能刷新**：不给它，
            // 跨天之后标题已经是新的一天、列表还挂着昨天那一屏。
            manager.notifyAppWidgetViewDataChanged(widgetId, R.id.courses_list)
        }

        /**
         * 点开课表页的深链：复用与提醒通知同一条（MainActivity.initialUrl 会拼到站点地址后面）。
         * requestCode **不能**和今日活动组件用同一个（那边是 0）：PendingIntent 判定相等只看
         * action / data / type / class，**不看 extras** —— 两个组件都是「打开 MainActivity」，
         * 于是会被当成同一个 PendingIntent，谁后渲染谁的 extras 生效，点今日活动会跳到课表页。
         */
        private fun openAcademic(context: Context): PendingIntent = PendingIntent.getActivity(
            context,
            REQUEST_OPEN_ACADEMIC,
            Intent(context, MainActivity::class.java).apply {
                putExtra(Notifier.EXTRA_DEEP_LINK, "?view=academic")
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
