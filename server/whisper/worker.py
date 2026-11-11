"""
말해서 찾기용 로컬 음성 인식 (키 없음). faster-whisper 를 한 번 띄워 두고 줄 단위 JSON 으로 주고받는다.
  stdin : {"id": 1, "wav": "<base64 WAV 16kHz mono>", "prompt": "목적지: 집, 회사"}
  stdout: {"id": 1, "text": "회기역으로 가자", "ms": 1234}  또는 {"id": 1, "error": "..."}
처음 한 줄은 {"ready": true, "ms": 모델 로드 시간}.
모델은 rokid-conversate 와 같은 small int8 (Railway CPU 에서 문장 하나 0.7~1.5초, conversate 실서버 측정).
"""
import base64
import io
import json
import os
import sys
import time

import numpy as np
import wave


def read_wav(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError("16bit mono WAV 만")
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if rate != 16000:
        # 단순 선형 보간 (안경은 16kHz 로 보낸다)
        n = int(len(pcm) * 16000 / rate)
        pcm = np.interp(np.linspace(0, len(pcm) - 1, n), np.arange(len(pcm)), pcm).astype(np.float32)
    return pcm


def main() -> None:
    from faster_whisper import WhisperModel

    t0 = time.time()
    model = WhisperModel(
        os.environ.get("WHISPER_MODEL", "small"),
        device="cpu",
        compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
        cpu_threads=int(os.environ.get("WHISPER_THREADS", "0")),
    )
    print(json.dumps({"ready": True, "ms": int((time.time() - t0) * 1000)}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            t = time.time()
            audio = read_wav(base64.b64decode(req["wav"]))
            segments, _ = model.transcribe(
                audio,
                language="ko",
                beam_size=5,
                temperature=0,
                initial_prompt=req.get("prompt") or None,
                condition_on_previous_text=False,
                vad_filter=True,
            )
            text = "".join(s.text for s in segments).strip()
            print(json.dumps({"id": req.get("id"), "text": text, "ms": int((time.time() - t) * 1000)}, ensure_ascii=False), flush=True)
        except Exception as e:  # noqa: BLE001 - 한 요청 실패로 워커가 죽지 않게
            print(json.dumps({"id": req.get("id"), "error": str(e)[:200]}), flush=True)


if __name__ == "__main__":
    main()
