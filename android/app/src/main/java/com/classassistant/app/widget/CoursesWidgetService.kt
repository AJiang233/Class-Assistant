package com.classassistant.app.widget

import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import com.classassistant.app.R
import com.classassistant.app.data.Store
import com.classassistant.app.sync.Course
import com.classassistant.app.sync.courseEndAt
import com.classassistant.app.sync.courseProgress
import com.classassistant.app.sync.decideBoard
import com.classassistant.app.sync.minuteOfDay
import com.classassistant.app.sync.parseTimetableJson

/**
 * 课表小组件的课程列表：集合组件的数据源。
 *
 * 为什么非要有它：RemoteViews 里**没有 ScrollView**，想让内容滚起来只有集合组件这一条路
 * （ListView + 本服务 + 下面的工厂）。好处是行数不再写死 —— 一天几节课就列几行，
 * 桌面格子只露得下两张多也不丢内容，只是要往下滚。
 *
 * 卡片的样子（三行 + 左侧彩条）与今日活动共用，布局是 widget_card_item.xml。
 * 清单里必须声明本服务并带 BIND_REMOTEVIEWS 权限，漏了列表会**永远是空的、且不报错**。
 */
class CoursesWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        CoursesWidgetFactory(applicationContext)
}

/**
 * 列表的数据与每一行。数据在 [onDataSetChanged] 里现算：跨天刷新
 * （provider 里的 notifyAppWidgetViewDataChanged）与平台重新绑定都会走到这里，
 * 所以列表会跟着 provider 一起换到新的那一天。
 *
 * 读的是本机缓存（与 provider 同一份 Store.timetableJson），不联网。
 */
private class CoursesWidgetFactory(private val context: Context) :
    RemoteViewsService.RemoteViewsFactory {

    private var dayStart: Long = System.currentTimeMillis()
    private var courses: List<Course> = emptyList()

    override fun onCreate() = Unit

    override fun onDataSetChanged() {
        val board = decideBoard(
            parseTimetableJson(Store.timetableJson(context)),
            System.currentTimeMillis()
        )
        dayStart = board.dayStart
        courses = board.courses
    }

    override fun onDestroy() {
        courses = emptyList()
    }

    override fun getCount(): Int = courses.size

    override fun getViewAt(position: Int): RemoteViews? {
        val course = courses.getOrNull(position) ?: return null
        val now = System.currentTimeMillis()
        val views = RemoteViews(context.packageName, R.layout.widget_card_item)

        // 卡里从上到下三行：上课时间 / 课程名 / 教室
        views.setTextViewText(R.id.card_item_time, timeSpan(course))
        views.setTextViewText(R.id.card_item_title, course.name)
        views.setTextViewText(R.id.card_item_place, course.room)
        // 教室可能是空的（不是每门课都排了教室）：藏掉那一行，而不是留一条空行 ——
        // 空行只会把卡片撑高，什么都没多说
        views.setViewVisibility(
            R.id.card_item_place,
            if (course.room.isBlank()) View.GONE else View.VISIBLE
        )
        // 竖条颜色只能这样设：RemoteViews 没有「换背景色」的专有方法（setColorInt /
        // setColorStateList 都是 API 31+，而 minSdk 是 24），反射调 setBackgroundColor
        // 是各版本都通用的写法。代价是它只认纯色 —— 竖条没有圆角，靠 item 里给它的
        // 上下 margin 让开卡片圆角（见 widget_card_item.xml）。
        views.setInt(R.id.card_item_bar, "setBackgroundColor", barColor(course.name))

        // 正在上的那一节：进度条铺出「上到哪儿了」，课程名同时换成强调色。
        // 宽度交给 ProgressBar 的 level 去画（RemoteViews 设不了任意宽度），
        // 于是「上到一半」本身就是那条一半深、一半浅的分界线。
        val percent = courseProgress(dayStart, course, now)
        views.setViewVisibility(
            R.id.card_item_progress,
            if (percent != null) View.VISIBLE else View.GONE
        )
        if (percent != null) views.setProgressBar(R.id.card_item_progress, 100, percent, false)

        val end = courseEndAt(dayStart, course)
        views.setTextColor(
            R.id.card_item_title,
            context.getColor(
                when {
                    percent != null -> R.color.accent
                    // 今天这屏里已经上完的课变灰：一眼能看出「还剩哪几节」
                    end != null && end <= now -> R.color.widget_row_text_done
                    else -> R.color.widget_row_text
                }
            )
        )

        // 行点击靠 provider 的 setPendingIntentTemplate，这里只需要声明「这一行可点」：
        // 给一个空的 fillInIntent 就够了 —— 本组件不按行传参，深链整条都在 template 上。
        views.setOnClickFillInIntent(R.id.card_item_root, Intent())
        return views
    }

    override fun getLoadingView(): RemoteViews? = null

    override fun getViewTypeCount(): Int = 1

    override fun getItemId(position: Int): Long = position.toLong()

    override fun hasStableIds(): Boolean = false
}

/**
 * 卡片第一行：`09:50-11:25`。
 *
 * 下课时间后端不保证给（parseTimetable 只校验了 start），拿不到就只写开始时间 ——
 * 少了这个分支，缺 end 的课会在卡片上显示成「09:50-」。
 */
private fun timeSpan(course: Course): String =
    if (minuteOfDay(course.end) == null) course.start else "${course.start}-${course.end}"
