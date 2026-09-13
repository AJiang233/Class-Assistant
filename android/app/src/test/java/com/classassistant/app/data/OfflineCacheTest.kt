package com.classassistant.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 离线缓存的淘汰规则。
 *
 * 只测「该删哪些」这个决策，不碰文件系统（那部分要 Context，属于真机的事）。
 * 值得单独钉住的是**离线壳永不淘汰**：一旦坏掉，用户看到的是「断网时 App 打不开」——
 * 一个和缓存淘汰八竿子打不着的现象，很难在现场倒推回来。
 */
class OfflineCacheTest {

    private fun f(name: String, at: Long) = name to at

    @Test
    fun `没超上限时什么都不删`() {
        val files = listOf(f("S_shell.json", 1), f("L_list.json", 2), f("X_snap.json", 3))
        assertTrue(OfflineCache.evictionPlan(files, max = 5).isEmpty())
    }

    @Test
    fun `超上限时先删快照，再删列表，离线壳一条都不动`() {
        // 5 条、上限 3：要删 2 条。可删的只有快照与列表，且快照优先、各自最旧的先走
        val files = listOf(
            f("S_shell.json", 10),
            f("L_list.json", 20),
            f("X_old.json", 1),
            f("X_mid.json", 2),
            f("X_new.json", 3)
        )
        assertEquals(listOf("X_old.json", "X_mid.json"), OfflineCache.evictionPlan(files, max = 3))
    }

    @Test
    fun `快照删光了才动列表`() {
        val files = listOf(
            f("S_shell.json", 99),
            f("L_new.json", 30),
            f("L_old.json", 10),
            f("X_a.json", 1)
        )
        assertEquals(listOf("X_a.json", "L_old.json"), OfflineCache.evictionPlan(files, max = 2))
    }

    /** 上限再怎么小，也不能为了「凑够数」把壳删了 —— 宁可超过上限 */
    @Test
    fun `只剩离线壳时宁愿超上限也不删它`() {
        val files = listOf(f("S_a.json", 1), f("S_b.json", 2), f("S_c.json", 3))
        assertTrue(OfflineCache.evictionPlan(files, max = 1).isEmpty())
    }
}
