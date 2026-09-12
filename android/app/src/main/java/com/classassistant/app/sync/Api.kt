package com.classassistant.app.sync

import android.util.Base64
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

    private const val BASE = "https://class.qxwkstudio.top"

    /**
     * 请求结果。必须把「登录已失效」和「网络/服务异常」分开：
     * 前者重试多少次都不会成功，调用方应当清掉本地会话并停止重试。
     */
    sealed class Res {
        class Ok(val body: JSONObject) : Res()
        object Unauthorized : Res()
        object Failed : Res()

        /** Ok 时取 data.list；非 Ok 返回 null（用于区分「失败」与「确实没有数据」） */
        fun listOrNull(): List<JSONObject>? {
            val root = (this as? Ok)?.body ?: return null
            val arr = root.optJSONObject("data")?.optJSONArray("list") ?: return emptyList()
            return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
        }
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
                    parsed == null -> Res.Failed
                    else -> Res.Ok(parsed)
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
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
