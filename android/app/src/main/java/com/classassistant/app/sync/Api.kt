package com.classassistant.app.sync

import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * 极简接口客户端：只用到少量 GET/POST，不引第三方网络库。
 * 站点与 App 同源，接口都在 https://class.qxwkstudio.top/api 下。
 */
object Api {

    /** 站点根地址；OfflineApi 也用它来判「这条请求是不是本站接口」，别在两处各写一份 */
    const val BASE = "https://class.qxwkstudio.top"

    /**
     * 诊断标签，与 OfflineApi 的日志对齐。真机上报「后台同步没动静」时先看这一行：
     * 以前这个类失败是**完全静默**的（超时 / DNS / TLS / 5xx 都只回一个 Failed），
     * 现场连「请求有没有发出去」都看不出来。
     * 只记方法、路径与异常类型 —— **绝不记 token 与请求体**（postJson 的 body 是教务 Cookie）。
     */
    private const val TAG = "CAApi"

    /**
     * 请求结果。必须把「登录已失效」和「网络/服务异常」分开：
     * 前者重试多少次都不会成功，调用方应当清掉本地会话并停止重试。
     */
    sealed class Res {
        class Ok(val body: JSONObject) : Res()
        object Unauthorized : Res()
        object Failed : Res()

        /**
         * Ok 时取 data.list；取不到就返回 null，调用方据此判失败并保留旧数据。
         * 真正的「没有数据」是 data.list = []（后端 success({ list: [] })），会正常返回空列表，
         * 不会被误判成失败 —— 只有响应结构不对（连 data.list 都没有）才算失败。
         */
        fun listOrNull(): List<JSONObject>? {
            val root = (this as? Ok)?.body ?: return null
            val arr = root.optJSONObject("data")?.optJSONArray("list") ?: return null
            return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
        }

        /**
         * Ok 时取整个 data 对象。给「不是 data.list 形状」的接口用 ——
         * 比如 /api/forms/mine 回的是 data.pending / data.editable 两个数组。
         * 取不到返回 null，调用方据此判失败。
         */
        fun dataOrNull(): JSONObject? = (this as? Ok)?.body?.optJSONObject("data")
    }

    fun get(path: String, token: String): Res = request("GET", path, token, null)

    /** POST JSON（用于把教务系统 Cookie 上报后端） */
    fun postJson(path: String, token: String, body: JSONObject): Res =
        request("POST", path, token, body)

    private fun request(method: String, path: String, token: String, body: JSONObject?): Res {
        return try {
            val conn = URL(BASE + path).openConnection() as HttpURLConnection
            try {
                conn.requestMethod = method
                conn.connectTimeout = 15000
                conn.readTimeout = 20000
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.setRequestProperty("Accept", "application/json")
                if (body != null) {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                }
                body?.let { payload ->
                    conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
                }

                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val text = stream?.bufferedReader()?.use(BufferedReader::readText)
                val parsed = if (text.isNullOrBlank()) null else try {
                    JSONObject(text)
                } catch (e: Exception) {
                    null
                }
                when {
                    // 401 = 登录态失效，单独上报，避免调用方无限重试
                    code == 401 -> Res.Unauthorized
                    // 其它非 2xx（500/403/…）后端同样会带 JSON body，不能当成 Ok：
                    // 那样会被当成一次「正常但无数据」的响应，调用方拿到空数据就把本地缓存覆盖了 ——
                    // 一次 5xx 就把小组件清成「今日暂无安排」，还会取消所有提醒闹钟
                    code !in 200..299 -> {
                        Log.w(TAG, "$method $path 返回 HTTP $code")
                        Res.Failed
                    }
                    parsed == null -> {
                        Log.w(TAG, "$method $path 的响应不是 JSON（${text?.length ?: 0} 字）")
                        Res.Failed
                    }
                    else -> Res.Ok(parsed)
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            // 超时 / DNS / TLS / 连接被重置都落到这里。以前是静默的，真机上没法区分
            // 「没网」和「服务端挂了」—— 现在至少留下异常类型与一句话。
            Log.w(TAG, "$method $path 请求失败：${e.javaClass.simpleName} ${e.message}")
            Res.Failed
        }
    }

    /** 从 JWT 载荷里取用户 id / 姓名（服务端已签名，这里只读取用于本地筛选） */
    fun decodeUser(token: String): Pair<String, String>? {
        return try {
            val parts = token.split(".")
            if (parts.size < 2) return null
            val payload = String(
                Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
            )
            val obj = JSONObject(payload)
            val id = obj.optString("id")
            val name = obj.optString("name")
            if (id.isBlank() && name.isBlank()) null else id to name
        } catch (e: Exception) {
            null
        }
    }

    /**
     * remind_people 存的是被提醒人的姓名/ID 的 JSON 字符串（如 ["刘科江"]），也可能是 null，或逗号分隔串。
     */
    fun parsePeople(value: Any?): List<String> {
        val raw = when (value) {
            null, JSONObject.NULL -> return emptyList()
            is JSONArray -> return (0 until value.length()).map { value.optString(it) }
            else -> value.toString().trim()
        }
        if (raw.isEmpty()) return emptyList()
        if (!raw.startsWith("[")) {
            return raw.split(",").map { it.trim() }.filter { it.isNotEmpty() }
        }
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { arr.optString(it) }
        } catch (e: Exception) {
            emptyList()
        }
    }
}
