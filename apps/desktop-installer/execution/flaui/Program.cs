// FlaUI bridge for the LHIC Windows execution layer.
//
//   dotnet lhic-flaui.dll <command> [args]
//
// Commands (JSON on stdout):
//   probe                  -> { ok: true, version: "flaui-1" }
//   observe [--app NAME]   -> { elements: [{ id, label, role, frame: {x,y,width,height}, interactable }] }
//   click --on ID|--label NAME|--at X,Y
//   type [--on ID] --text TEXT
//   press KEY              (e.g. "Enter", "ctrl+c")
//   scroll DIRECTION [--on ID]   (up|down|left|right)
//   screenshot OUTPUT_PATH
//
// Built with: dotnet publish -c Release -r win-x64 --self-contained false
using System.Text.Json;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.Core.Input;
using FlaUI.UIA3;

var command = args.Length > 0 ? args[0] : "";
try
{
    using var automation = new UIA3Automation();
    var root = automation.GetDesktop();
    switch (command)
    {
        case "probe":
            WriteOk(new { ok = true, version = "flaui-1" });
            break;
        case "observe":
            WriteOk(Observe(root, args));
            break;
        case "click":
            Click(root, args);
            WriteOk(new { ok = true });
            break;
        case "type":
            TypeText(root, args);
            WriteOk(new { ok = true });
            break;
        case "press":
            Press(args);
            WriteOk(new { ok = true });
            break;
        case "scroll":
            Scroll(root, args);
            WriteOk(new { ok = true });
            break;
        case "screenshot":
            Screenshot(args);
            WriteOk(new { ok = true });
            break;
        default:
            throw new ArgumentException($"unknown command: {command}");
    }
}
catch (Exception error)
{
    WriteError(error.Message);
    Environment.ExitCode = 1;
}

static string? Arg(string[] args, string name)
{
    for (var i = 0; i < args.Length - 1; i++)
    {
        if (args[i] == name) return args[i + 1];
    }
    return null;
}

static AutomationElement? FindElement(AutomationElement root, string[] args)
{
    var on = Arg(args, "--on");
    if (!string.IsNullOrEmpty(on))
    {
        return root.FindFirstDescendant(c => c.ByAutomationId(on))
            ?? root.FindFirstDescendant(c => c.ByName(on));
    }
    var label = Arg(args, "--label");
    if (!string.IsNullOrEmpty(label))
    {
        return root.FindFirstDescendant(c => c.ByName(label));
    }
    return null;
}

static object[] Observe(AutomationElement root, string[] args)
{
    var elements = new List<object>();
    var application = Arg(args, "--app");
    var scope = root;
    if (!string.IsNullOrEmpty(application))
    {
        scope = root.FindFirstDescendant(c => c.ByProcessName(application + ".exe")) ?? root;
    }
    Collect(scope, elements, 0, new HashSet<string>());
    return elements.ToArray();
}

static void Collect(AutomationElement element, List<object> elements, int depth, HashSet<string> seen)
{
    if (depth > 40)
    {
        return;
    }
    foreach (var child in element.FindAllChildren())
    {
        var label = child.Properties.Name.ValueOrDefault ?? "";
        var id = child.Properties.AutomationId.ValueOrDefault ?? "";
        var role = child.Properties.ControlType.ValueOrDefault.ToString();
        var bounds = child.Properties.BoundingRectangle.ValueOrDefault;
        var isOffscreen = child.Properties.IsOffscreen.ValueOrDefault;
        if (isOffscreen || bounds.Width <= 0 || bounds.Height <= 0)
        {
            continue;
        }
        var key = $"{id}|{label}|{role}|{bounds.X},{bounds.Y},{bounds.Width},{bounds.Height}";
        if (!seen.Add(key))
        {
            continue;
        }
        var elementId = !string.IsNullOrEmpty(id)
            ? id
            : $"{role}:{label}:{bounds.X},{bounds.Y}";
        elements.Add(new
        {
            id = elementId,
            label = string.IsNullOrEmpty(label) ? null : label,
            role,
            frame = new { x = (int)bounds.X, y = (int)bounds.Y, width = (int)bounds.Width, height = (int)bounds.Height },
            interactable = IsInteractable(child),
        });
        Collect(child, elements, depth + 1, seen);
    }
}

static bool IsInteractable(AutomationElement element)
{
    return element.TryGetClickablePoint(out _)
        || element.Patterns.Invoke.PatternOrDefault is not null
        || element.Patterns.Value.PatternOrDefault is not null
        || element.Patterns.SelectionItem.PatternOrDefault is not null;
}

static void Click(AutomationElement root, string[] args)
{
    var element = FindElement(root, args);
    if (element is not null)
    {
        element.Click();
        return;
    }
    var at = Arg(args, "--at");
    if (!string.IsNullOrEmpty(at))
    {
        var parts = at.Split(',');
        var x = int.Parse(parts[0].Trim());
        var y = int.Parse(parts[1].Trim());
        Mouse.MoveTo(new System.Drawing.Point(x, y));
        Mouse.Click(FlaUI.Core.Input.MouseButton.Left);
        return;
    }
    throw new ArgumentException("click requires --on, --label, or --at");
}

