#!/usr/bin/env python3
"""Fake omp RPC engine for deterministic client tests.

Reads newline-delimited JSON commands from stdin, then emits a response
sequence chosen by the FAKE_MODE environment variable:

  ready           emit ready frame, then echo responses with id.
  reverse2        read 2 commands, reply in reverse order.
  flood           emit 400 event frames, then reply to the command.
  close           read 1 command, exit without replying.
  unknown_id      emit a response for an unregistered id.
  stale_chunk     emit chunk 0 of 2, then stall forever.
  interrupted     chunk 0, normal event, chunk 1.
  prompt_hang     reply prompt ack agentInvoked=true, then stall.
  ui_request      emit extension_ui_request after ready, then echo.

Command-response replies echo the request id and type.
"""
import json
import os
import sys
import time

mode = os.environ.get("FAKE_MODE", "ready")


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def read_commands(n):
    out = []
    while len(out) < n:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        out.append(json.loads(line))
    return out


def response_for(cmd, success=True, error=None, code=None, extra=None):
    payload = {
        "type": "response",
        "id": cmd.get("id"),
        "command": cmd.get("type", "?"),
        "success": success,
    }
    if error is not None:
        payload["error"] = error
    if code is not None:
        payload["code"] = code
    if extra is not None:
        payload["data"] = extra
    return payload


# Startup: always emit ready first (v1 shape). negotiated_cap mode
# advertises a small reassembly ceiling to test cap enforcement.
ready = {
    "type": "ready",
    "protocolVersion": 1,
    "supportedProtocolVersions": [1, 2],
    "maxFrameBytes": 1048576,
    "maxReassembledFrameBytes": 67108864,
}
if mode == "negotiated_cap":
    ready["maxReassembledFrameBytes"] = 8192  # 8 KiB ceiling
emit(ready)

# The client always negotiates v2 right after ready; answer before the
# The client always negotiates v2 right after ready; answer it.
negotiate = read_commands(1)
if negotiate and negotiate[0].get("type") == "negotiate_protocol":
    emit(
        {
            "type": "response",
            "id": negotiate[0].get("id"),
            "command": "negotiate_protocol",
            "success": True,
            "data": {"protocolVersion": 2},
        }
    )
else:
    # Unexpected first command: answer generically so the client handshake
    # still completes, then continue.
    if negotiate:
        emit(response_for(negotiate[0]))

if mode == "never_answer":
    # Handshake completed above; consume commands without ever replying so
    # the client's pending map is cleaned up by cancelled futures.
    while True:
        line = sys.stdin.readline()
        if not line:
            break
    sys.exit(0)

if mode == "reverse2":
    cmds = read_commands(2)
    if len(cmds) == 2:
        emit(response_for(cmds[1]))
        emit(response_for(cmds[0]))
    sys.exit(0)

if mode == "flood":
    cmd = read_commands(1)[0]
    for i in range(400):
        emit({"type": "notice", "index": i, "text": "x" * 64})
    emit(response_for(cmd))
    sys.exit(0)

if mode == "close":
    cmd = read_commands(1)
    sys.exit(0)

if mode == "unknown_success":
    # Emit a successful response for an unregistered id.
    emit(
        {
            "type": "response",
            "id": "req_777",
            "command": "get_state",
            "success": True,
            "data": {"model": {"id": "fake"}},
        }
    )
    sys.exit(0)

if mode == "unknown_id":
    # Emit a response for an unregistered id immediately.
    emit(
        {
            "type": "response",
            "id": "req_999",
            "command": "prompt",
            "success": False,
            "error": "async scheduling failed",
            "code": "scheduling_failed",
        }
    )
    sys.exit(0)

if mode == "stale_chunk":
    # Emit chunk 0 immediately (no command needed); the client's stale timer
    # must reject the incomplete sequence.
    payload = json.dumps({"type": "response", "id": "req_big", "success": True}).encode()
    half = len(payload) // 2
    import base64

    emit(
        {
            "type": "rpc_chunk",
            "chunkId": "rpc-1",
            "index": 0,
            "count": 2,
            "byteLength": len(payload),
            "data": base64.b64encode(payload[:half]).decode(),
        }
    )
    # stall forever
    time.sleep(3600)

