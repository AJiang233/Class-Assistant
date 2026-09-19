package com.classassistant.app.widget

import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import com.classassistant.app.R
import com.classassistant.app.data.Store
import com.classassistant.app.sync.formatClock
import com.classassistant.app.sync.formatDayClock
import com.classassistant.app.sync.isEventActiveOnDay
import com.classassistant.app.sync.isSameDay
import org.json.JSONObject

/**
 * 今日活动小组件的活动列表：集合组件的数据源。
 *
 * 与课表那边（[CoursesWidgetService]）是同一套路子：RemoteViews 里没有 ScrollView，
 * 想让内容滚起来只有集合组件这一条路。卡片布局也共用 widget_card_item.xml
 * （三行文字 + 左侧彩条 + 同色浅底），所以两块组件长得一模一样。
 *
 * 清单里**必须**声明本服务并带 BIND_REMOTEVIEWS 权限，漏了列表会永远是空的、且不报任何错。
 */
class EventsWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        EventsWidgetFactory(applicationContext)
}

/**
 * 列表的数据与每一行。数据在 [onDataSetChanged] 里现算：跨天刷新
 * （provider 里的 notifyAppWidgetViewDataChanged）与平台重新绑定都会走到这里，
 * 所以列表会跟着 provider 一起换到新的那一天。
 *
 * 读的是本机缓存（与 provider 同一份 Store.events），不联网。
 */
private class EventsWidgetFactory(private val context: Context) :
    RemoteViewsService.RemoteViewsFactory {

    private var events: List<JSONObject> = emptyList()

    override fun onCreate() = Unit

    override fun onDataSetChanged() {
        val now = System.currentTimeMillis()
        val raw = Store.events(context)
        // 哪些活动算「在办」：与**网页主页同一口径** —— 后端 /api/activities 默认 scope=active
        // 是按天过滤的（start_day <= 今天 <= end_day），所以昨天开始、今天还没结束的活动今天照样在列，
        // 单天的活动在结束那天也还在（口径全文见 Event.isEventActiveOnDay）。
        //
        // 缓存里保留了当天已经开始的（甚至已结束的）活动，直接按升序列会被它们占满，
        // 把真正要看的那条挤到下面；所以先把「现在及以后」排在前面，再补当天更早的。
        // 缓存按开始时间升序，两个列表各自都有序。
        val upcoming = ArrayList<JSONObject>()
        val earlier = ArrayList<JSONObject>()
        for (i in 0 until raw.length()) {
            val row = raw.optJSONObject(i) ?: continue
            val start = row.optLong("start", 0L)
            if (start == 0L) continue
            // 缓存里「有 end 这个键」才算有结束时间，取不到就是 0（见 SyncRunner 的落库处）
            val end = row.optLong("end", 0L).takeIf { it > 0L }
            if (!isEventActiveOnDay(start, end, now)) continue
            (if (start >= now) upcoming else earlier).add(row)
        }
        events = upcoming + earlier
    }

    override fun onDestroy() {
        events = emptyList()
    }

    override fun getCount(): Int = events.size

    override fun getViewAt(position: Int): RemoteViews? {
        val row = events.getOrNull(position) ?: return null
        val now = System.currentTimeMillis()
        val views = RemoteViews(context.packageName, R.layout.widget_card_item)

        val title = row.optString("title").ifBlank { "班级活动" }
        val place = row.optString("location")
        val start = row.optLong("start", 0L)

        // 卡里从上到下三行：开始时间 / 活动名 / 地点
        // 跨天的活动（昨天开始、今天还在办）要带上日期，否则「08:00」会被当成今天 08:00，
        // 而它其实昨天就开始了 —— 按天过滤之后这一种才会出现在列表里。
        // 活动卡**不画进度条**：一场活动不是「上到几成」那种东西，卡片也放不下；
        // widget_card_item 的进度条默认就是 gone，这里不用管。
        views.setTextViewText(
            R.id.card_item_time,
            if (isSameDay(start, now)) formatClock(start) else formatDayClock(start)
        )
        views.setTextViewText(R.id.card_item_title, title)
        views.setTextViewText(R.id.card_item_place, place)
        // 地点可能是空的（不是每场活动都填了地点）：藏掉那一行，而不是留一条空行 ——
        // 空行只会把卡片撑高，什么都没多说
        views.setViewVisibility(
            R.id.card_item_place,
            if (place.isBlank()) View.GONE else View.VISIBLE
        )
        // 竖条颜色只能这样设：RemoteViews 没有「换背景色」的专有方法（setColorInt /
        // setColorStateList 都是 API 31+，而 minSdk 是 24），反射调 setBackgroundColor
        // 是各版本都通用的写法。代价是它只认纯色 —— 竖条没有圆角，靠 item 里给它的
        // 上下 margin 让开卡片圆角（见 widget_card_item.xml）。
        views.setInt(R.id.card_item_bar, "setBackgroundColor", barColor(title))
        // 卡片底色 = 上面那条竖条颜色的浅色版（同一份取色，两者永远配对），
        // 用 setImageViewResource 换整块 shape 资源 —— 为什么非得走这一层 ImageView，
        // 见 WidgetCard.kt
        views.setImageViewResource(R.id.card_item_bg, cardBgRes(title))

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
