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
import com.classassistant.app.sync.isSameDay

/**
 * 桌面小组件：显示今天的班级活动。
 * 数据来自 SyncWorker 写入的本地缓存，渲染过程不联网。
 *
 * 活动行是**可滚动的集合组件**（数据源见 EventsWidgetService）：今天几场活动就列几行，
 * 不再有「最多显示 3 条」这种写死的上限。卡片结构与课表完全一致（三行文字 + 左侧彩条），
 * 布局共用 widget_card_item.xml。
 */
class TodayWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (id in appWidgetIds) render(context, appWidgetManager, id)
    }

    companion object {

        /**
         * 点组件打开首页用的 requestCode。**不能**和课表组件用同一个（那边是 1）：
         * PendingIntent 判定相等只看 action / data / type / class，两个组件都是
         * 「打开 MainActivity」，撞在一起的话谁后渲染谁的取值生效，点今日活动会跳到课表页。
         */
        private const val REQUEST_OPEN_HOME = 0

        /** 同步完成后刷新所有小组件实例 */
        fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(
                ComponentName(context, TodayWidgetProvider::class.java)
            )
            for (id in ids) render(context, manager, id)
        }

        private fun render(context: Context, manager: AppWidgetManager, widgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.widget_today)

            val name = Store.userName(context)
            views.setTextViewText(
                R.id.widget_title,
                if (name.isNullOrBlank()) context.getString(R.string.widget_title)
                else context.getString(R.string.widget_title_of, name)
            )

            // 活动行交给集合组件（数据与每一行见 EventsWidgetService）：几场就列几行、装不下可以滚。
            // data 必须每个实例各不相同（toUri 出来的串是唯一的），否则多个小组件会共用同一份列表数据。
            val adapter = Intent(context, EventsWidgetService::class.java).apply {
                data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            }
            views.setRemoteAdapter(R.id.widget_list, adapter)
            // 点某一行打开首页：列表会把整块的点击吃掉，行点击必须走 template。
            // 行那边只放一个空的 fillInIntent（不需要按行传参）——少了它，启动器不认这一行是可点的。
            val open = openHome(context)
            views.setPendingIntentTemplate(R.id.widget_list, open)

            val empty = !hasToday(context)
            views.setViewVisibility(R.id.widget_list, if (empty) View.GONE else View.VISIBLE)
            views.setViewVisibility(R.id.widget_empty, if (empty) View.VISIBLE else View.GONE)

            // 标题那一圈（列表盖不到的标题与内边距）仍然整块可点
            views.setOnClickPendingIntent(R.id.widget_root, open)
            manager.updateAppWidget(widgetId, views)
            // 标题与空态随上一句换掉了，**列表数据只有这一句能刷新**：不给它，
            // 跨天之后标题已经是新的状态、列表还挂着昨天那一屏。
            manager.notifyAppWidgetViewDataChanged(widgetId, R.id.widget_list)
        }

        /** 今天有没有活动。只用来决定「显示列表还是空态」，真正的过滤在 EventsWidgetService 里。 */
        private fun hasToday(context: Context): Boolean {
            val now = System.currentTimeMillis()
            val events = Store.events(context)
            for (i in 0 until events.length()) {
                val row = events.optJSONObject(i) ?: continue
                val start = row.optLong("start", 0L)
                if (start != 0L && isSameDay(start, now)) return true
            }
            return false
        }

        private fun openHome(context: Context): PendingIntent = PendingIntent.getActivity(
            context,
            REQUEST_OPEN_HOME,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
