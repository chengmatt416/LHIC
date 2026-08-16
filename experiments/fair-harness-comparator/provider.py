#!/usr/bin/env python3
import argparse, hashlib, json, re, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

USAGE = {
    "input_tokens": 0,
    "input_tokens_details": {"cached_tokens": 0},
    "output_tokens": 0,
    "output_tokens_details": {"reasoning_tokens": 0},
    "total_tokens": 0,
}
MARKER_RE = re.compile(r"FAIR_EFFECT_RESULT\s+(\{[^\r\n]*\})")
EXIT17_RE = re.compile(r"exited with code\s+17", re.IGNORECASE)

def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

class State:
    def __init__(self, log_path: Path, plan_path: Path):
        self.log_path = log_path
        self.plan_path = plan_path
        self.plan = json.loads(plan_path.read_text(encoding="utf-8"))
        self.plan_sha256 = sha256_file(plan_path)
        self.request_index = 0
        self.tool_name = None
        self.arg_name = None
        self.issued = 0
        self.invalid = False
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
            f"data: {json.dumps(event, separators=(',', ':'))}\n\n" for event in events
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

    def _tool_call(self, proposal):
        args = json.dumps({self.shared.arg_name: proposal["command"]}, separators=(",", ":"))
        ordinal = proposal["ordinal"]
        return {
            "type": "function_call",
            "id": f"fc-fair-{ordinal}",
            "status": "completed",
            "call_id": f"fair-call-{ordinal}",
            "name": self.shared.tool_name,
            "arguments": args,
        }

    @staticmethod
    def _message(text):
        return {
            "type": "message",
            "id": "msg-fair-final",
            "status": "completed",
            "role": "assistant",
            "content": [{
                "type": "output_text",
                "text": text,
                "annotations": [],
                "logprobs": [],
            }],
        }

    def _respond_item(self, item, ordinal):
        rid = f"resp-fair-{int(time.time() * 1000)}-{ordinal}"
        events = [
            {"type": "response.created", "sequence_number": 0,
             "response": self._metadata(rid, "in_progress", [])},
            {"type": "response.output_item.done", "sequence_number": 1,
             "output_index": 0, "item": item},
            {"type": "response.completed", "sequence_number": 2,
             "response": self._metadata(rid, "completed", [item], USAGE)},
        ]
        self._send_events(events)

    def _extract_observed(self, req, proposal):
        call_id = f"fair-call-{proposal['ordinal']}"
        call = None
        output = None
        for item in req.get("input", []) or []:
            if item.get("type") == "function_call" and item.get("call_id") == call_id:
                call = item
            elif item.get("type") == "function_call_output" and item.get("call_id") == call_id:
                output = str(item.get("output", ""))
        reasons = []
        observed_command = None
        if call is None:
            reasons.append("missing_function_call_history")
        else:
            try:
                args = json.loads(call.get("arguments", "{}"))
                observed_command = args.get(self.shared.arg_name)
            except Exception:
                reasons.append("invalid_function_call_arguments")
            if call.get("name") != self.shared.tool_name:
                reasons.append("tool_name_changed")
            if observed_command != proposal["command"]:
                reasons.append("command_mismatch")
        marker = None
        if output is None:
            reasons.append("missing_function_call_output")
        else:
            m = MARKER_RE.search(output)
            if not m:
                reasons.append("missing_effect_marker")
            else:
                try:
                    marker = json.loads(m.group(1))
                except Exception:
                    reasons.append("invalid_effect_marker_json")
        if marker is not None:
            if marker.get("logicalActionId") != proposal["logicalActionId"]:
                reasons.append("logical_action_id_mismatch")
            if marker.get("mode") != self.shared.plan["effectMode"]:
                reasons.append("effect_mode_mismatch")
            if marker.get("downstreamIdempotency") != self.shared.plan["downstreamIdempotency"]:
                reasons.append("downstream_idempotency_mismatch")
        if self.shared.plan["effectMode"] == "post_commit_error":
            if output is None or not EXIT17_RE.search(output):
                reasons.append("missing_harness_exit17_signal")
        return {
            "valid": not reasons,
            "reasons": reasons,
            "callId": call_id,
            "observedCommand": observed_command,
            "expectedCommand": proposal["command"],
            "output": output,
            "marker": marker,
        }

    def do_GET(self):
        if self.path.rstrip("/").endswith("models"):
            body = {"object": "list", "data": [{
                "id": "gpt-5.2", "object": "model", "created": 0, "owned_by": "lhic-fair-comparator"
            }]}
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

        proposals = self.shared.plan["proposals"]
        if self.shared.issued == 0:
            name, arg_name = self._tool_from_request(req)
            self.shared.tool_name, self.shared.arg_name = name, arg_name
            if not name:
                self.shared.invalid = True
                self.shared.log({"event": "fixture_invalid", "reason": "no_supported_shell_tool"})
                self._respond_item(self._message("FAIR_FIXTURE_INVALID"), idx)
                return
            proposal = proposals[0]
            self.shared.issued = 1
            self.shared.log({
                "event": "issued_tool_call", "ordinal": 1, "tool": name,
                "argument": arg_name, "logicalActionId": proposal["logicalActionId"],
                "command": proposal["command"], "commandSha256": proposal["commandSha256"],
            })
            self._respond_item(self._tool_call(proposal), idx)
            return

        previous = proposals[self.shared.issued - 1]
        observed = self._extract_observed(req, previous)
        self.shared.log({"event": "observed_tool_result", "ordinal": previous["ordinal"], **observed})
        if not observed["valid"]:
            self.shared.invalid = True
            self.shared.log({"event": "fixture_invalid", "reason": "observed_tool_result_invalid", "details": observed["reasons"]})
            self._respond_item(self._message("FAIR_FIXTURE_INVALID"), idx)
            return

        if self.shared.issued < len(proposals):
            proposal = proposals[self.shared.issued]
            self.shared.issued += 1
            self.shared.log({
                "event": "issued_tool_call", "ordinal": proposal["ordinal"],
                "tool": self.shared.tool_name, "argument": self.shared.arg_name,
                "logicalActionId": proposal["logicalActionId"], "command": proposal["command"],
                "commandSha256": proposal["commandSha256"], "retryReason": "validated_exit_17",
            })
            self._respond_item(self._tool_call(proposal), idx)
            return

        self.shared.log({"event": "fixture_complete", "valid": not self.shared.invalid,
                         "issuedProposals": self.shared.issued, "planSha256": self.shared.plan_sha256})
        self._respond_item(self._message("FAIR_COMPARATOR_DONE"), idx)

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--plan", required=True)
    args = ap.parse_args()
    log = Path(args.log)
    log.parent.mkdir(parents=True, exist_ok=True)
    state = State(log, Path(args.plan))
    Handler.shared = state
    state.log({"event": "server_start", "plan": str(state.plan_path), "planSha256": state.plan_sha256,
               "condition": state.plan["condition"], "trial": state.plan["trial"],
               "proposals": state.plan["proposals"]})
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"fair comparator provider listening on {args.port}", flush=True)
    server.serve_forever()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