static void TypeText(AutomationElement root, string[] args)
{
    var text = Arg(args, "--text") ?? throw new ArgumentException("type requires --text");
    var element = FindElement(root, args);
    if (element is not null && element.Patterns.Value.PatternOrDefault is { } value)
    {
        value.SetValue(text);
        return;
    }
    if (element is not null)
    {
        element.Focus();
    }
    Keyboard.Type(text);
}

static void Press(string[] args)
{
    var key = Arg(args, "--key") ?? args.ElementAtOrDefault(1) ?? throw new ArgumentException("press requires a key");
    var parts = key.Split('+', StringSplitOptions.RemoveEmptyEntries);
    var modifiers = parts.Take(parts.Length - 1).Select(ToModifier).ToArray();
    var main = ToKey(parts[^1]);
    Keyboard.Press(main, modifiers);
}

static VirtualKeyShort ToModifier(string value)
{
    return value.ToLowerInvariant() switch
    {
        "ctrl" or "control" => VirtualKeyShort.CONTROL,
        "alt" or "option" => VirtualKeyShort.MENU,
        "shift" => VirtualKeyShort.SHIFT,
        "cmd" or "command" or "win" or "meta" => VirtualKeyShort.LWIN,
        _ => throw new ArgumentException($"unsupported modifier: {value}"),
    };
}

static VirtualKeyShort ToKey(string value)
{
    var lower = value.ToLowerInvariant();
    if (lower.Length == 1 && char.IsLetterOrDigit(lower[0]))
    {
        return (VirtualKeyShort)char.ToUpperInvariant(lower[0]);
    }
    return lower switch
    {
        "enter" or "return" => VirtualKeyShort.RETURN,
        "escape" or "esc" => VirtualKeyShort.ESCAPE,
        "space" => VirtualKeyShort.SPACE,
        "tab" => VirtualKeyShort.TAB,
        "backspace" => VirtualKeyShort.BACK,
        "delete" or "del" => VirtualKeyShort.DELETE,
        "up" or "up arrow" => VirtualKeyShort.UP,
        "down" or "down arrow" => VirtualKeyShort.DOWN,
        "left" or "left arrow" => VirtualKeyShort.LEFT,
        "right" or "right arrow" => VirtualKeyShort.RIGHT,
        "home" => VirtualKeyShort.HOME,
        "end" => VirtualKeyShort.END,
        "pageup" => VirtualKeyShort.PRIOR,
        "pagedown" => VirtualKeyShort.NEXT,
        _ when lower.StartsWith("f") && int.TryParse(lower[1..], out var n) && n is >= 1 and <= 24 =>
            (VirtualKeyShort)((int)VirtualKeyShort.F1 + n - 1),
        _ => throw new ArgumentException($"unsupported key: {value}"),
    };
}

static void Scroll(AutomationElement root, string[] args)
{
    var direction = args.ElementAtOrDefault(1) ?? throw new ArgumentException("scroll requires a direction");
    var element = FindElement(root, args);
    if (element is not null && element.Patterns.Scroll.PatternOrDefault is { } scroll)
    {
        if (direction == "left" || direction == "right")
        {
            scroll.ScrollHorizontal(direction == "left"
                ? ScrollAmount.LargeIncrement
                : ScrollAmount.LargeDecrement);
        }
        else
        {
            scroll.ScrollVertical(direction == "down"
                ? ScrollAmount.LargeIncrement
                : ScrollAmount.LargeDecrement);
        }
        return;
    }
    var x = 0;
    var y = 0;
    if (element is not null)
    {
        x = (int)element.Properties.BoundingRectangle.ValueOrDefault.Center.X;
        y = (int)element.Properties.BoundingRectangle.ValueOrDefault.Center.Y;
    }
    else
    {
        var screen = System.Windows.Forms.Screen.PrimaryScreen!.Bounds;
        x = screen.Width / 2;
        y = screen.Height / 2;
    }
    Mouse.MoveTo(new System.Drawing.Point(x, y));
    var wheel = direction == "up" || direction == "left" ? -120 : 120;
    Mouse.Scroll(wheel);
}

static void Screenshot(string[] args)
{
    var outputPath = args.ElementAtOrDefault(1) ?? throw new ArgumentException("screenshot requires an output path");
    var bounds = System.Windows.Forms.Screen.PrimaryScreen!.Bounds;
    using var bitmap = new System.Drawing.Bitmap(bounds.Width, bounds.Height);
    using var graphics = System.Drawing.Graphics.FromImage(bitmap);
    graphics.CopyFromScreen(bounds.Location, System.Drawing.Point.Empty, bounds.Size);
    bitmap.Save(outputPath, System.Drawing.Imaging.ImageFormat.Png);
}

static void WriteOk(object value)
{
    Console.WriteLine(JsonSerializer.Serialize(value));
}

static void WriteError(string message)
{
    Console.Error.WriteLine(JsonSerializer.Serialize(new { error = message }));
}
