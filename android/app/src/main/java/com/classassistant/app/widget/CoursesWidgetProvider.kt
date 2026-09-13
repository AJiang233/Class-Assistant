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
import com.classassistant.app.notify.Notifier
import com.classassistant.app.sync.Course
import com.classassistant.app.sync.CourseBoardKind
import com.classassistant.app.sync.courseEndAt
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

        private const val MAX_ROWS = 4

        /** 点组件打开课表页用的 requestCode。必须区别于今日活动组件的 0，理由见 render() 里的注释 */
        private const val REQUEST_OPEN_ACADEMIC = 1

        private val ROW_IDS = intArrayOf(
            R.id.courses_row_1,
            R.id.courses_row_2,
            R.id.courses_row_3,
            R.id.courses_row_4
        )

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
            // 「显示哪一天」全部交给 decideBoard（纯函数，有单测覆盖），这里只负责挑文案与画出来
            val board = decideBoard(parseTimetableJson(Store.timetableJson(context)), now)

            var emptyText = ""
            val title = when (board.kind) {
                CourseBoardKind.TODAY -> context.getString(R.string.courses_widget_title)
                CourseBoardKind.TOMORROW -> context.getString(R.string.courses_widget_title_tomorrow)
                CourseBoardKind.LATER -> context.getString(
                    R.string.courses_widget_title_day,
                    "${weekdayName(context, weekdayOf(board.dayStart))} ${formatMonthDay(board.dayStart)}"
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

            val shown = board.courses.take(MAX_ROWS)
            for (i in ROW_IDS.indices) {
                val course = shown.getOrNull(i)
                if (course == null) {
                    views.setViewVisibility(ROW_IDS[i], View.GONE)
                    continue
                }
                views.setViewVisibility(ROW_IDS[i], View.VISIBLE)
                views.setTextViewText(ROW_IDS[i], rowText(course))
                // 今天这屏里已经上完的课变灰：一眼能看出「还剩哪几节」
                val end = courseEndAt(board.dayStart, course)
                val done = end != null && end <= now
                views.setTextColor(
                    ROW_IDS[i],
                    context.getColor(if (done) R.color.widget_row_text_done else R.color.widget_row_text)
                )
            }

            views.setViewVisibility(
                R.id.courses_widget_empty,
                if (shown.isEmpty() && emptyText.isNotEmpty()) View.VISIBLE else View.GONE
            )
            if (emptyText.isNotEmpty()) views.setTextViewText(R.id.courses_widget_empty, emptyText)

            // 点整块进课表页：复用与提醒通知同一条深链（MainActivity.initialUrl 会拼到站点地址后面）。
            // requestCode **不能**和今日活动组件用同一个（那边是 0）：PendingIntent 判定相等只看
            // action / data / type / class，**不看 extras** —— 两个组件都是「打开 MainActivity」，
            // 于是会被当成同一个 PendingIntent，谁后渲染谁的 extras 生效，点今日活动会跳到课表页。
            val pending = PendingIntent.getActivity(
                context,
                REQUEST_OPEN_ACADEMIC,
                Intent(context, MainActivity::class.java).apply {
                    putExtra(Notifier.EXTRA_DEEP_LINK, "?view=academic")
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.courses_widget_root, pending)
            manager.updateAppWidget(widgetId, views)
        }

        /** 一行：`09:50  高等数学A · 公共教学楼A102`。教室在最后，被截断时先丢它 */
        private fun rowText(course: Course): String {
            val head = "${course.start}  ${course.name}"
            return if (course.room.isBlank()) head else "$head · ${course.room}"
        }
    }
}
