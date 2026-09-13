package com.classassistant.app.data

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * 离线接口缓存：把接口响应按 URL 存到本地，断网时由 sync/OfflineApi 原样回给 WebView。
 *
 * 为什么放在原生而不是 Service Worker：sw.js 是**刻意**不碰 `/api/` 下任何接口的
 * （数据与登录态必须走网络，拿旧数据糊弄用户比报错更糟），而且同一份前端还要跑在 PC
 * 浏览器上，那边没有「原生已经同步过一份数据」这个前提。离线只在 App 里做，就不动那份约定。
 *
 * 存文件而不是 SharedPreferences：一条 `?scope=all&limit=200` 的通知列表能有几百 KB，
 * 塞进 SharedPreferences 每次读写都会把整个 XML 序列化一遍（Store 里那份 events 是刻意裁小的，不冲突）。
 */
object OfflineCache {

    private const val DIR = "offline-api"

    /**
     * 列表形状的条目单独加前缀，详情回退时只需列这一批文件（见 findItem），
     * 不必把课表、表单这些也读一遍再丢掉。其余前缀见 Shape。
     */
    private const val LIST_PREFIX = "L_"

    /**
     * 条目数上限。缓存键含查询串，`?date=YYYY-MM-DD` 这类会随用户翻日历慢慢堆积，
     * 所以要有个头；正常用到的形状也就十几条。离线壳那十一条不参与淘汰（见 prune）。
     */
    private const val MAX_FILES = 60

    /**
     * 缓存条目的三种形状，决定文件名前缀（读取时三个前缀都试一遍，形状只影响淘汰顺序）：
     *   SHELL  页面与静态资源（离线壳）。**永不淘汰** —— 一共就十一条，而它们是「断网时 App 能不能打开」
     *          的全部依据；和快照混在一起按时间淘汰的话，用户翻日历攒够一屏快照就能把它们挤掉，
     *          那个「杀进程重开后打不开」的问题就会悄悄回来。
     *   LIST   列表接口，详情回退的唯一数据源
     *   OTHER  单份快照（课表、学分、表单、翻日历产生的 ?date=…），最容易把上限顶满，先淘汰它们
     */
    enum class Shape(val prefix: String) {
        SHELL("S_"),
        LIST("L_"),
        OTHER("X_")
    }

    /** 超过这个大小的响应不缓存（正常接口都在几十 KB 量级，超了说明形状不对，别把磁盘当垃圾桶） */
    private const val MAX_BODY_CHARS = 512 * 1024

    private fun dir(context: Context): File = File(context.applicationContext.filesDir, DIR)

    /** 文件名取 key 的 SHA-1：key 里带 `?` `&` `=`，不能直接当文件名 */
    private fun fileFor(context: Context, key: String, shape: Shape): File {
        val digest = MessageDigest.getInstance("SHA-1")
            .digest(key.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return File(dir(context), shape.prefix + digest + ".json")
    }

    private fun bodyOf(file: File): String? = try {
        JSONObject(file.readText()).optString("body").takeIf { it.isNotBlank() }
    } catch (e: Exception) {
        null
    }

    /** 按 URL 精确取一份缓存；没有或文件坏了都返回 null（调用方据此决定是否放行网络） */
    fun read(context: Context, key: String): String? {
        // 同一个 key 只可能落在其中一种前缀下（形状由请求路径决定），三个都试一下最省事
        for (shape in Shape.values()) {
            val f = fileFor(context, key, shape)
            if (f.exists()) return bodyOf(f)
        }
        return null
    }

    fun write(context: Context, key: String, body: String, shape: Shape) {
        if (body.length > MAX_BODY_CHARS) return
        try {
            val d = dir(context)
            if (!d.exists() && !d.mkdirs()) return
            fileFor(context, key, shape)
                .writeText(JSONObject().put("key", key).put("body", body).toString())
            prune(d)
        } catch (e: Exception) {
            // 缓存写失败不该影响这次请求本身：调用方拿到的是网络响应，照常返回
        }
    }

    /**
     * 淘汰决策：超过 max 时该删哪些（返回文件名）。
     * 顺序是先非列表条目、再列表条目（各自最旧的先走），**离线壳一条都不动**。
     *
     * 拎成纯函数是为了能测（见 OfflineCacheTest）：「壳永不淘汰」这条一旦坏掉，
     * 表现是「断网时 App 打不开」而不是某个看得见的报错，只能靠测试钉住。
     */
    internal fun evictionPlan(files: List<Pair<String, Long>>, max: Int): List<String> {
        if (files.size <= max) return emptyList()
        val (lists, others) = files
            .filterNot { it.first.startsWith(Shape.SHELL.prefix) }
            .partition { it.first.startsWith(Shape.LIST.prefix) }
        return (others.sortedBy { it.second } + lists.sortedBy { it.second })
            .take(files.size - max)
            .map { it.first }
    }

    private fun prune(d: File) {
        val all = d.listFiles() ?: return
        evictionPlan(all.map { it.name to it.lastModified() }, MAX_FILES)
            .forEach { File(d, it).delete() }
    }

    /**
     * 单条详情（`/api/notices/123`、`/api/activities/123`）在断网时从缓存的**列表**里按 id 拼回来。
     *
     * 后端列表项与详情返回的是同一行数据（`list` 里的对象直接就是 findById 的结果），
     * 所以按 id 取出来包成 `{success:true,data:…}` 与详情接口的形状完全一致，字段一个不少。
     * 不去单独缓存每条详情：那会让文件数随「点开过多少条」无限增长，
     * 而列表本来就把这些字段都带回来了。
     */
    fun findItem(context: Context, path: String, id: String): String? {
        val files = dir(context).listFiles { _, name -> name.startsWith(LIST_PREFIX) } ?: return null
        for (f in files) {
            val envelope = try {
                JSONObject(f.readText())
            } catch (e: Exception) {
                continue
            }
            // 只在同一类接口的缓存里找：通知列表里不会翻出活动，反之亦然
            val key = envelope.optString("key")
            if (!key.startsWith("$path?") && key != path) continue

            val list = try {
                JSONObject(envelope.optString("body"))
                    .optJSONObject("data")?.optJSONArray("list")
            } catch (e: Exception) {
                null
            } ?: continue

            for (i in 0 until list.length()) {
                val item = list.optJSONObject(i) ?: continue
                if (item.optString("id") == id) {
                    return JSONObject().put("success", true).put("data", item).toString()
                }
            }
        }
        return null
    }

    /**
     * 退出登录时清空。不清的话换账号后能离线翻到上一个账号的通知与课表 ——
     * 与 Store.clearSession 同一个道理，所以调用点也统一放在 SyncWorker.logOutSession。
     */
    fun clear(context: Context) {
        try {
            dir(context).deleteRecursively()
        } catch (e: Exception) {
        }
    }
}
