package com.chorock.rokidroute

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceRecorderTest {
    @Test
    fun picksChannelZeroTimesTwoFromEightChannels() {
        // 프레임 3개 × 8채널: 0번 채널 = 100, -200, 20000 (× 2 → 마지막은 32767 로 잘림)
        val raw = ShortArray(24) { i -> if (i % 8 == 0) listOf(100, -200, 20000)[i / 8].toShort() else 7 }
        val out = ShortArray(3)
        assertEquals(3, VoiceRecorder.pickChannel(raw, raw.size, 8, 0, 2, out))
        assertArrayEquals(shortArrayOf(200, -400, 32767), out)
    }

    @Test
    fun monoPassesThrough() {
        val raw = shortArrayOf(1, 2, 3)
        val out = ShortArray(3)
        assertEquals(3, VoiceRecorder.pickChannel(raw, 3, 1, 0, 1, out))
        assertArrayEquals(raw, out)
    }

    @Test
    fun wavHeader() {
        val w = VoiceRecorder.wav(ByteArray(10))
        assertEquals(54, w.size)
        assertEquals("RIFF", String(w, 0, 4))
        assertEquals("WAVE", String(w, 8, 4))
    }
}
