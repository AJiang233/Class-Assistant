package com.classassistant.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import com.classassistant.app.MainActivity
import com.classassistant.app.R
import com.classassistant.app.data.Store
import com.classassistant.app.sync.formatClock
import com.classassistant.app.sync.isSameDay

/**
 * 桌面小组件：显示今天的班级活动。
 * 数据来自 SyncWorker 写入的本地缓存，渲染过程不联网。
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

        private const val MAX_ROWS = 3

        private val ROW_IDS = intArrayOf(R.id.widget_row_1, R.id.widget_row_2, R.id.widget_row_3)

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
            val events = Store.events(context)
            val now = System.currentTimeMillis()
            val today = ArrayList<String>()

            for (i in 0 until events.length()) {
                val row = events.optJSONObject(i) ?: continue
                val start = row.optLong("start", 0L)
                if (start == 0L || !isSameDay(start, now)) continue
                val title = row.optString("title").ifBlank { "班级活动" }
                today.add("${formatClock(start)}  $title")
                if (today.size >= MAX_ROWS) break
            }

            for (i in ROW_IDS.indices) {
                if (i < today.size) {
                    views.setViewVisibility(ROW_IDS[i], View.VISIBLE)
                    views.setTextViewText(ROW_IDS[i], today[i])
                } else {
                    views.setViewVisibility(ROW_IDS[i], View.GONE)
                }
            }
            views.setViewVisibility(R.id.widget_empty, if (today.isEmpty()) View.VISIBLE else View.GONE)

            val name = Store.userName(context)
            views.setTextViewText(
                R.id.widget_title,
                if (name.isNullOrBlank()) context.getString(R.string.widget_title)
                else context.getString(R.string.widget_title_of, name)
            )

            val pending = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widget_root, pending)
            manager.updateAppWidget(widgetId, views)
        }
    }
}
