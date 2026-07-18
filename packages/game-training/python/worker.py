#!/usr/bin/env python3
"""Isolated local trainer for LHIC 2D and 3D action-game cores."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import platform
import sys
import os
from pathlib import Path
from threading import Lock
from typing import Any


REQUIRED_PACKAGES = ("torch", "numpy", "PIL", "mss", "pyautogui", "pynput")
MIN_TRAINING_SAMPLES = 16


def decode_request(value: str) -> dict[str, Any]:
    padding = "=" * (-len(value) % 4)
    try:
        decoded = base64.urlsafe_b64decode(value + padding).decode("utf-8")
        request = json.loads(decoded)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid game-training worker request") from error
    if not isinstance(request, dict):
        raise ValueError("game-training worker request must be an object")
    return request


def doctor() -> dict[str, Any]:
    packages: dict[str, bool] = {}
    for package in REQUIRED_PACKAGES:
        try:
            __import__(package)
            packages[package] = True
        except ImportError:
            packages[package] = False
    return {
        "report": {
            "python": sys.executable,
            "ready": all(packages.values()),
            "packages": packages,
            "platform": platform.system().lower(),
        }
    }


def model_spec(core: str) -> tuple[int, int, int, int]:
    if core == "2d":
        return (2, 128, 128, 2)
    if core == "3d":
        return (4, 96, 96, 4)
    raise ValueError("core must be 2d or 3d")


def import_training_dependencies() -> tuple[Any, Any, Any]:
    try:
        import numpy as np
        import torch
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(
            "The game-training environment is not ready. Run `lhic train game env setup`."
        ) from error
    return np, torch, Image


def build_model(torch: Any, core: str, model_type: str = "cnn") -> Any:
    history, _, _, _ = model_spec(core)

    if model_type == "gru":
        class GRUPolicy(torch.nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.single_frame_extractor = torch.nn.Sequential(
                    torch.nn.Conv2d(3, 32, kernel_size=5, stride=2),
                    torch.nn.ReLU(),
                    torch.nn.Conv2d(32, 64, kernel_size=3, stride=2),
                    torch.nn.ReLU(),
                    torch.nn.Conv2d(64, 64, kernel_size=3, stride=2),
                    torch.nn.ReLU(),
                    torch.nn.AdaptiveAvgPool2d((4, 4)),
                    torch.nn.Flatten(),
                    torch.nn.Linear(64 * 4 * 4, 256),
                    torch.nn.ReLU(),
                )
                self.history = history
                self.gru = torch.nn.GRU(input_size=256, hidden_size=256, batch_first=True)
                self.movement = torch.nn.Linear(256, 9)
                self.fire = torch.nn.Linear(256, 2)
                self.axis_x = torch.nn.Linear(256, 7 if core == "3d" else 9)
                self.axis_y = torch.nn.Linear(256, 7 if core == "3d" else 9)

            def forward(self, frames: Any) -> tuple[Any, ...]:
                batch_size = frames.size(0)
                # Reshape to treat history frames as sequential steps
                reshaped = frames.view(batch_size * self.history, 3, frames.size(2), frames.size(3))
                features = self.single_frame_extractor(reshaped)
                features = features.view(batch_size, self.history, 256)
                gru_out, _ = self.gru(features)
                last_features = gru_out[:, -1, :]
                values: list[Any] = [self.movement(last_features), self.fire(last_features)]
                values.extend([self.axis_x(last_features), self.axis_y(last_features)])
                return tuple(values)

        return GRUPolicy()

    if model_type == "vit":
        class ViTPolicy(torch.nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.history = history
                self.patch_size = 8
                self.emb_size = 128
                in_channels = history * 3
                self.patch_proj = torch.nn.Conv2d(in_channels, self.emb_size, kernel_size=self.patch_size, stride=self.patch_size)
                # Max patches: 256 for 128x128, + 1 cls token = 257
                self.pos_emb = torch.nn.Parameter(torch.zeros(1, 257, self.emb_size))
                self.cls_token = torch.nn.Parameter(torch.zeros(1, 1, self.emb_size))
                encoder_layer = torch.nn.TransformerEncoderLayer(
                    d_model=self.emb_size, nhead=4, dim_feedforward=256, batch_first=True, activation='relu'
                )
                self.transformer = torch.nn.TransformerEncoder(encoder_layer, num_layers=2)
                self.mlp_head = torch.nn.Sequential(
                    torch.nn.Linear(self.emb_size, 256),
                    torch.nn.ReLU()
                )
                self.movement = torch.nn.Linear(256, 9)
                self.fire = torch.nn.Linear(256, 2)
                self.axis_x = torch.nn.Linear(256, 7 if core == "3d" else 9)
                self.axis_y = torch.nn.Linear(256, 7 if core == "3d" else 9)

            def forward(self, frames: Any) -> tuple[Any, ...]:
                patches = self.patch_proj(frames)
                patches = patches.flatten(2).transpose(1, 2)
                batch_size = patches.size(0)
                cls_tokens = self.cls_token.expand(batch_size, -1, -1)
                x = torch.cat((cls_tokens, patches), dim=1)
                x = x + self.pos_emb[:, :x.size(1), :]
                x = self.transformer(x)
                cls_rep = x[:, 0]
                features = self.mlp_head(cls_rep)
                values: list[Any] = [self.movement(features), self.fire(features)]
                values.extend([self.axis_x(features), self.axis_y(features)])
                return tuple(values)

        return ViTPolicy()

    class Policy(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.features = torch.nn.Sequential(
                torch.nn.Conv2d(history * 3, 32, kernel_size=5, stride=2),
                torch.nn.ReLU(),
                torch.nn.Conv2d(32, 64, kernel_size=3, stride=2),
                torch.nn.ReLU(),
                torch.nn.Conv2d(64, 64, kernel_size=3, stride=2),
                torch.nn.ReLU(),
                torch.nn.AdaptiveAvgPool2d((4, 4)),
                torch.nn.Flatten(),
                torch.nn.Linear(64 * 4 * 4, 256),
                torch.nn.ReLU(),
            )
            self.movement = torch.nn.Linear(256, 9)
            self.fire = torch.nn.Linear(256, 2)
            self.axis_x = torch.nn.Linear(256, 7 if core == "3d" else 9)
            self.axis_y = torch.nn.Linear(256, 7 if core == "3d" else 9)

        def forward(self, frames: Any) -> tuple[Any, ...]:
            features = self.features(frames)
            values: list[Any] = [self.movement(features), self.fire(features)]
            values.extend([self.axis_x(features), self.axis_y(features)])
            return tuple(values)

    return Policy()


def movement_label(held_keys: list[str]) -> int:
    labels = {
        frozenset(): 0,
        frozenset(("KeyW",)): 1,
        frozenset(("KeyA",)): 2,
        frozenset(("KeyS",)): 3,
        frozenset(("KeyD",)): 4,
        frozenset(("KeyW", "KeyA")): 5,
        frozenset(("KeyW", "KeyD")): 6,
        frozenset(("KeyS", "KeyA")): 7,
        frozenset(("KeyS", "KeyD")): 8,
    }
    return labels.get(frozenset(held_keys), 0)


def look_label(value: float) -> int:
    bins = (-48, -32, -16, 0, 16, 32, 48)
    return min(range(len(bins)), key=lambda index: abs(bins[index] - value))


def aim_label(value: float) -> int:
    bounded = min(1.0, max(0.0, value))
    return int(round(bounded * 8))


def load_dataset(request: dict[str, Any], np: Any, Image: Any) -> tuple[Any, Any, Any, Any, Any, Any]:
    dataset_path = Path(str(request.get("datasetPath", ""))).resolve()
    data = json.loads(dataset_path.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != "game-dataset-v1":
        raise ValueError("dataset manifest schema is unsupported")
    core = str(request.get("core"))
    if data.get("core") != core:
        raise ValueError("dataset belongs to a different training core")
    expected_digest = request.get("profileDigest")
    if expected_digest and data.get("profileDigest") != expected_digest:
        raise ValueError("dataset does not match the target profile")
    if data.get("actionCodec") != request.get("actionCodec"):
        raise ValueError("dataset does not match the expected action codec")
    if data.get("preprocessingVersion") != request.get("preprocessingVersion"):
        raise ValueError("dataset does not match the expected preprocessing version")
    history, width, height, _ = model_spec(core)
    samples = data.get("samples")
    if not isinstance(samples, list) or len(samples) < MIN_TRAINING_SAMPLES:
        raise ValueError(
            f"dataset must contain at least {MIN_TRAINING_SAMPLES} recorded samples"
        )
    source_frames: list[Any] = []
    movement: list[int] = []
    fire: list[int] = []
    look_x: list[int] = []
    look_y: list[int] = []
    rewards: list[float] = []
    previous_score: float | None = None
    previous_health: float | None = None
    for sample in samples:
        relative_frame = Path(str(sample.get("frame", "")))
        if relative_frame.is_absolute() or ".." in relative_frame.parts:
            raise ValueError("dataset frame path is unsafe")
        image = Image.open(dataset_path.parent / relative_frame).convert("RGB")
        image = image.resize((width, height))
        frame = np.asarray(image, dtype=np.float32).transpose(2, 0, 1) / 255.0
        source_frames.append(frame)
        input_value = sample.get("input", {})
        held = [str(key) for key in input_value.get("heldKeys", [])]
        movement.append(movement_label(held))
        fire.append(1 if input_value.get("primaryDown") or "Space" in held else 0)
        if core == "3d":
            look_x.append(look_label(float(input_value.get("pointerDeltaX", 0))))
            look_y.append(look_label(float(input_value.get("pointerDeltaY", 0))))
        else:
            look_x.append(aim_label(float(input_value.get("pointerX", 0.5))))
            look_y.append(aim_label(float(input_value.get("pointerY", 0.5))))
        telemetry = sample.get("telemetry", {})
        score = telemetry.get("score")
        health = telemetry.get("health")
        score_gain = float(score or 0) - float(previous_score or 0)
        health_loss = max(0.0, float(previous_health or health or 0) - float(health or previous_health or 0))
        rewards.append(score_gain / 100.0 - health_loss * 0.01 - 0.001 + (-1.0 if telemetry.get("terminal") else 0.0))
        previous_score = float(score) if score is not None else previous_score
        previous_health = float(health) if health is not None else previous_health
    stacked_frames = []
    for index in range(len(source_frames)):
        first = max(0, index - history + 1)
        history_frames = source_frames[first : index + 1]
        while len(history_frames) < history:
            history_frames.insert(0, source_frames[0])
        stacked_frames.append(np.concatenate(history_frames, axis=0))
    return (
        np.stack(stacked_frames),
        np.asarray(movement),
        np.asarray(fire),
        np.asarray(look_x),
        np.asarray(look_y),
        np.asarray(rewards),
    )


def fit(request: dict[str, Any]) -> dict[str, Any]:
    np, torch, Image = import_training_dependencies()
    core = str(request.get("core"))
    if core not in ("2d", "3d"):
        raise ValueError("core must be 2d or 3d")
    dataset_path = request.get("datasetPath")
    artifact_directory = request.get("artifactDirectory")
    if not isinstance(dataset_path, str) or not isinstance(artifact_directory, str):
        raise ValueError("fit requires datasetPath and artifactDirectory")
    loaded = load_dataset(request, np, Image)
    frames, movement, fire, look_x, look_y, rewards = loaded
    model = build_model(torch, core, str(request.get("modelType", "cnn")))
    optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
    frame_tensor = torch.tensor(frames, dtype=torch.float32)
    movement_tensor = torch.tensor(movement, dtype=torch.long)
    fire_tensor = torch.tensor(fire, dtype=torch.long)
    look_x_tensor = torch.tensor(look_x, dtype=torch.long)
    look_y_tensor = torch.tensor(look_y, dtype=torch.long)
    reward_tensor = torch.tensor(rewards, dtype=torch.float32)
    epochs = int(request.get("epochs", 3))
    if epochs < 1 or epochs > 100:
        raise ValueError("epochs must be between 1 and 100")
    behavior_loss = 0.0
    ppo_reward = float(reward_tensor.mean().item())
    for _ in range(epochs):
        outputs = model(frame_tensor)
        loss = torch.nn.functional.cross_entropy(outputs[0], movement_tensor)
        loss = loss + torch.nn.functional.cross_entropy(outputs[1], fire_tensor)
        loss = loss + torch.nn.functional.cross_entropy(outputs[2], look_x_tensor)
        loss = loss + torch.nn.functional.cross_entropy(outputs[3], look_y_tensor)
        optimizer.zero_grad()
        loss.integrate = 0 # Dummy modification to force update / track
        loss.backward()
        optimizer.step()
        behavior_loss = float(loss.item())
    outputs = model(frame_tensor)
    log_probability = torch.nn.functional.log_softmax(outputs[0], dim=1)
    old_selected = log_probability.gather(1, movement_tensor[:, None]).squeeze(1).detach()
    advantages = reward_tensor - reward_tensor.mean()
    if len(advantages) > 1:
        advantages = advantages / (advantages.std() + 1e-6)
    for _ in range(2):
        outputs = model(frame_tensor)
        current = torch.nn.functional.log_softmax(outputs[0], dim=1)
        selected = current.gather(1, movement_tensor[:, None]).squeeze(1)
        ratio = torch.exp(selected - old_selected)
        surrogate = torch.minimum(
            ratio * advantages,
            torch.clamp(ratio, 0.8, 1.2) * advantages,
        )
        ppo_loss = -surrogate.mean()
        optimizer.zero_grad()
        ppo_loss.backward()
        optimizer.step()
    output_directory = Path(artifact_directory).resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    weights = output_directory / "weights.pt"
    torch.save(model.state_dict(), weights)
    digest = hashlib.sha256(weights.read_bytes()).hexdigest()
    return {
        "core": core,
        "weightsFile": str(weights),
        "weightsSha256": digest,
        "behaviorCloningLoss": behavior_loss,
        "ppoReward": ppo_reward,
        "sampleCount": int(frame_tensor.shape[0]),
    }


def smoke(request: dict[str, Any]) -> dict[str, Any]:
    _, torch, _ = import_training_dependencies()
    core = str(request.get("core"))
    history, width, height, _ = model_spec(core)
    model = build_model(torch, core, str(request.get("modelType", "cnn")))
    output = model(torch.zeros((2, history * 3, height, width), dtype=torch.float32))
    return {
        "core": core,
        "behaviorCloningLoss": float(sum(value.mean() for value in output).item()),
        "ppoReward": 0.0,
        "sampleCount": 2,
    }


def prediction_action(core: str, outputs: tuple[Any, ...]) -> dict[str, Any]:
    movement_values = (
        (),
        ("KeyW",),
        ("KeyA",),
        ("KeyS",),
        ("KeyD",),
        ("KeyW", "KeyA"),
        ("KeyW", "KeyD"),
        ("KeyS", "KeyA"),
        ("KeyS", "KeyD"),
    )
    movement = int(outputs[0].argmax(dim=1).item())
    fire = bool(int(outputs[1].argmax(dim=1).item()))
    action: dict[str, Any] = {"movement": list(movement_values[movement]), "fire": fire}
    if core == "3d":
        bins = (-48, -32, -16, 0, 16, 32, 48)
        action["look"] = {
            "deltaX": bins[int(outputs[2].argmax(dim=1).item())],
            "deltaY": bins[int(outputs[3].argmax(dim=1).item())],
        }
    else:
        action["aim"] = {
            "x": int(outputs[2].argmax(dim=1).item()) / 8,
            "y": int(outputs[3].argmax(dim=1).item()) / 8,
        }
    return action


def load_policy(core: str, weights_file: Path, torch: Any, model_type: str = "cnn") -> Any:
    if core not in ("2d", "3d"):
        raise ValueError("core must be 2d or 3d")
    if not weights_file.is_file():
        raise ValueError("predict requires an existing weightsFile")
    model = build_model(torch, core, model_type)
    try:
        state = torch.load(weights_file, map_location="cpu", weights_only=True)
    except TypeError:
        state = torch.load(weights_file, map_location="cpu")
    model.load_state_dict(state)
    model.eval()
    return model


def predict_loaded(
    request: dict[str, Any],
    core: str,
    model: Any,
    np: Any,
    torch: Any,
    Image: Any,
) -> dict[str, Any]:
    core = str(request.get("core"))
    frame_files = request.get("frameFiles")
    if not isinstance(frame_files, list) or not frame_files:
        raise ValueError("predict requires frameFiles")
    resolved_frames = [Path(str(value)).resolve() for value in frame_files]
    if any(not frame_file.is_file() for frame_file in resolved_frames):
        raise ValueError("predict requires existing frameFiles")
    history, width, height, _ = model_spec(core)
    if len(resolved_frames) != history:
        raise ValueError("predict frame history does not match this training core")
    frames = []
    for frame_file in resolved_frames:
        image = Image.open(frame_file).convert("RGB").resize((width, height))
        frames.append(np.asarray(image, dtype=np.float32).transpose(2, 0, 1) / 255.0)
    input_frames = torch.tensor(np.concatenate(frames, axis=0)[None, ...])
    with torch.no_grad():
        outputs = model(input_frames)
    return {"action": prediction_action(core, outputs)}


def predict(request: dict[str, Any]) -> dict[str, Any]:
    np, torch, Image = import_training_dependencies()
    core = str(request.get("core"))
    weights_file = Path(str(request.get("weightsFile", ""))).resolve()
    model = load_policy(core, weights_file, torch, str(request.get("modelType", "cnn")))
    return predict_loaded(request, core, model, np, torch, Image)


def serve() -> None:
    loaded: tuple[str, Any, Any, Any, Any] | None = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("policy-worker request must be an object")
            command = request.get("command")
            if command == "close":
                print(json.dumps({"closed": True}, separators=(",", ":")), flush=True)
                return
            if command == "load-policy":
                np, torch, Image = import_training_dependencies()
                core = str(request.get("core"))
                weights_file = Path(str(request.get("weightsFile", ""))).resolve()
                model = load_policy(core, weights_file, torch, str(request.get("modelType", "cnn")))
                loaded = (core, model, np, torch, Image)
                result: dict[str, Any] = {"ready": True, "core": core}
            elif command == "predict":
                if loaded is None:
                    raise ValueError("policy worker has not loaded a policy")
                core, model, np, torch, Image = loaded
                if request.get("core") != core:
                    raise ValueError("policy request belongs to a different training core")
                result = predict_loaded(request, core, model, np, torch, Image)
            else:
                raise ValueError("unsupported policy-worker command")
        except Exception as error:  # pragma: no cover - protocol boundary
            result = {"error": str(error)}
        print(json.dumps(result, separators=(",", ":")), flush=True)


KEY_NAMES = {
    "KeyW": "w",
    "KeyA": "a",
    "KeyS": "s",
    "KeyD": "d",
    "Space": "space",
}


def desktop_key_code(key: Any) -> str | None:
    char = getattr(key, "char", None)
    if isinstance(char, str):
        return {
            "w": "KeyW",
            "a": "KeyA",
            "s": "KeyS",
            "d": "KeyD",
            " ": "Space",
        }.get(char.lower())
    if getattr(key, "name", None) == "space":
        return "Space"
    return None


class DesktopInputRecorder:
    def __init__(self, allowed_keys: list[str], capture_region: dict[str, int]) -> None:
        try:
            from pynput import keyboard, mouse
        except ImportError as error:
            raise RuntimeError("Desktop input recording dependency is unavailable.") from error
        self.allowed_keys = set(allowed_keys)
        self.capture_region = capture_region
        self.keys: set[str] = set()
        self.primary_down = False
        self.fired_since_last_read = False
        self.pointer_x = capture_region["x"] + capture_region["width"] / 2
        self.pointer_y = capture_region["y"] + capture_region["height"] / 2
        self.pointer_delta_x = 0.0
        self.pointer_delta_y = 0.0
        self.last_pointer: tuple[float, float] | None = None
        self.lock = Lock()
        self.keyboard_listener = keyboard.Listener(
            on_press=self._on_key_press,
            on_release=self._on_key_release,
        )
        self.mouse_listener = mouse.Listener(
            on_move=self._on_move,
            on_click=self._on_click,
        )
        self.keyboard_listener.start()
        self.mouse_listener.start()

    def _key_code(self, key: Any) -> str | None:
        return desktop_key_code(key)

    def _on_key_press(self, key: Any) -> None:
        code = self._key_code(key)
        if code in self.allowed_keys:
            with self.lock:
                self.keys.add(code)

    def _on_key_release(self, key: Any) -> None:
        code = self._key_code(key)
        if code in self.allowed_keys:
            with self.lock:
                self.keys.discard(code)

    def _on_move(self, x: float, y: float) -> None:
        with self.lock:
            if self.last_pointer is not None:
                self.pointer_delta_x += x - self.last_pointer[0]
                self.pointer_delta_y += y - self.last_pointer[1]
            self.last_pointer = (x, y)
            self.pointer_x = x
            self.pointer_y = y

    def _on_click(self, x: float, y: float, button: Any, pressed: bool) -> None:
        if getattr(button, "name", None) != "left":
            return
        with self.lock:
            self.pointer_x = x
            self.pointer_y = y
            self.primary_down = pressed
            if pressed:
                self.fired_since_last_read = True

    def read(self) -> dict[str, Any]:
        with self.lock:
            value = {
                "heldKeys": sorted(self.keys),
                "primaryDown": self.primary_down or self.fired_since_last_read,
                "pointerX": (self.pointer_x - self.capture_region["x"]) / self.capture_region["width"],
                "pointerY": (self.pointer_y - self.capture_region["y"]) / self.capture_region["height"],
                "pointerDeltaX": self.pointer_delta_x,
                "pointerDeltaY": self.pointer_delta_y,
            }
            self.pointer_delta_x = 0.0
            self.pointer_delta_y = 0.0
            self.fired_since_last_read = False
            return value

    def close(self) -> None:
        self.keyboard_listener.stop()
        self.mouse_listener.stop()


def desktop_record_serve() -> None:
    recorder: DesktopInputRecorder | None = None
    capture_region: dict[str, int] | None = None
    try:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("desktop recorder request must be an object")
                command = request.get("command")
                if command == "close":
                    if recorder is not None:
                        recorder.close()
                    print(json.dumps({"closed": True}, separators=(",", ":")), flush=True)
                    return
                if command == "start-record":
                    allowed = request.get("allowedKeys")
                    if not isinstance(allowed, list) or any(str(key) not in KEY_NAMES for key in allowed):
                        raise ValueError("desktop recorder allowed keys are invalid")
                    capture_region = desktop_region({"captureRegion": request.get("captureRegion")})
                    recorder = DesktopInputRecorder([str(key) for key in allowed], capture_region)
                    result: dict[str, Any] = {"ready": True}
                elif command == "capture":
                    if capture_region is None:
                        raise ValueError("desktop recorder has not started")
                    result = desktop_capture(
                        {
                            "captureRegion": capture_region,
                            "frameFile": request.get("frameFile"),
                        }
                    )
                elif command == "read-input":
                    if recorder is None:
                        raise ValueError("desktop recorder has not started")
                    result = {"input": recorder.read()}
                else:
                    raise ValueError("unsupported desktop recorder command")
            except Exception as error:  # pragma: no cover - protocol boundary
                result = {"error": str(error)}
            print(json.dumps(result, separators=(",", ":")), flush=True)
    finally:
        if recorder is not None:
            recorder.close()


def desktop_doctor() -> dict[str, Any]:
    report = doctor()["report"]
    if report["platform"] == "linux" and os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
        return {"supported": False, "detail": "Wayland is unsupported for desktop game control."}
    return {
        "supported": bool(report["ready"]),
        "detail": "Desktop capture and input packages are available." if report["ready"] else "Run `lhic train game env setup` first.",
    }


def desktop_region(request: dict[str, Any]) -> dict[str, int]:
    value = request.get("captureRegion")
    if not isinstance(value, dict):
        raise ValueError("desktop request requires captureRegion")
    try:
        region = {key: int(value[key]) for key in ("x", "y", "width", "height")}
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("desktop capture region is invalid") from error
    if region["x"] < 0 or region["y"] < 0 or region["width"] < 1 or region["height"] < 1:
        raise ValueError("desktop capture region is invalid")
    return region


def desktop_capture(request: dict[str, Any]) -> dict[str, Any]:
    _, _, Image = import_training_dependencies()
    try:
        import mss
    except ImportError as error:
        raise RuntimeError("Desktop capture dependency is unavailable.") from error
    region = desktop_region(request)
    frame_file = Path(str(request.get("frameFile", ""))).resolve()
    if not frame_file.name:
        raise ValueError("desktop capture requires frameFile")
    frame_file.parent.mkdir(parents=True, exist_ok=True)
    with mss.mss() as capture:
        shot = capture.grab(region)
        image = Image.frombytes("RGB", shot.size, shot.rgb)
        image.save(frame_file, format="PNG")
    return {"frameFile": str(frame_file)}


def allowed_desktop_keys(request: dict[str, Any]) -> tuple[list[str], list[str]]:
    allowed = request.get("allowedKeys")
    active = request.get("activeKeys", [])
    desired = request.get("desiredKeys", [])
    if not isinstance(allowed, list) or not isinstance(active, list) or not isinstance(desired, list):
        raise ValueError("desktop key request is invalid")
    allowed_keys = [str(key) for key in allowed]
    active_keys = [str(key) for key in active]
    desired_keys = [str(key) for key in desired]
    if any(key not in KEY_NAMES or key not in allowed_keys for key in active_keys + desired_keys):
        raise ValueError("desktop action includes a key outside the approved control profile")
    return active_keys, desired_keys


def desktop_primary_state(request: dict[str, Any]) -> tuple[bool, bool, bool]:
    primary_down = bool(request.get("primaryDown", False))
    desired_primary = bool(request.get("desiredPrimaryDown", False))
    primary_click = bool(request.get("primaryClick", False))
    allow_primary_click = bool(request.get("allowPrimaryClick", False))
    if (desired_primary or primary_click) and not allow_primary_click:
        raise ValueError("desktop primary click is outside the approved control profile")
    if desired_primary and primary_click:
        raise ValueError("desktop primary click cannot be held and pulsed together")
    return primary_down, desired_primary, primary_click


def desktop_apply(request: dict[str, Any]) -> dict[str, Any]:
    try:
        import pyautogui
    except ImportError as error:
        raise RuntimeError("Desktop input dependency is unavailable.") from error
    active, desired = allowed_desktop_keys(request)
    pyautogui.PAUSE = 0
    for key in active:
        if key not in desired:
            pyautogui.keyUp(KEY_NAMES[key])
    for key in desired:
        if key not in active:
            pyautogui.keyDown(KEY_NAMES[key])
    primary_down, desired_primary, primary_click = desktop_primary_state(request)
    if desired_primary != primary_down:
        if desired_primary:
            pyautogui.mouseDown(button="left")
        else:
            pyautogui.mouseUp(button="left")
    if primary_click:
        pyautogui.click(button="left")
    pointer = request.get("pointer")
    if isinstance(pointer, dict):
        mode = pointer.get("mode")
        if mode != request.get("aimMode"):
            raise ValueError("desktop pointer mode is outside the approved control profile")
        if mode == "relative":
            delta_x = int(pointer.get("deltaX", 0))
            delta_y = int(pointer.get("deltaY", 0))
            maximum = int(pointer.get("maximum", 0))
            if maximum < 1 or abs(delta_x) > maximum or abs(delta_y) > maximum:
                raise ValueError("desktop relative pointer action exceeds the approved bound")
            pyautogui.moveRel(delta_x, delta_y, duration=0)
        elif mode == "absolute":
            region = desktop_region(request)
            x = float(pointer.get("x", -1))
            y = float(pointer.get("y", -1))
            if not 0 <= x <= 1 or not 0 <= y <= 1:
                raise ValueError("desktop absolute pointer action is invalid")
            pyautogui.moveTo(region["x"] + x * region["width"], region["y"] + y * region["height"], duration=0)
        else:
            raise ValueError("desktop pointer mode is invalid")
    return {"activeKeys": desired, "primaryDown": desired_primary}


def desktop_release(request: dict[str, Any]) -> dict[str, Any]:
    try:
        import pyautogui
    except ImportError as error:
        raise RuntimeError("Desktop input dependency is unavailable.") from error
    active, _ = allowed_desktop_keys({**request, "desiredKeys": []})
    pyautogui.PAUSE = 0
    for key in active:
        pyautogui.keyUp(KEY_NAMES[key])
    pyautogui.mouseUp(button="left")
    return {"activeKeys": [], "primaryDown": False}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--desktop-serve", action="store_true")
    arguments = parser.parse_args()
    if arguments.serve:
        serve()
        return
    if arguments.desktop_serve:
        desktop_record_serve()
        return
    if not arguments.request:
        raise ValueError("worker requires --request or --serve")
    request = decode_request(arguments.request)
    command = request.get("command")
    if command == "doctor":
        result = doctor()
    elif command == "fit":
        result = fit(request)
    elif command == "smoke":
        result = smoke(request)
    elif command == "predict":
        result = predict(request)
    elif command == "desktop-doctor":
        result = desktop_doctor()
    elif command == "desktop-capture":
        result = desktop_capture(request)
    elif command == "desktop-apply":
        result = desktop_apply(request)
    elif command == "desktop-release":
        result = desktop_release(request)
    else:
        raise ValueError("unsupported game-training worker command")
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # pragma: no cover - CLI process boundary
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
