#!/usr/bin/env python3
import argparse
import json
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

class Handler(BaseHTTPRequestHandler):
    log_path: Path

    def _log(self, payload):
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        if self.path.rstrip("/").endswith("models"):
            body = {
                "object": "list",
                "data": [{"id": "gpt-5.2", "object": "model", "created": 0, "owned_by": "lhic-mock"}],
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
        self._log({"path": self.path, "headers": dict(self.headers), "body": req})
        if self.path.rstrip("/").endswith("responses"):
            self._responses_probe()
        elif self.path.rstrip("/").endswith("chat/completions"):
            self._chat_probe(req)
        else:
            self.send_error(404)

    def _responses_probe(self):
        rid = f"resp-{int(time.time() * 1000)}"
        events = [
            {"type": "response.created", "response": {"id": rid}},
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "id": "msg-probe",
                    "content": [{"type": "output_text", "text": "PROBE_OK"}],
                },
            },
            {"type": "response.completed", "response": {"id": rid, "usage": USAGE}},
        ]
        body = "".join(f"data: {json.dumps(e, separators=(',', ':'))}\n\n" for e in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _chat_probe(self, req):
        if req.get("stream"):
            cid = f"chatcmpl-{int(time.time() * 1000)}"
            chunks = [
                {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": "gpt-5.2",
                    "choices": [{"index": 0, "delta": {"role": "assistant", "content": "PROBE_OK"}, "finish_reason": None}],
                },
                {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": "gpt-5.2",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                },
            ]
            body = "".join(f"data: {json.dumps(c, separators=(',', ':'))}\n\n" for c in chunks) + "data: [DONE]\n\n"
            raw = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        else:
            body = {
                "id": "chatcmpl-probe",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": "gpt-5.2",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "PROBE_OK"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
            raw = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--log", required=True)
    args = ap.parse_args()
    Handler.log_path = Path(args.log)
    Handler.log_path.parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"mock provider listening on {args.port}", flush=True)
    server.serve_forever()

if __name__ == "__main__":
    main()
