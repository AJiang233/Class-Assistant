package com.classassistant.app

/**
 * 中国大学MOOC（icourse163）登录态 Cookie 汇总。
 *
 * 登录页 https://www.icourse163.org/member/login.htm 只是外壳，表单跑在跨域的
 * https://reg.icourse163.org 内嵌页里（urs 登录）。两个域都会落 Cookie：
 * reg 那一侧可能有 host-only 的临时凭据，www 这一侧才有真正给 `.rpc` 接口用的
 * NTESSTUDYSI / STUDY_INFO / STUDY_SESS。
 *
 * 这里按来源优先级把多个子域的 Cookie 按 name 去重合并，先出现的为准；主域放第一位，
 * 保证 NTESSTUDYSI 拿到的是 www 那份。`JSESSIONID` / `route` 是主机级会话 ID，
 * 不能跨子域搬，只保留第一个来源里的。纯函数，便于单测。
 */
internal object MoocCookieJar {

    /**
     * Cookie 来源，按优先级排列。
     *
     * www 必须在第一位：服务端只向 www.icourse163.org 发 `.rpc` 请求，csrfKey 取的就是
     * 这一域上的 NTESSTUDYSI。reg 补登录链路上 host-only 的临时 Cookie；
     * m 是移动站，扫码登录时可能落在那里。
     */
    val ORIGINS = listOf(
        "https://www.icourse163.org",
        "https://reg.icourse163.org",
        "https://m.icourse163.org"
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

    /**
     * 有 `NTESSTUDYSI` 才算登录成功。
     *
     * 它是所有 `/web/j/` 下 `*.rpc` 的 csrfKey，服务端没它就一个请求都发不出去
     * （见私有仓 moocApi.js 的 csrfKeyOf / MoocSessionExpired）。登录态是否真的有效
     * 不在这里猜 —— 绑定接口会先读一次课程列表验证，失败回 MOOC_EXPIRED。
     *
     * 不要求 STUDY_INFO：它只用于展示账号名，个别账号可能没有；缺了也照样能读课程。
     */
    fun hasLogin(cookie: String?): Boolean =
        !cookie.isNullOrBlank() && cookie.contains("NTESSTUDYSI=")
}
