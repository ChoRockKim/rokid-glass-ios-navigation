package com.chorock.rokidroute

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class CrashLogTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun recordTakeAndCap() {
        CrashLog.install(tmp.root)
        CrashLog.record("메시지 map-pos 처리 실패: JSONException")
        val t = CrashLog.take()!!
        assertTrue(t.contains("map-pos 처리 실패"))
        assertNull(CrashLog.take()) // 보낸 뒤에는 지운다
        repeat(200) { CrashLog.record("x".repeat(100)) }
        assertEquals(4000, CrashLog.take()!!.length) // 최근 4KB 만
    }
}
