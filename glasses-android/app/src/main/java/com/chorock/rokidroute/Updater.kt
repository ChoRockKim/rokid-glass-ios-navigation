package com.chorock.rokidroute

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * 서버(/app/latest, /app/download)에서 새 APK 를 받아 설치한다. rokid-conversate 와 같은 방식:
 * - Android 12+ 에서 PackageInstaller 세션 + USER_ACTION_NOT_REQUIRED 로 확인 창 없이 스스로 업데이트
 *   (rokid-conversate 에서 실기 확인. 조건: 이 앱이 설치자로 기록돼 있고 '이 출처 허용'이 켜져 있음)
 * - 그래도 시스템이 확인을 요구하면 [UpdateReceiver] 가 확인 창을 띄운다 (예전과 같은 결과)
 * - 설치가 끝나면 MY_PACKAGE_REPLACED 로 앱을 다시 띄운다
 * (예전 설명: 새 APK 를 받아 안드로이드 설치 창을 띄운다.)
 * 일반 앱은 무음 설치가 안 되고 시스템 확인 창이 뜬다 (Rokid 공식 예제 ApkInstallUtil 주석과 같음).
 * 처음 한 번은 "출처를 알 수 없는 앱 설치" 허용 설정 화면으로 보낸다.
 * 업데이트는 같은 서명 키로 서명된 APK 만 설치된다 (고정 릴리스 키로 빌드).
 */
class Updater(
    private val context: Context,
    private val base: String,
    private val token: () -> String?,
    private val onStatus: (String) -> Unit,
) {
    data class Latest(val versionCode: Int, val versionName: String, val size: Long, val sha256: String)

    private val http = OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    var available: Latest? = null
        private set
    private var busy = false

    /** onDone: 확인이 끝난 뒤(성공·실패 모두) 메인 스레드에서 한 번 */
    fun check(onDone: (() -> Unit)? = null) {
        if (busy) return
        val t = token() ?: return onStatus("연결 토큰 없음")
        busy = true
        onStatus("확인 중…")
        Thread {
            val msg = runCatching {
                http.newCall(Request.Builder().url("$base/app/latest").header("Authorization", "Bearer $t").build()).execute().use { r ->
                    when {
                        r.code == 404 -> "서버에 올라온 버전 없음"
                        !r.isSuccessful -> "확인 실패 (${r.code})"
                        else -> {
                            val j = JSONObject(r.body!!.string())
                            val l = Latest(j.getInt("versionCode"), j.getString("versionName"), j.getLong("size"), j.getString("sha256"))
                            if (l.versionCode > BuildConfig.VERSION_CODE) {
                                available = l
                                "새 버전 ${l.versionName} · 탭하면 설치"
                            } else {
                                available = null
                                "최신 버전 (${BuildConfig.VERSION_NAME})"
                            }
                        }
                    }
                }
            }.getOrElse { "확인 실패 (${it.javaClass.simpleName})" }
            main.post { busy = false; onStatus(msg); onDone?.invoke() }
        }.start()
    }

    fun install() {
        val l = available ?: return check()
        if (busy) return
        // 설치 허용이 안 돼 있으면 설정 화면으로 (허용 후 다시 선택)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            onStatus("설정에서 '이 출처 허용'을 켠 뒤 다시 선택")
            runCatching {
                context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            return
        }
        val t = token() ?: return onStatus("연결 토큰 없음")
        busy = true
        onStatus("받는 중… 0%")
        Thread {
            val result = runCatching {
                val dir = File(context.cacheDir, "updates").apply { mkdirs() }
                val file = File(dir, "update.apk")
                val md = MessageDigest.getInstance("SHA-256")
                http.newCall(Request.Builder().url("$base/app/download").header("Authorization", "Bearer $t").build()).execute().use { r ->
                    if (!r.isSuccessful) error("다운로드 실패 (${r.code})")
                    val body = r.body!!
                    val total = body.contentLength().takeIf { it > 0 } ?: l.size
                    var got = 0L
                    var lastPct = -1
                    body.byteStream().use { input ->
                        file.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                md.update(buf, 0, n)
                                got += n
                                val pct = (got * 100 / total).toInt()
                                if (pct != lastPct && pct % 10 == 0) { lastPct = pct; main.post { onStatus("받는 중… $pct%") } }
                            }
                        }
                    }
                }
                val hex = md.digest().joinToString("") { "%02x".format(it) }
                if (hex != l.sha256) error("파일 확인 실패 (sha256 불일치)")
                file
            }
            main.post {
                busy = false
                result.fold(
                    onSuccess = { file ->
                        // 확인 없이 설치 (시스템이 확인을 요구하면 UpdateReceiver 가 창을 연다). 세션을 못 만들면 예전 설치 창으로
                        runCatching { commit(file) }
                            .onSuccess { onStatus("${l.versionName} 설치 중… 앱이 다시 시작됩니다") }
                            .onFailure {
                                Log.w("Updater", "PackageInstaller 실패, 설치 창으로", it)
                                onStatus("설치 창에서 '설치'를 선택하세요")
                                val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
                                context.startActivity(Intent(Intent.ACTION_VIEW).apply {
                                    setDataAndType(uri, "application/vnd.android.package-archive")
                                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                                })
                            }
                    },
                    onFailure = { onStatus(it.message ?: "실패") },
                )
            }
        }.start()
    }

    /** PackageInstaller 에 넘기며 사용자 확인 없이 설치를 요청한다 */
    private fun commit(apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            apk.inputStream().use { input ->
                session.openWrite("update.apk", 0, apk.length()).use { out ->
                    input.copyTo(out)
                    session.fsync(out)
                }
            }
            val intent = Intent(context, UpdateReceiver::class.java).setAction(UpdateReceiver.ACTION_INSTALL_STATUS)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(context, sessionId, intent, flags).intentSender)
        }
    }
}

/**
 * - PackageInstaller 결과: 시스템이 확인을 꼭 요구하면 그 확인 창을 연다
 * - MY_PACKAGE_REPLACED: 업데이트가 들어가며 이전 프로세스가 끝났으니 앱을 다시 띄운다
 */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_INSTALL_STATUS -> {
                val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                Log.i("UpdateReceiver", "install status $status $msg")
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    @Suppress("DEPRECATION")
                    val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                    confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let(context::startActivity)
                } else if (status != PackageInstaller.STATUS_SUCCESS) {
                    CrashLog.record("업데이트 설치 실패: status=$status $msg")
                }
            }
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                Log.i("UpdateReceiver", "updated to ${BuildConfig.VERSION_NAME}, restarting")
                context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
    }

    companion object {
        const val ACTION_INSTALL_STATUS = "com.chorock.rokidroute.INSTALL_STATUS"
    }
}
