@file:OptIn(UnstableApi::class)

package com.example.newmusic

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import okhttp3.OkHttpClient

/** Arka planda kesintisiz çalma + bildirim/kilit ekranı kontrolleri. */
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private var exo: ExoPlayer? = null

    override fun onCreate() {
        super.onCreate()
        val client = OkHttpClient()
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(this, DataSource.Factory { ChunkedDataSource(client) })))
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .setUsage(C.USAGE_MEDIA).build(), true
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        exo = player
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        session = MediaSession.Builder(this, QueuePlayer(player)).setSessionActivity(open).build()
        setMediaNotificationProvider(
            DefaultMediaNotificationProvider(this).apply { setSmallIcon(R.drawable.ic_notification) }
        )
    }

    override fun onGetSession(info: MediaSession.ControllerInfo) = session

    override fun onDestroy() {
        session?.release(); session = null
        exo?.release(); exo = null
        super.onDestroy()
    }
}

/** Bildirimdeki ileri/geri tuşları uygulamanın kuyruğunu yönetsin. */
private class QueuePlayer(p: Player) : ForwardingPlayer(p) {
    private val extra = intArrayOf(
        Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_PREVIOUS,
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM
    )
    override fun getAvailableCommands(): Player.Commands =
        super.getAvailableCommands().buildUpon().addAll(*extra).build()
    override fun isCommandAvailable(command: Int) = command in extra || super.isCommandAvailable(command)
    override fun hasNextMediaItem() = true
    override fun hasPreviousMediaItem() = true
    override fun seekToNext() { PlayerManager.next() }
    override fun seekToNextMediaItem() { PlayerManager.next() }
    override fun seekToPrevious() { PlayerManager.prev() }
    override fun seekToPreviousMediaItem() { PlayerManager.prev() }
}
