package com.classassistant.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 离线缓存的淘汰规则。
 *
 * 只测「该删哪些」这个决策，不碰文件系统（那部分要 Context，属于真机的事）。
 * 淘汰顺序坏了不会报错，只会表现成「离线时少了几条数据」—— 在现场很难倒推，
 * 所以用测试把「快照先走、列表后走」钉住。
 */
class OfflineCacheTest {

    private fun f(name: String, at: Long) = name to at

    @Test
    fun `没超上限时什么都不删`() {
        val files = listOf(f("L_list.json", 2), f("X_snap.json", 3))
        assertTrue(OfflineCache.evictionPlan(files, max = 5).isEmpty())
    }

    @Test
    fun `超上限时先删快照，再删列表`() {
        // 4 条、上限 2：要删 2 条。可删的优先快照，各自最旧的先走
        val files = listOf(
            f("L_list.json", 20),
            f("X_old.json", 1),
            f("X_mid.json", 2),
            f("X_new.json", 3)
        )
        assertEquals(listOf("X_old.json", "X_mid.json"), OfflineCache.evictionPlan(files, max = 2))
    }

    @Test
    fun `快照删光了才动列表`() {
        val files = listOf(
            f("L_new.json", 30),
            f("L_old.json", 10),
            f("X_a.json", 1)
        )
        assertEquals(listOf("X_a.json", "L_old.json"), OfflineCache.evictionPlan(files, max = 1))
    }

    /**
     * 「这份缓存够不够新鲜、能不能先画给用户」。
     *
     * 在线时先把缓存画出来是为了首帧不等网络，但一份好几天的旧数据先糊上去，
     * 用户会以为看到的是最新的 —— 比多等一次网络更糟。这条规则错了不报错、只是偶尔闪一下旧数据，
     * 所以把边界钉住。
     */
    @Test
    fun `年龄在窗口内才算新鲜`() {
        val day = 24 * 60 * 60 * 1000L
        assertTrue(OfflineCache.isFresh(0, day))
        assertTrue(OfflineCache.isFresh(day, day))          // 正好卡在边界上：还算新鲜
        assertTrue(!OfflineCache.isFresh(day + 1, day))
    }

    @Test
    fun `没有这份缓存时一律不算新鲜`() {
        // ageMs 读不到文件时返回 -1，别让它被当成「刚写进来的一瞬间」
        assertTrue(!OfflineCache.isFresh(-1, 24 * 60 * 60 * 1000L))
    }
}
