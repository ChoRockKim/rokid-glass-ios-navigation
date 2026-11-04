package com.chorock.rokidroute

import android.util.Log
import java.io.File

/**
 * 안경 앱 오류 기록. adb 없이도 원인을 알 수 있게 파일에 남겼다가 다음에 서버와 연결되면 보낸다 (서버 로그 "glass crash report").
 * - 앱이 죽는 오류: 기본 처리기 앞에서 기록하고 원래대로 넘긴다
 * - 죽지는 않았지만 막은 오류(메시지 처리 실패 등): [record]
 * 파일은 최근 4KB 만 둔다.
 */
object CrashLog {
    private const val MAX = 4000
    private var file: File? = null

    fun install(dir: File) {
        file = File(dir, "crash.txt")
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            record("앱 종료 (${t.name}): ${Log.getStackTraceString(e)}")
            previous?.uncaughtException(t, e)
        }
    }

    @Synchronized
    fun record(text: String) {
        val f = file ?: return
        runCatching {
            val stamp = java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.KOREA).format(java.util.Date())
            val all = (if (f.exists()) f.readText() else "") + "[$stamp v${BuildConfig.VERSION_NAME}] $text\n"
            f.writeText(all.takeLast(MAX))
        }
    }

    /** 보낼 기록이 있으면 꺼내고 지운다 */
    @Synchronized
    fun take(): String? {
        val f = file ?: return null
        val text = runCatching { if (f.exists()) f.readText() else null }.getOrNull()?.takeIf { it.isNotBlank() } ?: return null
        f.delete()
        return text
    }
}
