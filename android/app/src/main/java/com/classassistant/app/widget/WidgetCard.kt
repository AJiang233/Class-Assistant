package com.classassistant.app.widget

/**
 * 课表与今日活动两张卡片共用的那一小块：左侧彩色竖条的调色板与取色算法。
 *
 * 按**名字**（课名 / 活动名）取色，不是按列表位置：同一个名字无论哪天、哪个时段都是同一个
 * 颜色，「周三那门是绿的」这种记忆才立得住 —— 按位置取的话，多一节少一节就串色了。
 *
 * 颜色写成字面量而不是进 colors.xml：这里只有代码用得到、布局不引用它，与 colors.xml 里
 * 「代码和布局都要用的才必须做成资源」是同一个口径。六个色都压在中低饱和，浅靛蓝卡底上不刺眼。
 */
internal val CARD_BAR_COLORS = intArrayOf(
    0xFF4F46E5.toInt(),   // 靛蓝，与主题 accent 同色
    0xFF0EA5E9.toInt(),   // 天蓝
    0xFF10B981.toInt(),   // 翠绿
    0xFFF59E0B.toInt(),   // 琥珀
    0xFFEC4899.toInt(),   // 玫红
    0xFF8B5CF6.toInt()    // 紫
)

/** 取名字哈希的低位来选色。`and Int.MAX_VALUE` 是为了抹掉符号位 —— 直接用 % 的话，
 *  负哈希会算出负下标，越界崩在渲染列表的那一刹那（而且只对部分名字复现） */
internal fun barColor(name: String): Int =
    CARD_BAR_COLORS[(name.hashCode() and Int.MAX_VALUE) % CARD_BAR_COLORS.size]
