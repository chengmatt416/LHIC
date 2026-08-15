#!/usr/bin/env python3
import os
import pathlib
import sys
import tkinter as tk

state_path = pathlib.Path(sys.argv[1])
token = sys.argv[2]

def read_count() -> int:
    try:
        return int(state_path.read_text(encoding="utf-8").strip())
    except Exception:
        return 0

count = read_count()
root = tk.Tk()
root.geometry("460x220")
root.resizable(False, False)

label = tk.Label(root, text="", font=("Sans", 20))
label.pack(pady=35)

def persist() -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = state_path.with_suffix(".tmp")
    tmp.write_text(str(count), encoding="utf-8")
    os.replace(tmp, state_path)

def refresh() -> None:
    label.config(text=f"Committed desktop actions: {count}")
    root.title(f"LHIC Desktop Fixture {token} count={count}")

def commit(event=None) -> None:
    global count
    count += 1
    persist()
    refresh()

button = tk.Button(root, text="Commit desktop action", command=commit, width=24, height=2)
button.pack()
root.bind("<Control-Return>", commit)

persist()
refresh()
root.mainloop()
