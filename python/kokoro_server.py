"""Kokoro TTS sidecar: line-delimited JSON over stdin/stdout.

Requests (stdin):
  {"id": "1", "cmd": "speak", "text": "...", "voice": "af_heart", "speed": 1.0}
  {"id": "1", "cmd": "cancel"}
Responses (stdout):
  {"type": "ready"}
  {"type": "chunk", "id", "seq", "sr", "pcm": <base64 float32 LE>, "words": [{"text", "start", "end"}]}
  {"type": "done", "id"} | {"type": "error", "id", "message"}
"""

import argparse
import base64
import json
import os
import queue
import re
import sys
import threading

import numpy as np

# Reserve the real stdout for protocol messages; libraries print freely to stderr.
_proto = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
sys.stdout = sys.stderr
_proto_lock = threading.Lock()


def send(msg: dict) -> None:
    with _proto_lock:
        _proto.write(json.dumps(msg) + "\n")
        _proto.flush()


def estimate_words(text: str, duration: float) -> list[dict]:
    """Spread chunk duration across words by character length (no real timestamps)."""
    words = re.findall(r"\S+", text)
    total = sum(len(w) for w in words) or 1
    out, t = [], 0.0
    for w in words:
        d = duration * len(w) / total
        out.append({"text": w, "start": t, "end": t + d})
        t += d
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="mlx-community/Kokoro-82M-bf16")
    args = parser.parse_args()

    from mlx_audio.tts.utils import load_model

    model = load_model(args.model)
    sr = model.sample_rate
    # Warm up the default English pipeline so the first request is fast.
    model._get_pipeline("a")
    send({"type": "ready", "sr": sr})

    jobs: queue.Queue = queue.Queue()
    cancelled: set[str] = set()

    def worker() -> None:
        while True:
            req = jobs.get()
            rid = req["id"]
            try:
                voice = req.get("voice", "af_heart")
                lang = voice[0]
                pipeline = model._get_pipeline(lang)
                pipeline.voices = {}
                results = pipeline(
                    req["text"], voice=voice, speed=float(req.get("speed", 1.0))
                )
                for seq, result in enumerate(results):
                    if rid in cancelled:
                        break
                    if result.audio is None:
                        continue
                    audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                    if result.tokens:
                        words = [
                            {"text": t.text, "start": t.start_ts, "end": t.end_ts}
                            for t in result.tokens
                            if t.start_ts is not None and t.end_ts is not None
                        ]
                    else:
                        words = estimate_words(result.graphemes, len(audio) / sr)
                    send(
                        {
                            "type": "chunk",
                            "id": rid,
                            "seq": seq,
                            "sr": sr,
                            "pcm": base64.b64encode(audio.tobytes()).decode("ascii"),
                            "words": words,
                        }
                    )
                send({"type": "done", "id": rid})
            except Exception as e:  # report and keep serving
                send({"type": "error", "id": rid, "message": str(e)})
            finally:
                cancelled.discard(rid)
                jobs.task_done()

    threading.Thread(target=worker, daemon=True).start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            send({"type": "error", "id": None, "message": f"bad json: {e}"})
            continue
        cmd = req.get("cmd")
        if cmd == "speak":
            jobs.put(req)
        elif cmd == "cancel":
            cancelled.add(req["id"])

    # stdin closed: finish queued work before exiting.
    jobs.join()


if __name__ == "__main__":
    main()
