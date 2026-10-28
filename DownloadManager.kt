package com.example.newmusic

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** Şarkıları cihaza indirir; indirilenler internetsiz çalınır. */
object DownloadManager {
    private const val CHUNK = 2_000_000L
    private const val UA_WEB = "Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0"
    private const val UA_ANDROID = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
    private const val UA_IOS = "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)"
    private const val UA_VR = "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = OkHttpClient()
    private lateinit var dir: File
    private lateinit var prefs: SharedPreferences
    private val jobs = mutableMapOf<String, Job>()

    val songs = MutableStateFlow<List<Song>>(emptyList())
    val progress = MutableStateFlow<Map<String, Float>>(emptyMap())
    val failed = MutableStateFlow<String?>(null)

    fun init(ctx: Context) {
        if (::dir.isInitialized) return
        val app = ctx.applicationContext
        dir = File(app.filesDir, "downloads").apply { mkdirs() }
        prefs = app.getSharedPreferences("downloads", Context.MODE_PRIVATE)
        songs.value = load().filter { file(it).exists() }
    }

    private fun id(s: Song) = s.url.substringAfter("v=", s.url.hashCode().toString())
    private fun file(s: Song) = File(dir, id(s) + ".audio")
    private fun part(s: Song) = File(dir, id(s) + ".part")

    fun fileOf(s: Song): File? =
        if (::dir.isInitialized) file(s).takeIf { it.exists() } else null

    fun download(s: Song) {
        if (!::dir.isInitialized) return
        if (progress.value.containsKey(s.url) || fileOf(s) != null) return
        progress.value = progress.value + (s.url to 0f)
        jobs[s.url] = scope.launch {
            try {
                val urls = MusicRepository.audioUrls(s.url)
                if (urls.isEmpty()) throw IOException("Ses akışı bulunamadı")
                var ok = false
                var last: Exception? = null
                for (u in urls.take(3)) {
                    try {
                        fetch(u, part(s)) { p -> progress.value = progress.value + (s.url to p) }
                        ok = true
                        break
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        last = e
                    }
                }
                if (!ok) throw (last ?: IOException("İndirilemedi"))
                part(s).renameTo(file(s))
                songs.value = listOf(s) + songs.value.filter { it.url != s.url }
                save()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed.value = "İndirme hatası: ${e.message}"
            } finally {
                progress.value = progress.value - s.url
                jobs.remove(s.url)
                part(s).delete()
            }
        }
    }

    fun cancel(s: Song) { jobs[s.url]?.cancel() }

    fun delete(s: Song) {
        if (!::dir.isInitialized) return
        jobs[s.url]?.cancel()
        file(s).delete()
        songs.value = songs.value.filter { it.url != s.url }
        save()
    }

    private fun fetch(url: String, out: File, onProgress: (Float) -> Unit) {
        val uri = Uri.parse(url)
        var total = uri.getQueryParameter("clen")?.toLongOrNull() ?: -1L
        val c = uri.getQueryParameter("c").orEmpty()
        var pos = 0L
        var rn = 0
        var done = false
        out.outputStream().use { os ->
            val buf = ByteArray(64 * 1024)
            while (!done) {
                if (total > 0 && pos >= total) break
                val to = (if (total > 0) minOf(pos + CHUNK, total) else pos + CHUNK) - 1
                val b = uri.buildUpon().clearQuery()
                uri.queryParameterNames.filter { it != "range" && it != "rn" }.forEach { n ->
                    uri.getQueryParameters(n).forEach { v -> b.appendQueryParameter(n, v) }
                }
                b.appendQueryParameter("range", "$pos-$to")
                val rb = Request.Builder()
                when {
                    c.startsWith("ANDROID_VR") -> rb.header("User-Agent", UA_VR)
                    c.startsWith("ANDROID") -> rb.header("User-Agent", UA_ANDROID)
                    c.startsWith("IOS") -> rb.header("User-Agent", UA_IOS)
                    else -> {
                        b.appendQueryParameter("rn", (rn++).toString())
                        rb.header("User-Agent", UA_WEB)
                            .header("Origin", "https://www.youtube.com")
                            .header("Referer", "https://www.youtube.com/")
                    }
                }
                http.newCall(rb.url(b.build().toString()).build()).execute().use { r ->
                    if (r.code == 416) { done = true; return@use }
                    if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
                    r.header("Content-Range")?.substringAfter('/', "")?.toLongOrNull()?.let { total = it }
                    val ins = r.body!!.byteStream()
                    var got = 0L
                    while (true) {
                        val n = ins.read(buf)
                        if (n < 0) break
                        os.write(buf, 0, n)
                        got += n
                        pos += n
                        if (total > 0) onProgress((pos.toFloat() / total).coerceIn(0f, 1f))
                    }
                    if (got == 0L) done = true
                }
            }
        }
        if (pos == 0L) throw IOException("Boş dosya")
        if (total > 0 && pos < total) throw IOException("İndirme yarım kaldı")
    }

    private fun save() {
        val a = JSONArray()
        songs.value.forEach {
            a.put(JSONObject().put("t", it.title).put("a", it.artist).put("u", it.url).put("i", it.thumb ?: ""))
        }
        prefs.edit().putString("list", a.toString()).apply()
    }

    private fun load(): List<Song> = try {
        val a = JSONArray(prefs.getString("list", "[]"))
        (0 until a.length()).map {
            val o = a.getJSONObject(it)
            Song(o.getString("t"), o.getString("a"), o.getString("u"), o.optString("i").ifEmpty { null })
        }
    } catch (e: Exception) { emptyList() }
}
