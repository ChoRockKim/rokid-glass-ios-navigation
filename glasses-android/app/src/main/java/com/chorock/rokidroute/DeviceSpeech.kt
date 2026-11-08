package com.chorock.rokidroute

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log

/**
 * 안경에 들어 있는 안드로이드 음성 인식 (키·서버 없음). 구글 음성 서비스 같은 인식 서비스가 깔려 있어야 한다.
 * 로키드 안경에 있는지·한국어가 되는지는 문서로 확인이 안 돼서, 켤 때 [available] 로 확인하고 안 되면 서버(CLOVA)로.
 * 메인 스레드에서만 부른다.
 */
class DeviceSpeech(private val context: Context) {
    /** 결과: 인식 후보들 (가장 그럴듯한 것부터). 실패면 error 에 이유, fallback = 서버 인식으로 다시 해 볼 만한 실패 */
    data class Result(val texts: List<String>, val error: String? = null, val fallback: Boolean = false)

    private var recognizer: SpeechRecognizer? = null
    var active = false
        private set

    /** 이 기기에서 쓸 수 있는지 (인식 서비스가 있는지) */
    val available: Boolean by lazy {
        runCatching { SpeechRecognizer.isRecognitionAvailable(context) }.getOrDefault(false).also {
            Log.i("Voice", "device speech available=$it")
        }
    }

    fun start(onReady: () -> Unit, onLevel: (Float) -> Unit, onDone: (Result) -> Unit): Boolean {
        if (active || !available) return false
        val r = runCatching { SpeechRecognizer.createSpeechRecognizer(context) }.getOrNull() ?: return false
        recognizer = r
        active = true
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = onReady()
            override fun onBeginningOfSpeech() {}
            // rmsdB 는 대략 -2 ~ 10
            override fun onRmsChanged(rmsdB: Float) = onLevel(((rmsdB + 2f) / 12f).coerceIn(0f, 1f))
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onResults(results: Bundle?) {
                val texts = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.filter { it.isNotBlank() } ?: emptyList()
                finish(Result(texts))
            }
            override fun onError(error: Int) {
                Log.w("Voice", "device speech error $error")
                finish(
                    when (error) {
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> Result(emptyList(), "못 알아들었어요 · 다시 시도")
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> Result(emptyList(), "마이크 권한 없음")
                        // 인식 서비스 쪽 문제 (네트워크·서버·언어 미지원 등) → 서버 인식으로
                        else -> Result(emptyList(), "안경 음성 인식 실패 ($error)", fallback = true)
                    },
                )
            }
            private fun finish(res: Result) {
                if (!active) return
                active = false
                runCatching { r.destroy() }
                recognizer = null
                onDone(res)
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ko-KR")
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
        }
        return runCatching { r.startListening(intent); true }.getOrElse {
            active = false
            runCatching { r.destroy() }
            recognizer = null
            false
        }
    }

    /** 지금까지 들은 것으로 끝 (결과는 onDone 으로) */
    fun stop() { recognizer?.stopListening() }

    /** 버림 (onDone 안 부름) */
    fun cancel() {
        val r = recognizer ?: return
        active = false
        recognizer = null
        runCatching { r.cancel(); r.destroy() }
    }
}
