#!/usr/bin/env python3
"""Export Open JTalk mora-level accent features for portable Go inference."""

import argparse
import json
from pathlib import Path

from openjtalk_features import analyze


def sparse_features(token):
    if token.get("pause") or "accent_phrase_position" not in token:
        return {}
    phrase_length = max(1, int(token["accent_phrase_length"]))
    phrase_position = int(token["accent_phrase_position"])
    nucleus = int(token["accent_nucleus"])
    result = {
        "accent_position": phrase_position / phrase_length,
        "accent_from_end": (phrase_length - phrase_position) / phrase_length,
        "accent_nucleus_position": nucleus / phrase_length,
        "accent_high": float(bool(token["accent_high"])),
        "accent_phrase_start": float(bool(token["accent_phrase_start"])),
        "accent_phrase_end": float(bool(token["accent_phrase_end"])),
        "word_start": float(bool(token["word_start"])),
        "word_end": float(bool(token["word_end"])),
        f"pos={token.get('pos', '*')}": 1.0,
        f"pos_group1={token.get('pos_group1', '*')}": 1.0,
    }
    if nucleus == 0:
        result["accent_type=heiban"] = 1.0
    elif phrase_position < nucleus:
        result["accent_type=before"] = 1.0
    elif phrase_position == nucleus:
        result["accent_type=nucleus"] = 1.0
    else:
        result["accent_type=after"] = 1.0
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    corpus = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    cases = []
    for item in corpus["cases"]:
        reading, tokens = analyze(item["text"])
        cases.append({
            "id": item["id"],
            "text": item["text"],
            "reading": reading,
            "features": [sparse_features(token) for token in tokens],
        })
    output = {"version": 1, "name": corpus.get("name", ""), "cases": cases}
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
