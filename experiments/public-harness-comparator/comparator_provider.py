#!/usr/bin/env python3
import argparse
import json
import shlex
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

USAGE = {
    "input_tokens": 0,
    "input_tokens_details": {"cached_tokens": 0},
    "output_tokens": 0,
    "output_tokens_details": {"reasoning_tokens": 0},
    "total_tokens": 0,
}


class State:
    def __init__(self, log_path: Path, command: str, retry_after_first_result: bool):
        self.log_path = log_path
        self.command = command
        self.retry_after_first_result = retry_after_first_result
        self.request_index = 0
        self.tool_name = None
        self.arg_name = None
        self.lock = threading.Lock()

    def log(self, payload):
        with self.lock:
            with self.log_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def next_request(self):
        with self.lock:
            self.request_index += 1
            return self.request_index


class Handler(BaseHTTPRequestHandler):
    shared: State

    def log_message(self, fmt, *args):
        return

    @staticmethod
    def _metadata(rid, status, output, usage=None):
        result = {
            "id": rid,
            "object": "response",
            "created_at": int(time.time()),
            "status": status,
            "model": "gpt-5.2",
            "output": output,
        }
        if usage is not None:
            result["usage"] = usage
        return result

    def _send_events(self, events):
        raw = "".join(
            f"data: {json.dumps(event, separators=(',', ':'))}\n\n"
            for event in events
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _tool_from_request(self, req):
        for tool in req.get("tools", []) or []:
            name = tool.get("name") or (tool.get("function") or {}).get("name")
            params = tool.get("parameters") or (tool.get("function") or {}).get("parameters") or {}
            props = params.get("properties", {}) or {}
            if name == "exec_command" and "cmd" in props:
                return "exec_command", "cmd"
            if name == "shell" and "command" in props:
                return "shell", "command"
        return None, None

    def _tool_call(self, ordinal):
        name = self.shared.tool_name
        arg_name = self.shared.arg_name
        args = json.dumps({arg_name: self.shared.command}, separators=(",", ":"))
        return {
            "type": "function_call",
            "id": f"fc-{ordinal}",
            "status": "completed",
            "call_id": f"call-{ordinal}",
            "name": name,
            "arguments": args,
        }

    @staticmethod
    def _message(text):
        return {
            "type": "message",
            "id": "msg-final",
            "status": "completed",
            "role": "assistant",
            "content": [
                {
                    "type": "output_text",
                    "text": text,
                    "annotations": [],
                    "logprobs": [],
                }
            ],
        }

    def _respond_item(self, item, ordinal):
        rid = f"resp-{int(time.time() * 1000)}-{ordinal}"
        events = [
            {
                "type": "response.created",
                "sequence_number": 0,
                "response": self._metadata(rid, "in_progress", []),
            },
            {
                "type": "response.output_item.done",
                "sequence_number": 1,
                "output_index": 0,
                "item": item,
            },
            {
                "type": "response.completed",
                "sequence_number": 2,
                "response": self._metadata(rid, "completed", [item], USAGE),
            },
        ]
        self._send_events(events)

    def do_GET(self):
        if self.path.rstrip("/").endswith("models"):
            body = {
                "object": "list",
                "data": [
                    {
                        "id": "gpt-5.2",
                        "object": "model",
                        "created": 0,
                        "owned_by": "lhic-comparator",
                    }
                ],
            }
            raw = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        self.send_error(404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(n)
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            req = {"_raw": raw.decode("utf-8", "replace")}
        idx = self.shared.next_request()
        self.shared.log({"event": "request", "requestIndex": idx, "path": self.path, "body": req})

        if not self.path.rstrip("/").endswith("responses"):
            self.send_error(404)
            return

        if idx == 1:
            name, arg_name = self._tool_from_request(req)
            self.shared.tool_name = name
            self.shared.arg_name = arg_name
            if not name:
                self.shared.log({"event": "error", "reason": "no_supported_shell_tool"})
                self._respond_item(self._message("NO_SUPPORTED_SHELL_TOOL"), idx)
                return
            item = self._tool_call(1)
            self.shared.log(
                {
                    "event": "issued_tool_call",
                    "ordinal": 1,
                    "tool": name,
                    "argument": arg_name,
                    "command": self.shared.command,
                }
            )
            self._respond_item(item, idx)
            return

        if idx == 2 and self.shared.retry_after_first_result:
            item = self._tool_call(2)
            self.shared.log(
                {
                    "event": "issued_tool_call",
                    "ordinal": 2,
                    "tool": self.shared.tool_name,
                    "argument": self.shared.arg_name,
                    "command": self.shared.command,
                }
            )
            self._respond_item(item, idx)
            return

        self.shared.log({"event": "issued_final", "requestIndex": idx})
        self._respond_item(self._message("COMPARATOR_DONE"), idx)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--effect-script", required=True)
    ap.add_argument("--effect-mode", choices=["success", "post_commit_error"], required=True)
    ap.add_argument("--retry-after-first-result", action="store_true")
    args = ap.parse_args()

    command = " ".join(
        [
            "python3",
            shlex.quote(str(Path(args.effect_script).resolve())),
            "--state",
            shlex.quote(str(Path(args.state).resolve())),
            "--mode",
            shlex.quote(args.effect_mode),
        ]
    )
    state = State(Path(args.log), command, args.retry_after_first_result)
    Handler.shared = state
    state.log(
        {
            "event": "server_start",
            "command": command,
            "retryAfterFirstResult": args.retry_after_first_result,
        }
    )
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"comparator provider listening on {args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
