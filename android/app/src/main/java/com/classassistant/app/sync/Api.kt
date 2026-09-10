package com.classassistant.app.sync

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * 极简接口客户端：只用到几个 GET，不引第三方网络库。
 * 站点与 App 同源，接口都在 https://class.qxwkstudio.top/api 下。
 */
object Api {

    private const val BASE = "https://class.qxwkstudio.top"

    /** 取 data.list；请求失败返回 null（用于区分「失败」与「确实没有数据」） */
    fun getList(path: String, token: String): List<JSONObject>? {
        val root = get(path, token) ?: return null
        val arr = root.optJSONObject("data")?.optJSONArray("list") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
    }

    fun get(path: String, token: String): JSONObject? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(BASE + path).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15000
                readTimeout = 15000
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("Accept", "application/json")
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText)
            if (code !in 200..299 || text.isNullOrBlank()) null else JSONObject(text)
        } catch (e: Exception) {
            null
        } finally {
            conn?.disconnect()
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
