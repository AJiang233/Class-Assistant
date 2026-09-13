package com.classassistant.app.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import com.classassistant.app.data.OfflineCache
import com.classassistant.app.data.Store
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * 离线接口回退。WebView 里每个 `/api/` 请求都会先经过这里（MainActivity 的 shouldInterceptRequest），
 * 规则只有三条：
 *
 *   在线   → 自己拉一份（用本机 token），成功就顺手更新缓存，然后把响应交回页面
 *   断网   → 直接给缓存；没有缓存就返回 null，让页面照常报它自己的错
 *   写操作 → 一律不接管：POST / PUT / DELETE 断网就该失败，绝不能假装成功
 *
 * 为什么自己发请求，而不是「放行 WebView 再把它的响应存下来」：shouldInterceptRequest 只能给响应、
 * 看不到 WebView 自己请求的结果；而依赖 request.getRequestHeaders() 里的 Authorization 又是在赌
 * WebView 会不会把脚本设的头透出来。本机 token 由页面探针同步过来（Store.token），用它最稳。
 */
object OfflineApi {

    private val HOST = Api.BASE.removePrefix("https://")

    /**
     * 会被写入缓存的路径（正则，不含查询串）。挑选标准：只读，且形状有限 ——
     * 列表、单份快照、单条表单。查出来的键是「路径 + 查询串」，所以 ?scope=all 与
     * ?scope=all&limit=200 各存一份，互不覆盖。
     */
    private val CACHE_PATHS = listOf(
        Regex("^/api/notices$"),
        Regex("^/api/notices/archive$"),
        Regex("^/api/activities$"),
        Regex("^/api/academic/status$"),
        Regex("^/api/academic/timetable$"),
        Regex("^/api/academic/credits$"),
        Regex("^/api/forms/mine$"),
        Regex("^/api/forms/\\d+$"),
        Regex("^/api/auth/me$")
    )

    /**
     * 列表形状的路径：这些响应会被当作「详情回退」的数据源（见 OfflineCache.findItem）。
     * 详情接口本身不进 CACHE_PATHS —— 单独缓存每条详情会让文件数随「点开过多少条」无限涨。
     */
    private val LIST_PATHS = setOf("/api/notices", "/api/notices/archive", "/api/activities")

    /** 详情路径 → 去哪个列表里按 id 找：捕获组 1 是 id */
    private val DETAIL_PATHS = listOf(
        Regex("^/api/notices/(\\d+)$") to "/api/notices",
        Regex("^/api/activities/(\\d+)$") to "/api/activities"
    )

    /**
     * 当前学期课表。单独提出来是因为它除了进离线缓存，SyncWorker 还要拿它解析成本地课表
     * （课表小组件 + 课程提醒），需要按路径精确比对，不能只靠字符串字面量。
     */
    const val TIMETABLE_PATH = "/api/academic/timetable"

    /**
     * 后台同步顺手预热的 URL。**必须与网页真实请求的 URL 完全一致**（缓存键就是 URL），
     * 否则离线时页面按自己的键来取，取不到这一份。
     * 网页改了参数这里要跟着改 —— 这是「后台同步也写缓存」的代价，换来的是
     * 「用户没打开过那个页面，离线也能看到最新数据」。
     */
    val PREWARM = listOf(
        "/api/notices?scope=all&limit=200",
        "/api/activities?scope=all&limit=200",
        "/api/academic/status",
        TIMETABLE_PATH,
        "/api/academic/credits"
    )

    /** 是否属于列表形状（决定缓存文件前缀，详情回退据此枚举） */
    fun isListPath(path: String): Boolean = LIST_PATHS.contains(path)

    /** 是否可以写入缓存 */
    fun isCacheablePath(path: String): Boolean = CACHE_PATHS.any { it.matches(path) }

