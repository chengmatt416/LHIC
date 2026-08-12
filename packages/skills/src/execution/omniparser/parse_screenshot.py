#!/usr/bin/env python3
"""OmniParser V2 helper for the LHIC execution fallback.

Parses a screenshot into structured UI elements when the accessibility/DOM
layer cannot see the interface (canvas, games, remote screens, virtualized
content). LHIC dispatches input to the parsed element coordinates through its
traditional coordinate layer.

Commands:
  probe                             -> JSON { ok: true, detail: "..." }
  parse --screenshot PATH           -> JSON { elements: [...] }

Element shape: { id, label, role, frame: {x, y, width, height}, interactable }.

Model source: either the `omni_parser_v2` PyPI package (preferred) or a local
OmniParser repo checkout (weights under weights/icon_detect_v3 and
weights/icon_caption_florence) pointed to by LHIC_OMNIPARSER_DIR.
"""
import argparse
import json
import os
import sys
import traceback

try:
    from omni_parser_v2 import OmniParserConfig, OmniParserV2  # type: ignore
    PARSER_MODE = "package"
except Exception:  # pragma: no cover - depends on the local install
    PARSER_MODE = "repo"


def _load_parser():
    if PARSER_MODE == "package":
        config = OmniParserConfig(download_weights=True)
        return OmniParserV2(config), "omni_parser_v2 package"
    repo = os.environ.get("LHIC_OMNIPARSER_DIR")
    if not repo:
        raise RuntimeError(
            "OmniParser V2 is not installed. pip install omni_parser_v2, or "
            "clone https://github.com/microsoft/OmniParser and set "
            "LHIC_OMNIPARSER_DIR to it with weights/ downloaded."
        )
    sys.path.insert(0, repo)
    from util.parser import OmniParser  # type: ignore

    return OmniParser(repo), "OmniParser repo"


def _frame(bbox):
    return {
        "x": round(float(bbox[0])),
        "y": round(float(bbox[1])),
        "width": round(float(bbox[2]) - float(bbox[0])),
        "height": round(float(bbox[3]) - float(bbox[1])),
    }


def parse(screenshot_path):
    parser, source = _load_parser()
    if PARSER_MODE == "package":
        parsed = parser.parse(screenshot_path)
        raw_elements = getattr(parsed, "elements", []) or []
    else:
        parsed = parser.parse(screenshot_path, 0, 0, 0, 0)
        raw_elements = parsed[0] if isinstance(parsed, tuple) and parsed else []
    elements = []
    for index, element in enumerate(raw_elements):
        label = None
        bbox = None
        interactable = None
        if isinstance(element, dict):
            label = element.get("label") or element.get("content")
            bbox = element.get("bbox") or element.get("box")
            interactable = element.get("interactable")
        elif hasattr(element, "label"):
            label = getattr(element, "label", None)
            bbox = getattr(element, "bbox", None) or getattr(element, "box", None)
        if bbox is None or len(bbox) < 4:
            continue
        entry = {
            "id": str(index),
            "role": "screen_element",
            "frame": _frame(bbox),
        }
        if label:
            entry["label"] = str(label)
        if interactable is not None:
            entry["interactable"] = bool(interactable)
        elements.append(entry)
    return {"elements": elements, "source": source, "parsed": len(elements)}


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("probe")
    parse_parser = subparsers.add_parser("parse")
    parse_parser.add_argument("--screenshot", required=True)
    args = parser.parse_args()
    try:
        if args.command == "probe":
            parser, source = _load_parser()
            print(json.dumps({"ok": True, "detail": f"OmniParser V2 ready ({source})"}))
            return
        result = parse(args.screenshot)
        print(json.dumps(result))
    except Exception as error:  # pragma: no cover - diagnostic path
        print(json.dumps({"error": str(error), "trace": traceback.format_exc()[-400:]}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
