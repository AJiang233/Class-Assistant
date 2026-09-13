package com.classassistant.app.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import com.classassistant.app.data.OfflineCache
import com.classassistant.app.data.Store
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * 原生离线层：**只做接口**。WebView 里每个请求都会先经过这里（MainActivity 的 shouldInterceptRequest），
 *
 *   /api/ 的只读请求  在线自己拉一份（用本机 token）、成功顺手更新缓存；断网或连不上时回放缓存
 *   其余              返回 null，交给 WebView 原样走网络 —— 写操作（POST / PUT / DELETE）断网就该失败，
 *                     绝不能假装成功
 *
 * 页面与静态资源**不归这一层管**，它们是网页自己的 Service Worker 兜住的（见 sw.js 的离线壳）。
 * 这一点踩过一次坑：真机上报「断网后除主页都打不开」时，一度以为是这一层没兜住页面，于是照着
 * 做了一套原生离线壳 —— 其实根本走不到，因为页面的导航请求会被 Service Worker 接走，
 * shouldInterceptRequest 压根看不见它们。真正的原因是 sw.js 缓存的响应带着跳转标记、
 * 交不出导航（见 sw.js 的注释）。所以这里只留接口那一半。
 *
 * 为什么自己发请求，而不是「放行 WebView 再把它的响应存下来」：shouldInterceptRequest 只能给响应、
 * 看不到 WebView 自己请求的结果；而依赖 request.getRequestHeaders() 里的 Authorization 又是在赌
 * WebView 会不会把脚本设的头透出来。本机 token 由页面探针同步过来（Store.token），用它最稳。
 */
object OfflineApi {

    /**
     * 诊断标签。真机上报「断网时数据不对 / 页面打不开」时，先 `adb logcat -s CAOffline` 看这些行：
     * 请求有没有到这一层、走了网络/缓存/放行哪一支。这类问题和缓存、Service Worker 接管时机有关，
     * 光看代码猜不出结论。
     */
    private const val TAG = "CAOffline"

    private val HOST = Api.BASE.removePrefix("https://")

    /**
     * 会被写入缓存的接口路径（正则，不含查询串）。挑选标准：只读，且形状有限 ——
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
        val path = url.path ?: ""

        val cacheable = isCacheablePath(path)
        val detailSource = DETAIL_PATHS.firstOrNull { it.first.matches(path) }
        if (!cacheable && detailSource == null) return null

        val key = if (url.query.isNullOrEmpty()) path else "$path?${url.query}"
        // 诊断用一行：真机报「离线数据不对」时，先看请求有没有到这一层、走了哪条分支
        Log.i(TAG, "→ $key 在线=${isOnline(context)}")

        // 断网：直接回放缓存，**不看 token** —— 读的是本机已经存下的那份数据，
        // 登录态在不在都不影响（退出登录时缓存会一起清掉，见 SyncRunner.logOutSession）。
        // 以前这里先要求 token，于是「冷启动 + 断网 + 探针还没把 token 报上来」时会白跑一趟。
        if (!isOnline(context)) return fromCache(context, key, path, detailSource)

        // 在线才需要凭据去取：没有就不接管，让页面自己走网络、按它自己的逻辑报错
        val token = Store.token(context) ?: return null
        return when (val fetched = fetch(url.toString(), token)) {
            is Fetched.Ok -> {
                // 只为「可缓存」的那些路径落盘。单条详情（cacheable=false）不存：
                // 离线时它从缓存的列表里按 id 拼回来，单独存会让文件数随「点开过多少条」一直涨
                if (cacheable) {
                    OfflineCache.write(
                        context,
                        key,
                        fetched.text,
                        if (isListPath(path)) OfflineCache.Shape.LIST else OfflineCache.Shape.OTHER
                    )
                }
                Log.i(TAG, "  取到网络 ${fetched.text.length} 字（落盘=$cacheable）")
                response(fetched.text)
            }
            // 服务端答了（401 / 500 / success:false）：原样交回页面。
            // 这里绝不能退回缓存 —— 那等于把「登录态失效了」「服务端出错了」盖成一份旧数据，
            // 页面既不会提示重新绑定，用户也看不出自己看的是哪天的东西。
            is Fetched.Http -> {
                Log.w(TAG, "  服务端答了 ${fetched.code}，原样透传")
                fetched.text?.let { response(it, fetched.code) }
            }
            // 连不上（超时 / 断网 / DNS 挂了）：这才轮到缓存兜底
            Fetched.Down -> {
                Log.w(TAG, "  连不上，转缓存")
                fromCache(context, key, path, detailSource)
            }
        }
    }

    /** 精确键优先；详情再退一步，从缓存过的列表里按 id 拼回来 */
    private fun fromCache(
        context: Context,
        key: String,
        path: String,
        detailSource: Pair<Regex, String>?
    ): WebResourceResponse? {
        OfflineCache.read(context, key)?.let {
            Log.i(TAG, "  命中缓存（${it.length} 字）")
            return response(it)
        }

        val source = detailSource ?: run {
            Log.w(TAG, "  $key 无缓存，放行给 WebView（断网这一路必然失败）")
            return null
        }
        val id = source.first.matchEntire(path)?.groupValues?.get(1) ?: run {
            Log.w(TAG, "  $key 没能从路径里取出 id，放行给 WebView")
            return null
        }
        return OfflineCache.findItem(context, source.second, id)?.let {
            Log.i(TAG, "  $key 从缓存的列表里按 id 拼回来了")
            response(it)
        } ?: run {
            Log.w(TAG, "  $key 在 ${source.second} 的缓存列表里找不到 id=$id，放行给 WebView")
            null
        }
    }

    private fun response(body: String, code: Int = 200) = WebResourceResponse(
        "application/json",
        "utf-8",
        code,
        if (code in 200..299) "OK" else "Error",
        // 接口那份绝不进任何缓存
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

    /**
     * 取一份接口响应。2xx 之外都算「服务端答了」；
     * 2xx 也还要 success:true —— 后端有些错误是用 200 + success:false 返回的，那种同样只透传。
     */
    private fun fetch(url: String, token: String): Fetched = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 8000
            conn.readTimeout = 15000
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "*/*")

            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }
            if (code !in 200..299 || text.isNullOrBlank()) {
                Fetched.Http(code, text)
            } else {
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
        // 以前这里是静默的：真机上「为什么没走缓存」十有八九就藏在这条异常里（超时？DNS？TLS？）
        Log.w(TAG, "取 $url 失败：${e.javaClass.simpleName} ${e.message}")
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
