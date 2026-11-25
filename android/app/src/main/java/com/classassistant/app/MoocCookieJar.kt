package com.classassistant.app

import java.net.URLDecoder

/**
 * 中国大学MOOC（icourse163）登录态 Cookie 汇总与判据。
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
     *
     * 注意：注释里不要写出 `/web/j/` 后面紧跟星号的写法 —— Kotlin 块注释可嵌套，
     * 那个字符序列会打开一层新注释，把后面的代码整段吞掉。
     */
    val ORIGINS = listOf(
        "https://www.icourse163.org",
        "https://reg.icourse163.org",
        "https://m.icourse163.org"
    )

    private val HOST_SESSION_NAMES = setOf("JSESSIONID", "route")

    /** 登录后才有的账号 Cookie：形如 `yd.f05f...@163.com|8|1594213656|1795525378529` */
    private const val STUDY_INFO = "STUDY_INFO"

    /** 所有 `/web/j/` 下 rpc 接口的 csrfKey（同样别在这里写星号斜杠） */
    private const val NTESSTUDYSI = "NTESSTUDYSI"

    /** STUDY_INFO 拆出来的身份；比较「是不是同一个人」只认这两个字段 */
    data class Identity(val account: String, val memberId: String) {
        val key: String get() = account + "#" + memberId
        val displayName: String get() = account.ifEmpty { memberId }
    }

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
     * 是否已登录。
     *
     * **不能只看 NTESSTUDYSI**：icourse163 给未登录的访客也会下发一个访客 NTESSTUDYSI
     * （实测打开 /member/login.htm 就 `Set-Cookie: NTESSTUDYSI=...`），只看它会把
     * 「刚打开登录页、什么都没做」当成登录成功，然后把一份访客 Cookie 交给服务端
     * （上游课程列表对访客返回 0 门课、code=0，服务端若不校验身份就会存下一份空账号）。
     * 真正的登录态一定带 STUDY_INFO（账号凭据），所以两个都要有。
     *
     * 不要求 NTESSTUDYSI 之外的会话 Cookie（STUDY_SESS 等）：STUDY_INFO 已经能证明
     * 「这是某个人登录后的会话」，具体是否还有效由服务端读一次课程列表验证
     * （失效回 MOOC_EXPIRED）。
     */
    fun hasLogin(cookie: String?): Boolean =
        cookieValueOf(cookie, NTESSTUDYSI).isNotEmpty() && identityOf(cookie) != null

    /** STUDY_INFO 的原始值；没有就是空串。用于「打开小窗时是否已经登录着」的基线比较。 */
    fun studyInfoOf(cookie: String?): String = cookieValueOf(cookie, STUDY_INFO)

    /**
     * 从 STUDY_INFO 解析账号 / 成员 ID；没有或不完整都返回 null。
     *
     * 值可能被 URL 编码（`%40` 之类），解不开就按原样拆 —— 宁可只展示未解码的账号，
     * 也不要因为一个 Cookie 格式问题让整个登录判据失效。
     */
    fun identityOf(cookie: String?): Identity? {
        val raw = studyInfoOf(cookie)
        if (raw.isEmpty()) return null
        val text = try {
            URLDecoder.decode(raw, "UTF-8")
        } catch (e: Exception) {
            raw
        }.trim().trim('"')
        if (text.isEmpty()) return null
        val parts = text.split('|')
        val account = parts.getOrNull(0)?.trim().orEmpty()
        val memberId = parts.getOrNull(2)?.trim().orEmpty()
        if (account.isEmpty() && memberId.isEmpty()) return null
        return Identity(account, memberId)
    }

    /** 从 Cookie 头里取某个键（纯函数）；取不到回空串 */
    private fun cookieValueOf(cookie: String?, name: String): String {
        if (cookie.isNullOrBlank()) return ""
        for (part in cookie.split(';')) {
            val idx = part.indexOf('=')
            if (idx < 0) continue
            if (part.substring(0, idx).trim() != name) continue
            return part.substring(idx + 1).trim()
        }
        return ""
    }
}
