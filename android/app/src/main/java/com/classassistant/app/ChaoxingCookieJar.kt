package com.classassistant.app

/**
 * 学习通登录态 Cookie 汇总。
 *
 * 登录成功后，`jrose` / `spaceFidEnc` 是 `i.mooc.chaoxing.com` 的 **host-only** Cookie，
 * 不会出现在 `CookieManager.getCookie("https://i.chaoxing.com")` 里。
 * 只把 i.chaoxing.com 的 Cookie 交给后端时：
 *   - 课程列表（mooc2）还能用，所以预览能显示课程数；
 *   - 但个人空间 `i.chaoxing.com/base` 会 302 回登录页，姓名永远读不到。
 * 这里按来源优先级把多个子域的 Cookie 按 name 去重合并，先出现的为准。
 *
 * `JSESSIONID` / `route` 是主机级会话 ID，不能跨子域搬；只保留第一个来源里的。
 * 纯函数，便于单测。
 */
internal object ChaoxingCookieJar {

    /**
     * Cookie 来源，按优先级排列。
     *
     * 第一个必须是 i.chaoxing.com：`_uid` 等域级 Cookie 都在这里；
     * 第二个补 i.mooc 的 jrose / spaceFidEnc。
     */
    val ORIGINS = listOf(
        "https://i.chaoxing.com",
        "https://i.mooc.chaoxing.com"
    )

    private val HOST_SESSION_NAMES = setOf("JSESSIONID", "route")

    /** 把多次 `CookieManager.getCookie()` 的结果合成一个 Cookie 请求头。 */
    fun merge(sources: List<String?>): String {
        val seen = HashSet<String>()
        val out = ArrayList<String>()
        for ((index, source) in sources.withIndex()) {
            for (pair in (source ?: "").split(';')) {
                val item = pair.trim()
                if (item.isEmpty()) continue
                val eq = item.indexOf('=')
                if (eq <= 0) continue
                val name = item.substring(0, eq).trim()
                if (index > 0 && name in HOST_SESSION_NAMES) continue
                if (!seen.add(name)) continue
                out += item
            }
        }
        return out.joinToString("; ")
    }

    /** 有 `_uid` 才算登录成功；失效与否交给后端校验，原生不猜。 */
    fun hasLogin(cookie: String?): Boolean =
        !cookie.isNullOrBlank() && cookie.contains("_uid=")
}
