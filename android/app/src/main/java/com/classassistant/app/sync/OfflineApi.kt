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
 * 原生离线层。WebView 里每个请求都会先经过这里（MainActivity 的 shouldInterceptRequest），管两件事：
 *
 *   接口 /api/…    在线自己拉一份（用本机 token）、成功顺手更新缓存；断网或连不上时回放缓存
 *   页面与静态资源  同样是「在线回源 + 顺手存一份，断网回放」—— 也就是离线壳
 *   写操作         一律不接管：POST / PUT / DELETE 断网就该失败，绝不能假装成功
 *
 * 为什么不靠网页自己的 Service Worker 兜住页面：sw.js 本身写得没问题，但真机上冷启动离线时
 * 它没接管 iframe 的导航（不重启 App 时页面已渲染，所以看不出问题；一杀进程重开就暴露成
 * 「除了主页都打不开」）。离线壳做在原生层，逻辑由我们掌握；两者并不冲突 ——
 * SW 能接管时请求根本到不了这里。
 *
 * 为什么自己发请求，而不是「放行 WebView 再把它的响应存下来」：shouldInterceptRequest 只能给响应、
 * 看不到 WebView 自己请求的结果；而依赖 request.getRequestHeaders() 里的 Authorization 又是在赌
 * WebView 会不会把脚本设的头透出来。本机 token 由页面探针同步过来（Store.token），用它最稳。
 */
object OfflineApi {

    private val HOST = Api.BASE.removePrefix("https://")

    /**
     * 离线壳清单：页面与静态资源。与 sw.js 的 PRECACHE 保持同一份，改一边记得改另一边。
     *
     * 这些路径**不依赖登录态**，所以没 token 时照样缓存与回放 ——
     * 否则「没登录 + 断网」会连登录页都打不开，那就彻底进不去了。
     */
    private val SHELL_PATHS = setOf(
        "/", "/index.html", "/notices.html", "/activities.html", "/academic.html",
        "/forms.html", "/admin.html", "/account.html",
        "/assets/css/style.css", "/assets/js/app.js", "/manifest.json"
    )

    /** 内置离线提示页，只在「断网 + 该页面从没缓存过」时出现（见 shell 的注释） */
    private val OFFLINE_PAGE = """
        <!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
        <title>离线</title><style>
        body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
        background:#F2F2F7;color:#1c1c1e;font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
        .box{max-width:19em;padding:0 24px;text-align:center}
        h1{font-size:1.05rem;margin:0 0 8px}
        p{color:#6b6b75;margin:0 0 18px;font-size:.9rem}
        button{font:inherit;padding:10px 22px;border:0;border-radius:999px;background:#4F46E5;color:#fff}
        </style></head><body><div class="box">
        <h1>当前没有网络</h1>
        <p>这个页面还没有离线缓存。连上网打开一次，之后断网也能看。</p>
        <button onclick="location.reload()">重试</button>
        </div></body></html>
    """.trimIndent()

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

    /** 是否可以写入缓存（接口部分） */
    fun isCacheablePath(path: String): Boolean = CACHE_PATHS.any { it.matches(path) }

    /**
     * 入口。返回 null = 不接管，交给 WebView 原样请求（这是绝大多数请求的情况）。
     * 注意本方法在非 UI 线程被调用，同步做网络 I/O 是允许的。
     */
    fun intercept(context: Context, request: WebResourceRequest): WebResourceResponse? {
        if (request.method != "GET") return null

        val url = request.url
        if (url.host != HOST || url.scheme != "https") return null
        // 站点根请求的 path 可能是空串（App 起的地址是 "https://host"，没有结尾斜杠）：
        // 按 "/" 算 —— 否则离线冷启动的第一跳就不在壳清单里，直接白屏。
        // 服务端会把它 301 到 "/"，缓存键也就该落在 "/" 上
        val path = url.path?.takeIf { it.isNotEmpty() } ?: "/"
        val key = if (url.query.isNullOrEmpty()) path else "$path?${url.query}"

        // 离线壳：页面与静态资源，不需要 token
        if (SHELL_PATHS.contains(path)) return shell(context, request, url.toString(), path, key)

        val cacheable = isCacheablePath(path)
        val detailSource = DETAIL_PATHS.firstOrNull { it.first.matches(path) }
        if (!cacheable && detailSource == null) return null

        // 断网：直接回放缓存，**不看 token** —— 读的是本机已经存下的那份数据，
        // 登录态在不在都不影响（退出登录时缓存会一起清掉，见 SyncWorker.logOutSession）。
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

    /**
     * 离线壳：页面与静态资源。规则跟接口一样是「网络优先、失败回退缓存」，两点不同：
     *   1. 不需要 token —— 登录页本身也得能离线打开
     *   2. 连缓存都没有时，给一个内置的提示页。否则 WebView 会甩出它默认的错误页
     *      （一屏英文 +「找不到页面」），用户既分不清是「没网」还是「应用坏了」，也没有重试入口。
     *      只有「打开页面」的请求才给提示页 —— 缺一个图标 / 脚本时塞 HTML 只会更乱。
     */
    private fun shell(
        context: Context,
        request: WebResourceRequest,
        url: String,
        path: String,
        key: String
    ): WebResourceResponse? {
        if (isOnline(context)) {
            when (val fetched = fetch(url, token = null, expectJson = false)) {
                is Fetched.Ok -> {
                    OfflineCache.write(context, key, fetched.text, OfflineCache.Shape.SHELL)
                    return response(fetched.text, mime = mimeOf(path))
                }
                is Fetched.Http -> return fetched.text?.let { response(it, fetched.code, mimeOf(path)) }
                Fetched.Down -> { /* 落到下面的缓存回退 */ }
            }
        }

        OfflineCache.read(context, key)?.let { return response(it, mime = mimeOf(path)) }

        val wantsHtml = request.isForMainFrame ||
            path == "/" || path.endsWith(".html") ||
            request.requestHeaders?.get("Accept")?.contains("text/html") == true
        return if (wantsHtml) response(OFFLINE_PAGE, mime = "text/html") else null
    }

    /** 按扩展名给 MIME。页面与静态资源都要带着正确的类型回去，否则 CSS 会被当成纯文本 */
    private fun mimeOf(path: String): String = when {
        path.endsWith(".css") -> "text/css"
        path.endsWith(".js") -> "text/javascript"
        path.endsWith(".json") -> "application/json"
        path.endsWith(".png") -> "image/png"
        path.endsWith(".svg") -> "image/svg+xml"
        else -> "text/html"
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

    private fun response(body: String, code: Int = 200, mime: String = "application/json") = WebResourceResponse(
        mime,
        "utf-8",
        code,
        if (code in 200..299) "OK" else "Error",
        // 接口那份绝不进任何缓存；页面与静态资源没必要再禁一层
        if (mime == "application/json") mapOf("Cache-Control" to "no-store") else emptyMap(),
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
     * expectJson 区分两类响应：
     *   接口   —— 2xx 还要 success:true 才算成功（后端有 200 + success:false 的错法，那种只透传）
     *   页面资源 —— 2xx 有正文就算成功。不区分的话 HTML 会被当成「解析不出 JSON」而拒之门外，
     *              于是离线壳永远存不下东西。
     */
    private fun fetch(url: String, token: String?, expectJson: Boolean = true): Fetched = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 8000
            conn.readTimeout = 15000
            if (token != null) conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "*/*")

            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }
            if (code !in 200..299 || text.isNullOrBlank()) {
                Fetched.Http(code, text)
            } else if (!expectJson) {
                Fetched.Ok(text)
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
