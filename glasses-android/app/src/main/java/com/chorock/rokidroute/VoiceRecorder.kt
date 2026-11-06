package com.chorock.rokidroute

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

/**
 * 목적지를 말하는 동안 안경 마이크로 녹음해 WAV(16kHz mono 16bit)로 돌려준다.
 * 말이 시작된 뒤 [SILENCE_MS] 동안 조용하면 저절로 끝, 최대 [MAX_MS]. 처음 [NO_SPEECH_MS] 안에 말이 없으면 null.
 * 말소리 판단은 단순 음량(RMS): 처음 0.3초로 주변 소음을 재고 그보다 충분히 크면 말소리로 본다 (실기에서 값 조정 필요)
 */
class VoiceRecorder(
    private val onLevel: (Float) -> Unit,
    private val onDone: (ByteArray?) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var stopRequested = false
    @Volatile private var cancelled = false
    @Volatile var active = false
        private set

    /** 녹음 시작. 마이크를 못 열면 false */
    @SuppressLint("MissingPermission") // 호출 전에 RECORD_AUDIO 권한을 확인한다
    fun start(): Boolean {
        if (active) return true
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) return false
        val rec = listOf(MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC).firstNotNullOfOrNull { src ->
            runCatching { AudioRecord(src, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, RATE)) }
                .getOrNull()?.takeIf { it.state == AudioRecord.STATE_INITIALIZED }
        } ?: return false
        stopRequested = false
        cancelled = false
        active = true
        Thread({ run(rec) }, "voice").start()
        return true
    }

    /** 지금까지 녹음한 것으로 끝낸다 */
    fun stop() { stopRequested = true }

    /** 녹음을 버린다 (onDone 을 부르지 않음) */
    fun cancel() { cancelled = true; stopRequested = true }

    private fun run(rec: AudioRecord) {
        val pcm = ByteArrayOutputStream()
        val frame = ShortArray(RATE / 50) // 20ms
        val bytes = ByteBuffer.allocate(frame.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        var noise = 0.0
        var noiseFrames = 0
        var speechMs = 0
        var silentMs = 0
        var elapsed = 0
        var heard = false
        try {
            rec.startRecording()
            while (!stopRequested && elapsed < MAX_MS) {
                val n = rec.read(frame, 0, frame.size)
                if (n <= 0) break
                bytes.clear()
                var sum = 0.0
                for (i in 0 until n) { bytes.putShort(frame[i]); sum += frame[i].toDouble() * frame[i] }
                pcm.write(bytes.array(), 0, n * 2)
                val rms = sqrt(sum / n)
                val ms = n * 1000 / RATE
                elapsed += ms
                if (elapsed <= CALIBRATE_MS) { noise += rms; noiseFrames++; continue }
                val floor = if (noiseFrames > 0) noise / noiseFrames else 0.0
                val loud = rms > maxOf(MIN_SPEECH_RMS, floor * 2.5)
                if (loud) { speechMs += ms; silentMs = 0 } else silentMs += ms
                if (speechMs >= 120) heard = true
                main.post { onLevel((rms / 4000.0).coerceIn(0.0, 1.0).toFloat()) }
                if (heard && silentMs >= SILENCE_MS) break
                if (!heard && elapsed >= NO_SPEECH_MS) break
            }
        } catch (e: Exception) {
            Log.w("Voice", "녹음 실패", e)
        } finally {
            runCatching { rec.stop() }
            rec.release()
        }
        val data = pcm.toByteArray()
        // 탭으로 끝냈으면 말소리 판단이 빗나갔어도 보낸다 (0.5초 이상일 때)
        val usable = heard || (stopRequested && data.size >= RATE)
        val wav = if (usable) wav(data) else null
        main.post {
            active = false
            if (!cancelled) onDone(wav)
        }
    }

    companion object {
        const val RATE = 16_000
        const val MAX_MS = 7_000
        const val SILENCE_MS = 900
        const val NO_SPEECH_MS = 4_500
        const val CALIBRATE_MS = 300
        const val MIN_SPEECH_RMS = 500.0

        /** PCM 16bit mono 앞에 44바이트 WAV 머리를 붙인다 */
        fun wav(pcm: ByteArray, rate: Int = RATE): ByteArray {
            val b = ByteBuffer.allocate(44 + pcm.size).order(ByteOrder.LITTLE_ENDIAN)
            b.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
            b.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
            b.put("data".toByteArray()).putInt(pcm.size).put(pcm)
            return b.array()
        }
    }
}
