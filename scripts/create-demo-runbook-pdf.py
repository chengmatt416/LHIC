from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "LHIC_3_Minute_Demo_Recording_Runbook.pdf"

NAVY = colors.HexColor("#071728")
INK = colors.HexColor("#102033")
MUTED = colors.HexColor("#60758E")
CYAN = colors.HexColor("#24C3D5")
BLUE = colors.HexColor("#3388D5")
VIOLET = colors.HexColor("#826BFF")
LIME = colors.HexColor("#A8D53D")
PALE = colors.HexColor("#F2F6F9")
PALE_LIME = colors.HexColor("#F0F8D9")
PALE_WARN = colors.HexColor("#FFF3D8")


pdfmetrics.registerFont(
    TTFont("ArialUnicode", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf")
)


class RunbookDoc(BaseDocTemplate):
    def __init__(self, filename: str):
        super().__init__(
            filename,
            pagesize=A4,
            leftMargin=16 * mm,
            rightMargin=16 * mm,
            topMargin=18 * mm,
            bottomMargin=17 * mm,
            title="LHIC 3-Minute Demo Recording Runbook",
            author="OpenAI Codex for LHIC",
        )
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            id="body",
        )
        self.addPageTemplates(PageTemplate(id="main", frames=[frame], onPage=draw_page))


