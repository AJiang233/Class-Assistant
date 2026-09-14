package com.classassistant.app.widget

import com.classassistant.app.R

/**
 * 课表与今日活动两张卡片共用的那一小块：左侧彩色竖条的调色板、取色算法，
 * 以及卡片底色（= 该色的浅色版）对应的圆角 shape 资源。
 *
 * 按**名字**（课名 / 活动名）取色，不是按列表位置：同一个名字无论哪天、哪个时段都是同一个
 * 颜色，「周三那门是绿的」这种记忆才立得住 —— 按位置取的话，多一节少一节就串色了。
 *
 * 颜色写成字面量而不是进 colors.xml：这里只有代码用得到、布局不引用它，与 colors.xml 里
 * 「代码和布局都要用的才必须做成资源」是同一个口径。六个色都压在中低饱和，浅底上不刺眼。
 */
internal val CARD_BAR_COLORS = intArrayOf(
    0xFF4F46E5.toInt(),   // 靛蓝，与主题 accent 同色
    0xFF0EA5E9.toInt(),   // 天蓝
    0xFF10B981.toInt(),   // 翠绿
    0xFFF59E0B.toInt(),   // 琥珀
    0xFFEC4899.toInt(),   // 玫红
    0xFF8B5CF6.toInt()    // 紫
)

/**
 * 与 [CARD_BAR_COLORS] **一一对应**的卡片底色资源：同一个色号的浅色版（掺白到 12%）+ 8dp 圆角。
 *
 * 为什么做成 6 个 drawable、而不是在代码里把竖条颜色调浅再铺上去：卡片底要**圆角**，
 * 而 RemoteViews 能改整块背景色的只有 setBackgroundColor（只能铺方角纯色），
 * setColorInt / setColorStateList 又是 API 31+、本应用 minSdk 24 用不上。
 * 于是改成「把底色画在 widget_card_item 第一层那支 ImageView 上、用 setImageViewResource 换资源」
 * —— 这条是各版本都稳的首方接口，圆角跟着 shape 走。
 *
 * 两个数组必须同序同长：下标只在 [paletteIndex] 一处算，改一个忘了改另一个就会串色。
 */
internal val CARD_BG_DRAWABLES = intArrayOf(
    R.drawable.widget_card,        // 靛蓝（同时是布局里那支 ImageView 的默认 src）
    R.drawable.widget_card_sky,    // 天蓝
    R.drawable.widget_card_green,  // 翠绿
    R.drawable.widget_card_amber,  // 琥珀
    R.drawable.widget_card_rose,   // 玫红
    R.drawable.widget_card_violet  // 紫
)

/** 取名字哈希的低位来选色。`and Int.MAX_VALUE` 是为了抹掉符号位 —— 直接用 % 的话，
 *  负哈希会算出负下标，越界崩在渲染列表的那一刹那（而且只对部分名字复现） */
private fun paletteIndex(name: String): Int =
    (name.hashCode() and Int.MAX_VALUE) % CARD_BAR_COLORS.size

/** 左侧竖条的实色 */
internal fun barColor(name: String): Int = CARD_BAR_COLORS[paletteIndex(name)]

/** 卡片底色（竖条颜色的浅色版）。与 [barColor] 同源，两者永远配对 */
internal fun cardBgRes(name: String): Int = CARD_BG_DRAWABLES[paletteIndex(name)]