if mode == "interrupted":
    # Emit immediately: the interruption occurs while the client waits for a
    # command response, but this fake does not need the command content.
    payload = json.dumps({"type": "response", "id": "req_big", "success": True}).encode()
    half = len(payload) // 2
    import base64

    emit(
        {
            "type": "rpc_chunk",
            "chunkId": "rpc-1",
            "index": 0,
            "count": 2,
            "byteLength": len(payload),
            "data": base64.b64encode(payload[:half]).decode(),
        }
    )
    emit({"type": "notice", "text": "interrupting frame"})
    emit(
        {
            "type": "rpc_chunk",
            "chunkId": "rpc-1",
            "index": 1,
            "count": 2,
            "byteLength": len(payload),
            "data": base64.b64encode(payload[half:]).decode(),
        }
    )
    # Exit immediately so the reader sees EOF and drains the event queue;
    # the interruption error was already emitted before the pipe closed.
    sys.exit(0)

if mode == "prompt_hang":
    cmd = read_commands(1)[0]
    emit(
        {
            "type": "response",
            "id": cmd.get("id"),
            "command": "prompt",
            "success": True,
            "data": {"agentInvoked": True},
        }
    )
    time.sleep(3600)

if mode == "flood_turn_end":
    cmd = read_commands(1)[0]
    emit(
        {
            "type": "response",
            "id": cmd.get("id"),
            "command": "prompt",
            "success": True,
            "data": {"agentInvoked": True},
        }
    )
    for i in range(400):
        emit({"type": "notice", "index": i, "text": "x" * 64})
    emit({"type": "turn_end", "message": {"role": "assistant"}})
    sys.exit(0)

if mode == "flood_agent_end":
    cmd = read_commands(1)[0]
    emit(
        {
            "type": "response",
            "id": cmd.get("id"),
            "command": "prompt",
            "success": True,
            "data": {"agentInvoked": True},
        }
    )
    for i in range(400):
        emit({"type": "notice", "index": i, "text": "x" * 64})
    emit({"type": "agent_end", "messages": [], "isTerminal": True})
    sys.exit(0)

if mode == "prompt_ack_then_fail":
    cmd = read_commands(1)[0]
    emit(
        {
            "type": "response",
            "id": cmd.get("id"),
            "command": "prompt",
            "success": True,
            "data": {"agentInvoked": True},
        }
    )
    emit(
        {
            "type": "response",
            "id": cmd.get("id"),
            "command": "prompt",
            "success": False,
            "code": "scheduling_failed",
            "error": "async scheduling failed",
        }
    )
    sys.exit(0)

if mode == "never_answer":
    # Consume commands without ever replying; the client's pending map must
    # be cleaned up by cancelled futures, not by responses.
    while True:
        line = sys.stdin.readline()
        if not line:
            break
    sys.exit(0)

if mode == "negotiated_cap":
    # Ready advertises an 8 KiB ceiling; send a 16 KiB logical frame that
    # must be rejected before complete reassembly.
    payload = json.dumps(
        {"type": "response", "id": "req_big", "success": True, "data": {"blob": "x" * 16384}}
    ).encode()
    half = len(payload) // 2
    import base64

    emit(
        {
            "type": "rpc_chunk",
            "chunkId": "rpc-1",
            "index": 0,
            "count": 2,
            "byteLength": len(payload),
            "data": base64.b64encode(payload[:half]).decode(),
        }
    )
    emit(
        {
            "type": "rpc_chunk",
            "chunkId": "rpc-1",
            "index": 1,
            "count": 2,
            "byteLength": len(payload),
            "data": base64.b64encode(payload[half:]).decode(),
        }
    )
    sys.exit(0)

if mode == "ui_request":
    emit(
        {
            "type": "extension_ui_request",
            "id": "ui_7",
            "method": "confirm",
            "title": "Confirm",
            "message": "Continue?",
        }
    )
    read_commands(1)
    sys.exit(0)

# Default "ready" mode: echo each command with its response.
for cmd in read_commands(1024):
    if cmd.get("type") == "negotiate_protocol":
        emit(
            {
                "type": "response",
                "id": cmd.get("id"),
                "command": "negotiate_protocol",
                "success": True,
                "data": {"protocolVersion": 2},
            }
        )
    else:
        emit(response_for(cmd))
