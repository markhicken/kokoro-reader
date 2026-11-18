"""Kokoro TTS sidecar: line-delimited JSON over stdin/stdout.

Requests (stdin):
  {"id": "1", "cmd": "speak", "text": "...", "voice": "af_heart", "speed": 1.0,
   "joinLines": true, "expandWords": true}
  {"id": "1", "cmd": "cancel"}
  {"id": "1", "cmd": "speed", "speed": 1.25}
  A speak request can also set startSeq to begin at an existing text chunk boundary.
Responses (stdout):
  {"type": "ready"}
  {"type": "chunk", "id", "seq", "speed", "sr", "pcm": <base64 float32 LE>, "words": [{"text", "start", "end"}]}
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


_ABBREVS = {
    r"Dr\.": "Doctor",
    r"Mr\.": "Mister",
    r"Mrs\.": "Missus",
    r"Ms\.": "Miz",
    r"Prof\.": "Professor",
    r"vs\.": "versus",
    r"etc\.": "etcetera",
    r"e\.g\.": "for example,",
    r"i\.e\.": "that is,",
    r"approx\.": "approximately",
}

_DECORATIVE_MARKS = re.compile(
    r"(?:"
    r"[\u2022\u2023\u2043\u204c\u204d\u2219\uf0a7\uf0b7]"  # bullets
    r"|[\u25a0-\u25ff\u274f-\u2752\u2756\u2b1b\u2b1c\U0001f536-\U0001f539\U0001f780-\U0001f7eb]"  # shapes
    r"|[\u2605\u2606\u2610-\u2612\u2705\u2713\u2714\u2726\u2727\u274c\u2b50]"  # stars and checkboxes
    r"|(?<!\w)\u00b7|\u00b7(?!\w)"  # keep the middle dot inside words such as l·l
    r")[\ufe0e\ufe0f]*"
)


def normalize_text(text: str, join_lines: bool = True, expand_words: bool = True) -> str:
    """Clean text the G2P handles poorly. Newlines are kept: they are the chunk splits."""
    text = re.sub(r"[\u200b-\u200d\u2060\ufeff\u00ad]", "", text)
    text = text.replace("\r\n", "\n").replace("\u00a0", " ")
    text = re.sub(r"[\u2018\u2019]", "'", text)
    text = re.sub(r"[\u201c\u201d]", '"', text)
    text = text.replace("\u2026", "...")
    text = re.sub(r"(?<=\d)\s*\u2013\s*(?=\d)", " to ", text)
    # Markdown / URLs
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+|www\.\S+", "link", text)
    text = _DECORATIVE_MARKS.sub(" ", text)  # keep adjacent words separate
    text = re.sub(r"(?m)^\s{0,3}(#{1,6}|>|[-*+])\s+", "", text)
    text = re.sub(r"[`*_~]{1,3}(?=\S)([^`*_~\n]*?)(?<=\S)[`*_~]{1,3}", r"\1", text)
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)  # hyphenated line wrap
    if expand_words:
        for pat, rep in _ABBREVS.items():
            text = re.sub(rf"\b{pat}", rep, text, flags=re.IGNORECASE)
    text = re.sub(r"(?<=\d),(?=\d{3}\b)", "", text)  # 1,000 -> 1000
    # Re-join hard-wrapped lines so a mid-sentence newline isn't a chunk break.
    if join_lines:
        text = re.sub(r"(?<![.!?:;\n])\n(?!\n)", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text


MAX_CHUNK_TOKENS = 200  # Kokoro slurs when a single utterance runs much longer

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+|(?<=[.!?][\"')\]])\s+")
_NOT_AN_END = re.compile(r"(?:\b(?:Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|vs|etc|approx)|\be\.g|\bi\.e|\b[A-Z])\.$")
_CLAUSE_END = re.compile(r"(?<=[,;:])\s+")


def split_sentences(text: str) -> list[str]:
    out: list[str] = []
    for piece in _SENTENCE_END.split(text):
        if out and _NOT_AN_END.search(out[-1]):
            out[-1] += " " + piece  # "Dr. Smith" is not a sentence break
        else:
            out.append(piece)
    return [p for p in out if p.strip()]


def split_chunks(text: str, measure, limit: int = MAX_CHUNK_TOKENS) -> list[str]:
    """Split `text` into chunks of at most ~`limit` tokens, breaking at sentence ends first,
    then clause punctuation, then words. Short sentences are packed together."""

    def pack(units: list[str], finer) -> list[str]:
        chunks: list[str] = []
        cur, cur_n = "", 0
        for u in units:
            n = measure(u)
            if n > limit and finer is not None:
                if cur:
                    chunks.append(cur)
                    cur, cur_n = "", 0
                chunks.extend(finer(u))
                continue
            if cur and cur_n + n > limit:
                chunks.append(cur)
                cur, cur_n = "", 0
            cur = f"{cur} {u}" if cur else u
            cur_n += n + 1
        if cur:
            chunks.append(cur)
        return chunks

    def by_words(u: str) -> list[str]:
        return pack(u.split(), None)

    def by_clauses(u: str) -> list[str]:
        return pack(_CLAUSE_END.split(u), by_words)

    return pack(split_sentences(text), by_clauses)


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


def serve(get_pipeline, sr: int) -> None:
    send({"type": "ready", "sr": sr})

    jobs: queue.Queue = queue.Queue()
    active: dict[str, dict] = {}
    state_lock = threading.Lock()

    def worker() -> None:
        last_input = None
        segments = []
        while True:
            req = jobs.get()
            rid = req["id"]
            try:
                voice = req.get("voice", "af_heart")
                lang = voice[0]
                with state_lock:
                    if req["cancelled"]:
                        continue
                pipeline = get_pipeline(lang)
                join_lines = req.get("joinLines", True)
                expand_words = req.get("expandWords", True)
                source = (req["text"], lang, join_lines, expand_words)
                if source != last_input:
                    text = normalize_text(req["text"], join_lines, expand_words)

                    def measure(t: str) -> int:
                        if lang not in "ab":
                            return len(t)
                        _, toks = pipeline.g2p(t)
                        return sum(len(k.phonemes or "") + bool(k.whitespace) for k in toks)

                    segments = [c for line in re.split(r"\n+", text.strip()) for c in split_chunks(line, measure)]
                    last_input = source

                start_seq = max(0, int(req.get("startSeq", 0)))
                for seq in range(start_seq, len(segments)):
                    with state_lock:
                        if req["cancelled"]:
                            break
                        speed = float(req.get("speed", 1.0))
                    audio_parts = []
                    words = []
                    samples = 0
                    # Keep one stable sequence number per text segment even if a backend splits it further.
                    for result in pipeline(segments[seq], voice=voice, speed=speed):
                        if result.audio is None:
                            continue
                        audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                        if result.tokens:
                            timed = [
                                {"text": t.text, "start": t.start_ts, "end": t.end_ts}
                                for t in result.tokens
                                if t.start_ts is not None and t.end_ts is not None
                            ]
                        else:
                            timed = estimate_words(result.graphemes, len(audio) / sr)
                        offset = samples / sr
                        for word in timed:
                            words.append({"text": word["text"], "start": offset + word["start"], "end": offset + word["end"]})
                        samples += len(audio)
                        audio_parts.append(audio.tobytes())
                    with state_lock:
                        if req["cancelled"]:
                            break
                    if not samples:
                        continue
                    send(
                        {
                            "type": "chunk",
                            "id": rid,
                            "seq": seq,
                            "speed": speed,
                            "sr": sr,
                            "pcm": base64.b64encode(b"".join(audio_parts)).decode("ascii"),
                            "words": words,
                        }
                    )
                send({"type": "done", "id": rid})
            except Exception as e:  # report and keep serving
                send({"type": "error", "id": rid, "message": str(e)})
            finally:
                with state_lock:
                    if active.get(rid) is req:
                        del active[rid]
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
            req["cancelled"] = False
            with state_lock:
                active[req["id"]] = req
            jobs.put(req)
        elif cmd in ("speed", "cancel"):
            with state_lock:
                job = active.get(req["id"])
                if job is not None:
                    if cmd == "speed":
                        job["speed"] = req["speed"]
                    else:
                        job["cancelled"] = True

    # stdin closed: finish queued work before exiting.
    jobs.join()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="mlx-community/Kokoro-82M-bf16")
    parser.add_argument(
        "--dtype",
        choices=["float32"],
        help="Cast the loaded weights (no fp32 MLX Kokoro repo exists, so upcast bf16)",
    )
    args = parser.parse_args()

    from mlx_audio.tts.utils import load_model

    model = load_model(args.model)
    if args.dtype == "float32":
        import mlx.core as mx
        from mlx.utils import tree_map

        model.update(tree_map(lambda p: p.astype(mx.float32), model.parameters()))
        mx.eval(model.parameters())

    def get_pipeline(lang):
        pipeline = model._get_pipeline(lang)
        pipeline.voices = {}
        return pipeline

    # Warm up the default English pipeline so the first request is fast.
    model._get_pipeline("a")
    serve(get_pipeline, model.sample_rate)


if __name__ == "__main__":
    main()