def draw_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, A4[1] - 10 * mm, A4[0], 10 * mm, stroke=0, fill=1)
    canvas.setFillColor(CYAN)
    canvas.rect(0, A4[1] - 10 * mm, 3 * mm, 10 * mm, stroke=0, fill=1)
    canvas.setFont("ArialUnicode", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(16 * mm, 8 * mm, "LHIC • OpenAI Build Week demo runbook • private rehearsal copy")
    canvas.drawRightString(A4[0] - 16 * mm, 8 * mm, f"{doc.page}")
    canvas.restoreState()


styles = getSampleStyleSheet()
title = ParagraphStyle(
    "Title",
    fontName="ArialUnicode",
    fontSize=25,
    leading=30,
    textColor=NAVY,
    spaceAfter=7 * mm,
)
h1 = ParagraphStyle(
    "H1",
    fontName="ArialUnicode",
    fontSize=17,
    leading=21,
    textColor=NAVY,
    spaceBefore=1 * mm,
    spaceAfter=4 * mm,
)
h2 = ParagraphStyle(
    "H2",
    fontName="ArialUnicode",
    fontSize=11.5,
    leading=15,
    textColor=BLUE,
    spaceBefore=3 * mm,
    spaceAfter=2 * mm,
)
body = ParagraphStyle(
    "Body",
    fontName="ArialUnicode",
    fontSize=9.3,
    leading=13.6,
    textColor=INK,
    alignment=TA_LEFT,
    spaceAfter=2.2 * mm,
)
small = ParagraphStyle(
    "Small",
    parent=body,
    fontSize=7.7,
    leading=10.5,
    textColor=MUTED,
)
mono = ParagraphStyle(
    "Mono",
    parent=body,
    fontSize=7.5,
    leading=10,
    leftIndent=3 * mm,
    rightIndent=3 * mm,
    borderColor=colors.HexColor("#CAD8E5"),
    borderWidth=0.6,
    borderPadding=3 * mm,
    backColor=colors.white,
    spaceBefore=1.5 * mm,
    spaceAfter=3 * mm,
)
callout = ParagraphStyle(
    "Callout",
    parent=body,
    fontSize=10,
    leading=14,
    textColor=NAVY,
    borderColor=LIME,
    borderWidth=1,
    borderPadding=4 * mm,
    backColor=PALE_LIME,
    spaceAfter=4 * mm,
)
warning = ParagraphStyle(
    "Warning",
    parent=body,
    fontSize=9,
    leading=13,
    textColor=INK,
    borderColor=colors.HexColor("#E6B94A"),
    borderWidth=0.8,
    borderPadding=3.5 * mm,
    backColor=PALE_WARN,
    spaceAfter=4 * mm,
)


def p(text: str, style=body):
    return Paragraph(text, style)


def bullet(text: str):
    return Paragraph(f"• {text}", body)


def code(lines: str):
    return Paragraph(lines.replace("\n", "<br/>"), mono)


def table(rows, widths, header=True):
    header_cell = ParagraphStyle(
        "HeaderCell",
        parent=small,
        fontSize=7.3,
        leading=9.2,
        textColor=colors.white,
        spaceAfter=0,
    )
    body_cell = ParagraphStyle(
        "BodyCell",
        parent=small,
        fontSize=7.3,
        leading=9.2,
        textColor=INK,
        spaceAfter=0,
    )
    processed = [
        [
            Paragraph(str(cell), header_cell if header and row_index == 0 else body_cell)
            for cell in row
        ]
        for row_index, row in enumerate(rows)
    ]
    t = Table(processed, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    commands = [
        ("FONTNAME", (0, 0), (-1, -1), "ArialUnicode"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.7),
        ("LEADING", (0, 0), (-1, -1), 10.3),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TEXTCOLOR", (0, 0), (-1, -1), INK),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#CBD7E2")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]
    if header:
        commands += [
            ("BACKGROUND", (0, 0), (-1, 0), NAVY),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ]
    for row in range(1 if header else 0, len(rows)):
        if row % 2 == 0:
            commands.append(("BACKGROUND", (0, row), (-1, row), PALE))
    t.setStyle(TableStyle(commands))
    return t


story = []

# Page 1
story += [
    Spacer(1, 8 * mm),
    p("LHIC — 3-Minute Actual Demo", title),
    p("Recording runbook for an OpenAI Build Week submission", h1),
    p(
        "The demo should prove one clean boundary: <b>Codex proposes typed work through LHIC MCP; LHIC performs local actions, asks for human authority, verifies outcomes, learns only from evidence, and later replays an independently promoted skill without an LLM or MCP.</b>",
        callout,
    ),
    p("What the judges must see", h2),
    bullet("Codex is visibly connected to the local <b>lhic-computer-use</b> MCP server."),
    bullet("You are the live Slow Path operator: you enter the task, review the plan, approve activation, sign checkout, and decide whether execution continues."),
    bullet("The browser is controlled through LHIC semantic actions—not Codex browser control, screenshots, OCR, page-evaluate JavaScript, or raw coordinates."),
    bullet("The final purchase signature is entered by you. This is a deliberate human-authority moment; LHIC must not pretend it drew the signature."),
    bullet("Verifier evidence and redacted trace/candidate metadata are shown in the LHIC Desktop App."),
    bullet("The Fast Path evidence says <b>0 LLM calls / 0 MCP calls</b> during local execution."),
    bullet("Challenge2026 playback shows the local action loop separately from the website workflow."),
    p("Truth-in-demo rule", h2),
    p(
        "One successful Slow Path run creates a candidate; it does <b>not</b> become Fast Path immediately. LHIC requires three independent verified task IDs and a separate offline holdout with an unseen UI fingerprint. This runbook starts from a fresh memory database: the Slow Path builds the vendor candidate on camera, then the remaining real gates are shown in a clearly labelled compressed sequence before promotion.",
        warning,
    ),
    p("Recommended spoken opening", h2),
    p(
        "“Codex will plan through LHIC MCP. LHIC—not the model—will execute, gate risky steps, verify every result, and build the candidate live. I’ll then complete the remaining evidence gates before the local replay.”"
    ),
    p("Use the four-slide deck only as a 5-second opener and a 7-second close. The browser, Codex task, and LHIC Desktop App are the presentation."),
]

# Page 2
story += [PageBreak(), p("A 2:55 edit that still contains a real demo", title)]
rows = [
    ["Time", "Screen", "Action and narration"],
    ["0:00–0:05", "Slide 1", "“Codex proposes; LHIC executes locally and proves the outcome.”"],
    ["0:05–0:15", "Codex", "Show /mcp or the MCP status: lhic-computer-use connected. State that no other browser-control tool is allowed."],
    ["0:15–1:25", "Visible Chromium + Codex", "Run the real vendor Slow Path. Keep approvals and verifier results at normal speed; accelerate only repetitive add-to-cart/fill footage to 1.5–2× with an on-screen speed label."],
    ["1:25–1:37", "LHIC Desktop App", "Show the new SLOW ONLY candidate at 1/3 with verifier evidence and redacted trace."],
    ["1:37–1:57", "Compressed continuous evidence", "Show real runs 2 and 3 plus the unseen-UI holdout at 4–8×. Keep task IDs, verifier pass, and holdout result readable at each endpoint."],
    ["1:57–2:20", "LHIC Desktop App + Chromium", "Promote only after the gates pass, then run the new Fast Path variant. Hold on FAST-READY, 0 LLM, 0 MCP, verifier passed."],
    ["2:20–2:45", "Challenge2026", "Play a 20-second local policy replay and show observed realtime metrics."],
    ["2:45–2:55", "Slide 4", "“Codex proposed the work. LHIC built the skill from proof, then executed locally.”"],
]
story += [table(rows, [23 * mm, 43 * mm, 112 * mm])]
story += [
    p("Editing rules", h2),
    bullet("Do not cut across an approval prompt, verifier result, or the transition from Codex to LHIC."),
    bullet("A speed-up is acceptable for repeated low-risk actions if the label remains visible and the action sequence is continuous."),
    bullet("Never type demo codes while the recording zooms into the field. Password-field values and traces should remain redacted."),
    bullet("Do not call the second run a different website. It is the same application and origin with a different account/state. LHIC intentionally will not generalize a skill to a new origin."),
]

# Page 3
story += [PageBreak(), p("Pre-record setup and preflight", title)]
story += [
    p("1. Build and connect the local runtime", h2),
    code(
        "cd /Users/chengmatt/Projects/ComputerIntent\n"
        "npm ci\n"
        "npm run pw:install\n"
        "npm run build\n"
        "export LHIC_MEMORY_DATABASE=\"$PWD/.lhic/build-week-live-learning.sqlite\"\n"
        "npm run mcp:config"
    ),
    p("Review the generated Codex configuration, restart Codex, and verify the server in <b>/mcp</b>. Keep the browser visible; do not set LHIC_MCP_HEADLESS."),
    p("2. Start the LHIC Desktop App", h2),
    code("npm run desktop:start"),
    p("Open <b>Task Console</b> and <b>Skill Depot</b> from the same shell environment so the MCP server and Desktop App use the fresh database above. Before recording, use read-only skill inspection to confirm there is no vendor candidate or promoted vendor skill in that database."),
    p("3. Prepare the vendor site", h2),
    bullet("Confirm https://vendor.techtools.qzz.io/ and /finance are reachable."),
    bullet("Use a fresh Chromium session. Rehearse the exact labels because the site is Chinese and may change."),
    bullet("The product stock editor commits on <b>blur</b>; after filling “Test 庫存”, press Tab and wait for the refresh."),
    bullet("The checkout requires a non-empty signature canvas. You must sign it manually before LHIC confirms the purchase."),
    p("4. Private rehearsal inputs—do not put these in slides or traces", h2),
]
private_rows = [
    ["Run", "Store employee", "Finance manager", "Order", "Finance/stock"],
    ["Slow", "LHICTEST", "LHICMANAGER", "test3 ×1; test2 ×2", "支出 200; note 進貨; Test stock → 20"],
    ["Fast variant", "LHICTEST2", "LHICMANAGER2", "test3 ×2; test2 ×1", "支出 201; note 進貨-Fast; Test stock → 21"],
]
story += [table(private_rows, [20 * mm, 31 * mm, 34 * mm, 41 * mm, 52 * mm])]
story += [
    p("The 200/201 amounts and fast variant are recommended rehearsal values because the request did not specify an expense amount or exact alternate quantities. Change them before recording if your test data requires another value.", small),
    p("5. Rehearse the live evidence-gate sequence", h2),
    p(
        "Do not seed or prebuild a vendor skill. During recording, the first completed batch creates the candidate at 1/3; runs 2 and 3 must use distinct task IDs; then a separate evaluator must run against the registered vendor test account or allowlisted sandbox with a genuinely unseen UI fingerprint. Promotion is permitted only when Skill Depot shows all gates passed. If the current build cannot run that evaluator from a user-facing surface, the honest video stops at SLOW ONLY and does not show vendor Fast Path.",
        warning,
    ),
]

# Page 4
story += [PageBreak(), p("Vendor Slow Path: the exact live sequence", title)]
story += [
    p("You perform this section live", h2),
    p("Do not run a prepared vendor demo script. In the recording, type the task into Codex yourself, provide the private values only when requested, review each displayed target, give the human approvals, and sign the checkout canvas. Codex may propose through MCP; LHIC alone performs and verifies browser actions."),
    p("Paste this prompt into Codex", h2),
    code(
        "Use only the connected LHIC MCP tools for browser work. Do not use Codex browser control, screenshots, OCR, page-evaluate JavaScript, raw coordinates, or another browser tool. Start a visible LHIC browser, observe before every target, execute semantic actions, and show verifier evidence after every action.\n\n"
        "On https://vendor.techtools.qzz.io/, sign in with the employee code I will provide privately. Add test3 ×1 and test2 ×2. Open checkout, stop so I can sign the signature canvas manually, then ask for exact-action approval before confirming the order. Next navigate to /finance, sign in with the manager code I will provide privately, add a 支出 of 200 with note 進貨, then open 商品庫存 and set Test stock to 20. Press Tab after the stock fill and verify the refreshed row shows 20. Never print either code."
    ),
    p("On-screen action order", h2),
]
slow_rows = [
    ["Phase", "What happens", "Required evidence"],
    ["Connect", "lhic_runtime_status → lhic_browser_start → lhic_browser_observe", "Visible Chromium and local runtime status"],
    ["Store login", "Fill the password field with LHICTEST; activate login", "Authenticated storefront/catalog visible; value redacted"],
    ["Cart", "Click test3 once and test2 twice", "Cart quantity after each click"],
    ["Checkout", "Open checkout; you manually sign the canvas", "Checkout and non-empty signature visible"],
    ["Purchase", "LHIC activates the final confirm only after human approval", "Success/receipt state and empty/updated cart"],
    ["Finance login", "Navigate /finance; fill LHICMANAGER; log in", "財務與管理看板 visible; code redacted"],
    ["Expense", "Select 支出; fill 200 and 進貨; click 新增", "New ledger row contains 支出, 200, 進貨"],
    ["Stock", "Open 商品庫存; fill the Test row’s 庫存 input with 20; press Tab", "Refreshed Test row shows 20"],
]
story += [table(slow_rows, [27 * mm, 88 * mm, 63 * mm])]
story += [
    p("Learning evidence", h2),
    p("A completed <b>lhic_browser_execute_plan</b> batch whose every step has evidence can record one candidate run. Individual <b>lhic_browser_act</b> calls can improve selector memory but do not create a Skill candidate. Batch execution pauses before activation steps; acquire real human approvals and resume—never fabricate approval JSON."),
    p("If the batch/approval rehearsal is too slow for the final edit, keep the real browser execution but show selector-memory learning only. Do not display a candidate counter that the run did not actually change.", warning),
]

# Page 5
story += [PageBreak(), p("Learning, verification, and honest Fast Path proof", title)]
story += [
    p("What to show in the Desktop App", h2),
    bullet("Task status: completed, not merely “click dispatched”."),
    bullet("Verifier/postcondition evidence for the order, expense row, and Test stock value."),
    bullet("Trace/event entries with credential values omitted."),
    bullet("Candidate status and verified-run count. Say the number exactly as displayed."),
    bullet("After the on-camera evidence gates: FAST-READY and the execution summary with 0 LLM / 0 MCP."),
    p("Spoken bridge", h2),
    p(
        "“The Slow Path built this candidate live. I then completed two more independent verified runs and a separate unseen-UI holdout. Only now does LHIC permit promotion, so the next execution stays local.”",
        callout,
    ),
    p("Fast variant", h2),
    p("Use the same origin with a changed test account and changed values: LHICTEST2 / LHICMANAGER2, test3 ×2 and test2 ×1, 支出 201 with note 進貨-Fast, and Test stock 21. This proves controlled parameter/state variation, not arbitrary cross-site generalization."),
    p("Fast Path prompt in the Desktop Task Console", h2),
    code(
        "Run the approved vendor order-and-finance skill locally. Use the private employee and manager inputs I provide in the task UI. Order test3 ×2 and test2 ×1; pause for my checkout signature and exact-action approval; then add 支出 201 with note 進貨-Fast and set Test stock to 21. Require verifier evidence for the order result, ledger row, and final stock row."
    ),
    p("Evidence shot—hold for two seconds", h2),
    p("Frame the Desktop App so the judge can read: <b>FAST-READY • local deterministic • model calls 0 • MCP calls 0 • verifier passed</b>. If any field does not say that, stop and rerun; do not narrate around a contradictory screen."),
    p("What not to claim", h2),
    bullet("Do not say the one recorded run was instantly promoted."),
    bullet("Do not say the second run is a different website; it is a different account/state on the same site."),
    bullet("Do not call a Codex-compiled MCP batch “0 MCP”. Only the Desktop/local promoted skill replay is the strict 0-MCP Fast Path."),
]

# Page 6
story += [PageBreak(), p("Challenge2026: separate local speed proof", title)]
story += [
    p("Scope", h2),
    p("This demo controls the player with W/A/S/D and Space. The game’s trap-agent API is separate; do not imply LHIC calls it. No LLM, MCP, online multiplayer, score submission, or network service is used by the LHIC game-training path."),
    p("One-time setup", h2),
    code(
        "lhic train game env setup\n"
        "lhic train game env doctor\n"
        "lhic train game 2d setup challenge-2026 --source /Applications/Launcher.app/Contents/Resources/GameBuilds/Challenge2026.app"
    ),
    p("Open Challenge2026 yourself. Determine the exact active-window title and game-content rectangle. Replace the example values below; do not guess them."),
    p("Create a five-minute exact-target lease", h2),
    code(
        "lhic train game 2d lease challenge-2026 --window-title \"Challenge2026\" --region 100,100,1280,720 --approved-by local-operator --output /tmp/challenge-2026-lease.json"
    ),
    p("Record 20 seconds of your own play", h2),
    code(
        "lhic train game 2d record challenge-2026 --surface desktop --window-title \"Challenge2026\" --region 100,100,1280,720 --lease /tmp/challenge-2026-lease.json --duration-ms 20000 --output .lhic/game-training/2d/datasets/challenge-2026-human-v1"
    ),
    p("Fit the local policy", h2),
    code(
        "lhic train game 2d fit challenge-2026 --dataset .lhic/game-training/2d/datasets/challenge-2026-human-v1/manifest.json --seed 17 --validation-split 0.2 --output .lhic/game-training/2d/skills/challenge-2026-v1"
    ),
    p("Create a fresh lease immediately before playback, then run", h2),
    code(
        "lhic train game 2d play challenge-2026 --surface desktop --artifact .lhic/game-training/2d/skills/challenge-2026-v1/artifact.json --window-title \"Challenge2026\" --region 100,100,1280,720 --lease /tmp/challenge-2026-lease.json --duration-ms 25000"
    ),
    p("Show the returned <b>realtime</b> summary: requested control rate, observed rate, processing P50/P95, frame P95, and deadline misses. Say “configured local 20 Hz loop” unless the observed result also supports a stronger statement."),
    p("The lease expires after five minutes. Recreate it after fitting or any long rehearsal; focus loss releases all approved inputs."),
]

# Page 7
story += [PageBreak(), p("Final rehearsal checklist", title)]
checks = [
    "The short PowerPoint opens and contains exactly four slides.",
    "Codex shows lhic-computer-use connected and no alternate browser-control tool is enabled for the task.",
    "Visible Chromium is controlled through LHIC semantic actions.",
    "The slow order uses test3 ×1 and test2 ×2 with LHICTEST.",
    "You manually sign checkout; the final submit shows a real approval boundary and verifier result.",
    "Finance uses LHICMANAGER, 支出 200, note 進貨, and Test stock 20; the stock fill is committed by blur/Tab.",
    "Desktop App evidence matches what you say: trace redacted, verifier passed, candidate count exact.",
    "The vendor skill did not exist before recording; after the shown gates it is FAST-READY and uses LHICTEST2/LHICMANAGER2 for the alternate run.",
    "The Fast Path summary visibly reports 0 LLM and 0 MCP calls.",
    "Challenge2026 uses the exact focused window and current lease; the policy controls only W/A/S/D/Space.",
    "The final video is ≤2:59, with speed labels on accelerated footage and no hidden approval/verifier cuts.",
]
for item in checks:
    story.append(p(f"□ {item}"))
story += [
    p("Failure fallbacks", h2),
    table(
        [
            ["Failure", "What to do"],
            ["Vendor label changed", "Stop. Observe again and use the returned semantic target; do not guess a selector or use coordinates."],
            ["Signature blocks checkout", "Sign manually. Keep this in the video as human authority."],
            ["Stock remains unchanged", "Press Tab to trigger blur, wait for refresh, and verify the Test row before continuing."],
            ["Candidate does not increment", "State that only selector memory changed if stepwise actions were used. Do not show false candidate learning."],
            ["Fast skill is not FAST-READY", "Do not claim Fast Path and do not preload it. End the vendor section at SLOW ONLY or postpone recording until the real evidence gates pass."],
            ["Game stops", "Refocus the exact window, recreate the lease, and rerun. Do not bypass focus protection."],
        ],
        [52 * mm, 126 * mm],
    ),
    p("Sources", h2),
    p("Project: docs/architecture.md, docs/mcp-harnesses.md, docs/desktop-control-center.md, docs/game-training.md. Game rules and controls: https://hackmd.io/@NDWuVyohSDi-klZ4DgcUuQ/ry1gjR4Gze and linked Game Introduction / Setup / Agent Development / API Reference pages.", small),
    p("Prepared for the current working tree on 22 July 2026. Keep this PDF private because it contains test-account codes supplied for rehearsal.", small),
]


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = RunbookDoc(str(OUTPUT))
    doc.build(story)
    print(OUTPUT)


if __name__ == "__main__":
    main()
