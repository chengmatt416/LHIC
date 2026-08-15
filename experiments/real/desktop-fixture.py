#!/usr/bin/env python3
import os
import pathlib
import sys
import tkinter as tk

state_path = pathlib.Path(sys.argv[1])
token = sys.argv[2]
mode = sys.argv[3] if len(sys.argv) > 3 else "complete"

def read_count() -> int:
    try:
        return int(state_path.read_text(encoding="utf-8").strip())
    except Exception:
        return 0

count = read_count()
root = tk.Tk()
root.geometry("460x240")
root.resizable(False, False)

label = tk.Label(root, text="", font=("Sans", 20))
label.place(x=0, y=30, width=460, height=60)

def persist() -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = state_path.with_suffix(".tmp")
    tmp.write_text(str(count), encoding="utf-8")
    os.replace(tmp, state_path)

def refresh() -> None:
    label.config(text=f"Committed desktop actions: {count}")
    status = "partial" if mode == "partial" and count > 0 else "complete"
    root.title(f"LHIC Desktop Fixture {token} count={count} status={status}")

def commit() -> None:
    global count
    count += 1
    persist()
    refresh()

button = tk.Button(root, text="Commit desktop action", command=commit)
button.place(x=80, y=125, width=300, height=70)

persist()
refresh()
root.mainloop()
