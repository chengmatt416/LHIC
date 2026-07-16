#!/usr/bin/env python3

import argparse
import json
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a batch of local Kokoro TTS WAV files."
    )
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--voices", required=True, type=Path)
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", default=1.15, type=float)
    return parser.parse_args()


def load_manifest(path: Path) -> list[dict[str, str]]:
    entries = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(entries, list) or not entries:
        raise ValueError("The TTS manifest must contain at least one narration entry.")
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("text"), str) or not isinstance(entry.get("output"), str):
            raise ValueError("Each TTS manifest entry requires text and output strings.")
    return entries


def main() -> None:
    arguments = parse_arguments()
    if arguments.speed <= 0:
        raise ValueError("TTS speed must be greater than zero.")
    entries = load_manifest(arguments.manifest)
    kokoro = Kokoro(str(arguments.model), str(arguments.voices))

    for entry in entries:
        samples, sample_rate = kokoro.create(
            entry["text"],
            voice=arguments.voice,
            speed=arguments.speed,
            lang="en-us",
        )
        if len(samples) == 0:
            raise RuntimeError("Kokoro returned an empty narration waveform.")
        output = Path(entry["output"])
        output.parent.mkdir(parents=True, exist_ok=True)
        sf.write(output, samples, sample_rate)
        print(
            json.dumps(
                {
                    "output": str(output),
                    "durationSeconds": len(samples) / sample_rate,
                }
            )
        )


if __name__ == "__main__":
    main()
