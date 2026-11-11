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

    /**
     * 마이크 소스 (rokid-conversate 가 로키드 안경에서 실기로 확인한 것, 2026-11):
     * - VOICE_RECOGNITION 은 기본 음성 비서가 잡고 있어 전부 0 이 들어온다 → 쓰지 않음
     * - MIC + 채널 마스크 0x6000FC = 8채널. 0·1 = 에코 제거·빔포밍된 착용자 목소리(아주 깨끗), 2~5 = 원래 마이크 4개,
     *   6·7 = 스피커 참조. 착용자 혼자 말하므로 0번 채널 × 2
     * - 안 되면 일반 MIC 모노
     */
    private data class Source(val id: Int, val name: String, val mask: Int, val channels: Int, val pick: Int = 0, val gain: Int = 1)
    private val sources = listOf(
        Source(MediaRecorder.AudioSource.MIC, "MIC_8CH", ROKID_8CH_MASK, 8, pick = 0, gain = 2),
        Source(MediaRecorder.AudioSource.MIC, "MIC", AudioFormat.CHANNEL_IN_MONO, 1),
        Source(MediaRecorder.AudioSource.CAMCORDER, "CAMCORDER", AudioFormat.CHANNEL_IN_MONO, 1),
    )

    @SuppressLint("MissingPermission") // 호출 전에 RECORD_AUDIO 권한을 확인한다
    private fun open(src: Source): AudioRecord? = try {
        val format = AudioFormat.Builder().setSampleRate(RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(src.mask).build()
        val min = AudioRecord.getMinBufferSize(RATE, src.mask, AudioFormat.ENCODING_PCM_16BIT)
        AudioRecord.Builder().setAudioSource(src.id).setAudioFormat(format)
            .setBufferSizeInBytes(maxOf(min, RATE / 10 * src.channels * 2 * 4))
            .build()
            .takeIf { it.state == AudioRecord.STATE_INITIALIZED && it.channelCount == src.channels }
    } catch (e: Exception) {
        Log.w("Voice", "mic ${src.name} 실패", e)
        null
    }

    /** 녹음 시작. 마이크를 못 열면 false */
    fun start(): Boolean {
        if (active) return true
        val (src, rec) = sources.firstNotNullOfOrNull { s -> open(s)?.let { s to it } } ?: return false
        Log.i("Voice", "mic ${src.name}")
        stopRequested = false
        cancelled = false
        active = true
        Thread({ run(rec, src) }, "voice").start()
        return true
    }

    /** 지금까지 녹음한 것으로 끝낸다 */
    fun stop() { stopRequested = true }

    /** 녹음을 버린다 (onDone 을 부르지 않음) */
    fun cancel() { cancelled = true; stopRequested = true }

    private fun run(rec: AudioRecord, src: Source) {
        val pcm = ByteArrayOutputStream()
        val frames = RATE / 50 // 20ms
        val raw = ShortArray(frames * src.channels)
        val frame = ShortArray(frames)
        val bytes = ByteBuffer.allocate(frames * 2).order(ByteOrder.LITTLE_ENDIAN)
        var noise = 0.0
        var noiseFrames = 0
        var speechMs = 0
        var silentMs = 0
        var elapsed = 0
        var heard = false
        var anyNonZero = false
        try {
            rec.startRecording()
            while (!stopRequested && elapsed < MAX_MS) {
                val got = rec.read(raw, 0, raw.size)
                if (got <= 0) break
                // 여러 채널이 섞여 들어오면 고른 채널만, gain 배 (int16 범위로 자름)
                val n = pickChannel(raw, got, src.channels, src.pick, src.gain, frame)
                if (!anyNonZero && (0 until n).any { frame[it].toInt() != 0 }) anyNonZero = true
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
                main.post { onLevel((rms / 1500.0).coerceIn(0.0, 1.0).toFloat()) }
                if (heard && silentMs >= SILENCE_MS) break
                if (!heard && elapsed >= NO_SPEECH_MS) break
                // 1.5초 동안 전부 0 이면 이 소스는 막힌 것 (로그로 남겨 실기에서 확인)
                if (!anyNonZero && elapsed >= 1_500) { Log.w("Voice", "mic ${src.name}: 1.5초 동안 소리 0"); CrashLog.record("말해서 찾기: 마이크 ${src.name} 소리가 전부 0"); break }
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
        /** 말소리로 볼 최소 음량. 로키드 0번 채널은 착용자 목소리가 RMS 100~600 (conversate 실기), × 2 해서 200~1200 */
        const val MIN_SPEECH_RMS = 150.0
        /** 로키드 8채널 마스크 (rokid-conversate MicStreamer 와 같음) */
        const val ROKID_8CH_MASK = 0x6000FC

        /** 섞여 들어온 여러 채널(interleaved)에서 한 채널만 gain 배로 꺼낸다 (int16 범위로 자름). 꺼낸 프레임 수 */
        fun pickChannel(raw: ShortArray, samples: Int, channels: Int, pick: Int, gain: Int, out: ShortArray): Int {
            val n = minOf(samples / channels, out.size)
            for (i in 0 until n) out[i] = (raw[i * channels + pick] * gain).coerceIn(-32768, 32767).toShort()
            return n
        }

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
