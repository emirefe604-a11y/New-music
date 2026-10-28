package com.example.newmusic

import android.content.ComponentName
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** Kuyruk, çalma durumu, favoriler ve dinleme geçmişi (kişiselleştirme için). */
object PlayerManager {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var controller: MediaController? = null
    private var future: ListenableFuture<MediaController>? = null
    private lateinit var prefs: SharedPreferences
    private var job: Job? = null
    private var attempt = 0

    val queue = MutableStateFlow<List<Song>>(emptyList())
    val index = MutableStateFlow(-1)
    val playing = MutableStateFlow(false)
    val loading = MutableStateFlow(false)
    val error = MutableStateFlow<String?>(null)
    val favorites = MutableStateFlow<List<Song>>(emptyList())
    val history = MutableStateFlow<List<Song>>(emptyList())
    val shuffle = MutableStateFlow(false)
    val repeat = MutableStateFlow(0) // 0 kapalı, 1 liste, 2 tek şarkı

    private val counts = mutableMapOf<String, Int>()
    private val artistCounts = mutableMapOf<String, Int>()

    private val listener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) { playing.value = isPlaying }
        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_ENDED) {
                if (repeat.value == 2) playIndex(index.value, true) else next()
            }
        }
        override fun onPlayerError(e: PlaybackException) {
            if (attempt < 3 && index.value >= 0) {
                attempt++
                playIndex(index.value, true, retry = true, resume = controller?.currentPosition ?: 0L)
            } else {
                loading.value = false
                error.value = "Oynatma hatası: ${e.errorCodeName} ${e.cause?.message ?: ""}".trim()
                attempt = 0
                next()
            }
        }
    }

    fun connect(ctx: Context) {
        if (future != null) return
        val app = ctx.applicationContext
        prefs = app.getSharedPreferences("music", Context.MODE_PRIVATE)
        DownloadManager.init(app)
        favorites.value = loadList("favs")
        history.value = loadList("hist")
        counts.putAll(loadMap("counts"))
        artistCounts.putAll(loadMap("artists"))
        val f = MediaController.Builder(
            app, SessionToken(app, ComponentName(app, PlaybackService::class.java))
        ).buildAsync()
        future = f
        f.addListener({
            try { controller = f.get().also { it.addListener(listener) } }
            catch (e: Exception) { error.value = "Oynatıcı başlatılamadı" }
        }, ContextCompat.getMainExecutor(app))
    }

    fun position(): Long = controller?.currentPosition ?: 0L
    fun buffered(): Long = controller?.bufferedPosition ?: 0L
    fun duration(): Long = (controller?.duration ?: 0L).coerceAtLeast(0L)
    fun seekTo(ms: Long) { controller?.seekTo(ms) }
    fun togglePlay() { controller?.let { if (it.isPlaying) it.pause() else it.play() } }

    fun playQueue(list: List<Song>, start: Int) {
        queue.value = list
        playIndex(start, false)
    }

    fun playIndex(i: Int, auto: Boolean = false, retry: Boolean = false, resume: Long = 0L) {
        val q = queue.value
        if (i !in q.indices) return
        if (!retry) attempt = 0
        index.value = i; error.value = null; loading.value = true
        job?.cancel()
        job = scope.launch {
            try {
                val s = q[i]
                // İndirilmişse internetsiz, yerel dosyadan çal
                val url: String = DownloadManager.fileOf(s)?.let { Uri.fromFile(it).toString() } ?: run {
                    val urls = MusicRepository.audioUrls(s.url)
                    if (urls.isEmpty()) throw Exception("Ses akışı bulunamadı")
                    urls[attempt % urls.size]
                }
                controller?.run {
                    setMediaItem(
                        MediaItem.Builder().setUri(url).setMediaMetadata(
                            MediaMetadata.Builder().setTitle(s.title).setArtist(s.artist)
                                .setArtworkUri(s.thumb?.let { Uri.parse(it) }).build()
                        ).build(),
                        resume
                    )
                    prepare(); play()
                }
                if (!retry) record(s)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error.value = e.message ?: "Çalma hatası"
                if (auto) { loading.value = false; next(); return@launch }
            }
            loading.value = false
        }
    }

    fun next(auto: Boolean = true) {
        scope.launch {
            val i = index.value
            val size = queue.value.size
            if (shuffle.value && size > 1) {
                var r = i
                while (r == i) r = (0 until size).random()
                playIndex(r, auto); return@launch
            }
            if (i + 1 < size) { playIndex(i + 1, auto); return@launch }
            if (repeat.value == 1) { playIndex(0, auto); return@launch }
            val cur = queue.value.getOrNull(i) ?: return@launch
            try {
                val more = MusicRepository.related(cur.url)
                    .filter { r -> queue.value.none { it.url == r.url } }
                if (more.isNotEmpty()) { queue.value = queue.value + more; playIndex(i + 1, auto) }
                else playIndex(0, auto)
            } catch (e: Exception) { playIndex(0, auto) }
        }
    }

    fun toggleShuffle() { shuffle.value = !shuffle.value }
    fun cycleRepeat() { repeat.value = (repeat.value + 1) % 3 }

    fun prev() {
        if (position() > 3000) { seekTo(0); return }
        playIndex(maxOf(0, index.value - 1), false)
    }

    // ---- Kişiselleştirme ----
    private fun cleanArtist(a: String) = a.removeSuffix(" - Topic").trim()

    private fun record(s: Song) {
        counts[s.url] = (counts[s.url] ?: 0) + 1
        val a = cleanArtist(s.artist)
        if (a.isNotBlank()) artistCounts[a] = (artistCounts[a] ?: 0) + 1
        history.value = (listOf(s) + history.value.filter { it.url != s.url }).take(100)
        saveList("hist", history.value)
        saveMap("counts", counts)
        saveMap("artists", artistCounts)
    }

    /** En çok dinlenen sanatçılar (beğeniler ağırlık katar). */
    fun topArtists(): List<String> =
        artistCounts.entries.sortedByDescending { it.value }.take(5).map { it.key }

    fun toggleFav(s: Song) {
        val had = favorites.value.any { it.url == s.url }
        favorites.value = if (had) favorites.value.filter { it.url != s.url } else listOf(s) + favorites.value
        if (!had) {
            val a = cleanArtist(s.artist)
            if (a.isNotBlank()) { artistCounts[a] = (artistCounts[a] ?: 0) + 3; saveMap("artists", artistCounts) }
        }
        saveList("favs", favorites.value)
    }

    // ---- Kalıcı depolama ----
    private fun saveList(key: String, list: List<Song>) {
        val a = JSONArray()
        list.forEach {
            a.put(JSONObject().put("t", it.title).put("a", it.artist).put("u", it.url).put("i", it.thumb ?: ""))
        }
        prefs.edit().putString(key, a.toString()).apply()
    }

    private fun loadList(key: String): List<Song> = try {
        val a = JSONArray(prefs.getString(key, "[]"))
        (0 until a.length()).map {
            val o = a.getJSONObject(it)
            Song(o.getString("t"), o.getString("a"), o.getString("u"), o.optString("i").ifEmpty { null })
        }
    } catch (e: Exception) { emptyList() }

    private fun saveMap(key: String, m: Map<String, Int>) {
        prefs.edit().putString(key, JSONObject(m).toString()).apply()
    }

    private fun loadMap(key: String): Map<String, Int> = try {
        val o = JSONObject(prefs.getString(key, "{}"))
        val m = mutableMapOf<String, Int>()
        o.keys().forEach { m[it] = o.getInt(it) }
        m
    } catch (e: Exception) { emptyMap() }
}