    /**
     * 入口。返回 null = 不接管，交给 WebView 原样请求（这是绝大多数请求的情况）。
     * 注意本方法在非 UI 线程被调用，同步做网络 I/O 是允许的。
     */
    fun intercept(context: Context, request: WebResourceRequest): WebResourceResponse? {
        if (request.method != "GET") return null

        val url = request.url
        if (url.host != HOST || url.scheme != "https") return null
        val path = url.path ?: return null

        val cacheable = isCacheablePath(path)
        val detailSource = DETAIL_PATHS.firstOrNull { it.first.matches(path) }
        if (!cacheable && detailSource == null) return null

        // 本机没有登录凭据（还没登录）：让页面自己走网络，别用一份不知道属于谁的缓存顶上
        val token = Store.token(context) ?: return null
        val key = if (url.query.isNullOrEmpty()) path else "$path?${url.query}"

        if (!isOnline(context)) return fromCache(context, key, path, detailSource)

        return when (val fetched = fetch(url.toString(), token)) {
            is Fetched.Ok -> {
                if (cacheable) OfflineCache.write(context, key, fetched.text, listShaped = isListPath(path))
                response(fetched.text)
            }
            // 服务端答了（401 / 500 / success:false）：原样交回页面。
            // 这里绝不能退回缓存 —— 那等于把「登录态失效了」「服务端出错了」盖成一份旧数据，
            // 页面既不会提示重新绑定，用户也看不出自己看的是哪天的东西。
            is Fetched.Http -> fetched.text?.let { response(it, fetched.code) }
            // 连不上（超时 / 断网 / DNS 挂了）：这才轮到缓存兜底
            Fetched.Down -> fromCache(context, key, path, detailSource)
        }
    }

    /** 精确键优先；详情再退一步，从缓存过的列表里按 id 拼回来 */
    private fun fromCache(
        context: Context,
        key: String,
        path: String,
        detailSource: Pair<Regex, String>?
    ): WebResourceResponse? {
        OfflineCache.read(context, key)?.let { return response(it) }

        val source = detailSource ?: return null
        val id = source.first.matchEntire(path)?.groupValues?.get(1) ?: return null
        return OfflineCache.findItem(context, source.second, id)?.let { response(it) }
    }

    private fun response(body: String, code: Int = 200) = WebResourceResponse(
        "application/json",
        "utf-8",
        code,
        if (code in 200..299) "OK" else "Error",
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(body.toByteArray(Charsets.UTF_8))
    )

    /** 自己发请求的三种结局；分开是为了决定「能不能退回缓存」—— 只有 Down 才能 */
    private sealed class Fetched {
        /** 2xx 且 success:true：可以缓存 */
        class Ok(val text: String) : Fetched()

        /** 服务端答了别的（非 2xx，或 2xx 但 success:false）：原样透传，不缓存 */
        class Http(val code: Int, val text: String?) : Fetched()

        /** 压根没连上：超时 / 断网 / DNS 失败 */
        object Down : Fetched()
    }

    private fun fetch(url: String, token: String): Fetched = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 8000
            conn.readTimeout = 15000
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "application/json")

            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }
            if (code !in 200..299 || text.isNullOrBlank()) {
                Fetched.Http(code, text)
            } else {
                // 后端有些错误是 200 + success:false 返回的，那种同样只透传
                val parsed = try {
                    JSONObject(text)
                } catch (e: Exception) {
                    null
                }
                if (parsed?.optBoolean("success") == true) Fetched.Ok(text) else Fetched.Http(code, text)
            }
        } finally {
            conn.disconnect()
        }
    } catch (e: Exception) {
        Fetched.Down
    }

    /**
     * 只把「压根没有网络」当断网（飞行模式 / 没开数据），此时不必去等那 8 秒超时。
     * 不用 NET_CAPABILITY_VALIDATED 判「真的通」：有些网络不报这个标记，
     * 误判成断网就会一直显示旧数据，那比多等一次超时更糟。
     */
    private fun isOnline(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return true
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
