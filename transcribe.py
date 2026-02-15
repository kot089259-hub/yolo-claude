#!/usr/bin/env python3
"""ローカルWhisperで音声ファイルを文字起こしし、JSON形式で結果を出力する"""

import sys
import json
import whisper

def transcribe(audio_path: str, model_name: str = "base") -> None:
    model = whisper.load_model(model_name)
    result = model.transcribe(audio_path, language="ja", verbose=False)

    subtitles = []
    for seg in result.get("segments", []):
        subtitles.append({
            "start": round(seg["start"], 2),
            "end": round(seg["end"], 2),
            "text": seg["text"].strip()
        })

    output = {
        "text": result.get("text", ""),
        "subtitles": subtitles
    }
    print(json.dumps(output, ensure_ascii=False))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "音声ファイルのパスを指定してください"}))
        sys.exit(1)

    audio_file = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else "base"
    transcribe(audio_file, model)
