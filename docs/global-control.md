# Global desktop control

LHIC can control the foreground desktop outside the browser on macOS, Windows,
and Linux. It uses native APIs directly and does not route desktop actions
through an LLM, MCP, OCR, or a screenshot model.

> The `npx @pinyencheng/lhic` commands below apply after the package is
> published. Before that release evidence exists, use the checkout setup in the
> [README](../README.md) and its `npm run` commands instead.

Run the capability check on the target computer before executing an action:

```bash
npx @pinyencheng/lhic global doctor
```

| Platform | Native backend                                    | Prerequisite                                                                                                     |
| -------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| macOS    | `osascript` and System Events                     | Grant Accessibility permission to the terminal that runs LHIC.                                                   |
| Windows  | `powershell.exe`, Windows Forms, and `user32.dll` | Run in an interactive desktop session.                                                                           |
| Linux    | `xdotool`, `gtk-launch`, and `pgrep`              | Use X11 and install `xdotool`; Wayland is rejected because this backend cannot safely inject global input there. |

## Action contract

Global actions use `scope: "os"` and are accepted by the same command as
browser actions:

```bash
npx @pinyencheng/lhic run action action.json approval.json
```

Supported action types are `os_click`, `os_type`, `os_press`, `os_launch`, and
`os_focus`.

Each action must declare its native method and one post-action verifier:

- Input verification: `active_window`, optionally matching an application
  name and/or a window-title fragment.
- Application verification: `process_running`, matching a process name.

For example, this types into TextEdit only when a matching approval artifact is
provided, and reports success only when TextEdit is still the active app:

```json
{
  "scope": "os",
  "type": "os_type",
  "intent": "Type the approved note into the active TextEdit document",
  "methodPreference": ["keyboard"],
  "riskLevel": "high",
  "text": "Status: ready",
  "verifier": {
    "type": "active_window",
    "application": "TextEdit"
  }
}
```

An application launch on Linux uses its desktop ID and verifies its process:

```json
{
  "scope": "os",
  "type": "os_launch",
  "intent": "Launch the approved terminal",
  "methodPreference": ["accessibility"],
  "riskLevel": "high",
  "application": "org.gnome.Terminal",
  "verifier": {
    "type": "process_running",
    "application": "gnome-terminal"
  }
}
```

`os_click` requires non-negative `x` and `y` coordinates plus `mouse` in
`methodPreference`; `os_type` requires `text` and `keyboard`; `os_press`
requires `key` (for example `Ctrl+L`, `Enter`, or `Cmd+L`) and `keyboard`;
`os_launch` and `os_focus` require `application` and `accessibility`.

## Safety boundary

Every global action requires a non-expired `ActionApproval` whose hash matches
the entire action, even when the submitted `riskLevel` is `low`. In production,
the existing signed-approval configuration is also enforced. Approval artifacts
must come from the human confirmation system; LHIC does not manufacture them.

Commands are executed with `execFile`, not a shell. Text and application values
are passed as arguments or encoded PowerShell data. Trace events record the
action kind, method, and verifier result but never the text being typed. Keep
the source action and approval files in an appropriately protected location.
