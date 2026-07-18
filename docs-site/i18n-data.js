const i18nPage = {
  zh: {
    nav: [
      "功能總覽",
      "架構與模組",
      "使用教學",
      "基準測試",
      "方案對比",
      "GitHub 專案",
    ],
    navCta: "快速開始",
    heroDesc:
      "基於本地優先與語意控制的瀏覽器操作運行時。日常已知的工作流自動化執行無須呼叫 LLM 也不依賴圖像畫面，提供毫秒級響應、客觀驗證證據與嚴格的安全防護。",
    heroStart: "開始使用",
    heroGithub: "GitHub 專案",
    copyBtn: "複製",
    featuresTag: "Feature Overview",
    featuresTitle: "核心功能總覽",
    featuresSubtitle:
      "LHIC 的核心設計理念是「確定性與安全性」，將瀏覽器操作轉變為客觀可驗證的自動化程序。",
    features: [
      {
        title: "Zero-LLM Fast Path",
        desc: "對於置信度高（&ge; 0.8）且為低風險的已知工作流，LHIC 直接呼叫本地預測與語意技能進行執行，徹底消除大模型的延遲與 Token 費用。",
      },
      {
        title: "語意定位抗變性",
        desc: "優先使用 DOM、ARIA 輔助角色、標籤 (label)、佔位符 (placeholder) 與包裹關係進行精準定位，大幅降低網頁排版異動帶來的腳本崩潰機率。",
      },
      {
        title: "客觀結果驗證器",
        desc: "每項操作的成功不靠模型猜測，而是由驗證器模組 (Verifier) 直接收集 DOM、URL、網路請求與檔案下載等客觀數據，作為執行通過的硬性指標。",
      },
      {
        title: "本地 SQLite 記憶庫",
        desc: "執行成功後，選擇器與故障修復歷史將持久化至本地 SQLite。下次執行同類網頁時，系統能主動進行選擇器修補與策略優化。",
      },
      {
        title: "極致隱私與遮蔽",
        desc: "自動在日誌中遮蔽敏感 PII (密碼、Cookie、Email、Token、手機)。高風險動作在生產環境中需經過由 Ed25519 數位簽章驗證的人類審批流。",
      },
      {
        title: "多代理 MCP 整合",
        desc: "提供標準 Model Context Protocol (MCP) 伺服器，對外曝露標準 API (Start, Observe, Act, Close)，完美對接外部 AI 代理 (例如 Antigravity)。",
      },
    ],
    archTag: "Architecture & Packages",
    archTitle: "架構與分支結構",
    archSubtitle:
      "LHIC 基於模組化 TypeScript 單一儲存庫 (Monorepo) 構建，透過雙路徑路由決策引擎實現安全高效的瀏覽器操作。",
    archFlowTitle: "雙路徑決策執行流程",
    archNodes: [
      { title: "User Intent", desc: "使用者輸入的自然語言或 JSON 意圖" },
      {
        title: "@lhic/controller",
        desc: "進行 UI 階段分類、風險評估與置信度評分",
      },
      {
        title: "Fast Path (本地執行)",
        desc: "無大模型呼叫，直接利用 Playwright 與 @lhic/skills 執行語意動作。",
      },
      {
        title: "@lhic/verifier",
        desc: "抓取 DOM 變更、URL、網路請求或檔案，比對驗證。",
      },
      {
        title: "SQLite Skill Memory",
        desc: "若驗證通過，將成功選擇器與策略沉澱為本地技能記憶。",
      },
      {
        title: "Human Approval Flow",
        desc: "暫停執行並向管理端申請 Ed25519 人類授權簽章。",
      },
      {
        title: "Slow Path Planner",
        desc: "呼叫大模型代理 (如 Claude 介面) 進行步驟拆解與例外修復。",
      },
      {
        title: "@lhic/trace & @lhic/security",
        desc: "脫敏遮蔽 PII 與機敏參數，輸出 redacted JSONL 日誌。",
      },
    ],
    treeTitle: "專案分支樹結構",
    treeSubtitle: "點擊下方資料夾節點可查看該套件說明。",
    treePlaceholderTitle: "請選擇模組",
    treePlaceholderDesc:
      "點擊左側目錄樹中的子套件 (package) 或應用程式 (app)，在此處即時檢視該模組的核心職責、安全屬性與設計原則。",
    treeLabels: {
      root: "ComputerIntent (根目錄)",
      packages: "packages/ (套件庫目錄)",
      apps: "apps/ (應用程式目錄)",
      schema: "schema (核心型別定義)",
      browser: "browser (瀏覽器 CDP 封裝)",
      verifier: "verifier (結果比對器)",
      trace: "trace (JSONL 脫敏日誌)",
      memory: "memory (SQLite 記憶體)",
      security: "security (安全與數位簽章)",
      skills: "skills (複用表單/下載技能)",
      controller: "controller (雙軌路由器)",
      cli: "cli (Command Line 工具)",
      "mcp-server": "mcp-server (MCP 伺服器端)",
    },
    tutoTag: "Detailed Guide",
    tutoTitle: "詳細使用教學",
    tutoSubtitle:
      "從環境建置到生產部署，逐步引導您掌握 LHIC 的安全自動化能力。注意：下方 npx 指令需在 npm package 發布後使用；發布前請依 README 以 checkout 的 npm run 指令操作。",
    tutoTabs: [
      "安裝與初始化",
      "CLI 開發使用",
      "AI Harness 整合",
      "生產安全配置",
    ],
    tutoStepsInstall: [
      {
        title: "發布後使用 npx 啟動 LHIC",
        desc: "需先發布 npm package，並使用 Node.js 24 以上版本；不必全域安裝 LHIC。",
      },
      {
        title: "安裝 Playwright 瀏覽器核心",
        desc: "安裝運行時所需的 Playwright Chromium 瀏覽器驅動。",
      },
      {
        title: "驗證本機執行環境",
        desc: "確認瀏覽器自動化與桌面控制的必要條件皆已就緒。",
      },
    ],
    tutoCodesInstall: [
      "# 僅限 npm package 發布後\nnpx @pinyencheng/lhic start",
      "npx playwright@1.61.1 install chromium",
      "npx @pinyencheng/lhic preflight\nnpx @pinyencheng/lhic global doctor",
    ],
    tutoStepsCli: [
      {
        title: "執行語意自動化動作",
        desc: "透過編譯好的 CLI，傳入語意動作 JSON 檔案執行。",
      },
      {
        title: "安全日誌脫敏檢查",
        desc: "檢視追蹤日誌並驗證敏感資訊 (密碼、Cookie) 是否已被完全遮蔽。",
      },
      {
        title: "抗變性消融模擬器",
        desc: "執行本地語意抗變性 (resilience) 的消融模擬評估。",
      },
    ],
    tutoCodesCli: [
      "# 執行特定 semantic action 任務\nnpx @pinyencheng/lhic run action action.json",
      "# 檢查指定追蹤日誌的健全度與規格狀況\nnpx @pinyencheng/lhic trace inspect path/to/trace.jsonl",
      "# 執行 100 次以指定 Seed (20260715) 生成的抗變性消融測試\nnpx @pinyencheng/lhic bench simulate resilience 100 20260715",
    ],
    tutoStepsMcp: [
      {
        title: "建置並預檢本機執行環境",
        desc: "AI harness 與 Chromium 必須在同一台電腦執行。MCP server 尚需由此 checkout 建置一次；後續的 CLI 使用與驗證則透過 npx 執行。",
      },
      {
        title: "使用已編譯的 stdio MCP 進入點",
        desc: "每個 MCP server process 管理一個新的 Chromium 工作階段，並依到達順序序列化操作。請讓 harness 直接啟動 <code>node</code>；不要使用 <code>npm run</code>，避免 Lifecycle 輸出污染 MCP 的 JSON stdio 通訊協定。",
      },
      {
        title: "在 OpenClaw 註冊並即時驗證",
        desc: "在專案根目錄執行以下命令，將 LHIC 儲存為 OpenClaw 管理的本機 MCP server，然後以 live probe 確認它能啟動並列出工具。",
      },
      {
        title: "在 Hermes 設定 MCP server",
        desc: "在 <code>~/.hermes/config.yaml</code> 的 <code>mcp_servers</code> 中新增 LHIC。保留單一序列化工作階段設定，並使用本機 SQLite 路徑保存經遮蔽的技能與選擇器記憶。",
      },
      {
        title: "以 Antigravity 外掛方式使用（選用）",
        desc: "此專案已包含 Antigravity 外掛。驗證外掛後，產生可供審閱的設定片段，貼入 harness 設定並在重啟後用 <code>/mcp</code> 確認連線。",
      },
      {
        title: "執行第一個可驗證任務",
        desc: "請 harness 依序使用以下工具。每個動作後都要檢查 <code>result.success</code>、驗證證據與回傳狀態；高風險或未知風險動作仍需要人類核准。",
      },
    ],
    tutoCodesMcp: [
      "npm ci\nnpm run build\nnpx playwright@1.61.1 install chromium\nnpx @pinyencheng/lhic preflight",
      '# Every harness points at this local, compiled server.\ncommand = "node"\nargs = ["/absolute/path/to/ComputerIntent/apps/mcp-server/dist/index.js"]\ncwd = "/absolute/path/to/ComputerIntent"',
      'openclaw mcp add lhic-computer-use --command node --arg "$PWD/apps/mcp-server/dist/index.js" --cwd "$PWD"\n\nopenclaw mcp doctor lhic-computer-use --probe',
      "# ~/.hermes/config.yaml\nmcp_servers:\n  lhic_computer_use:\n    command: node\n    args:\n      - /absolute/path/to/ComputerIntent/apps/mcp-server/dist/index.js\n    env:\n      LHIC_MEMORY_DATABASE: /absolute/path/to/ComputerIntent/.lhic/skills.sqlite\n    timeout: 45\n    connect_timeout: 20\n    supports_parallel_tool_calls: false",
      'agy plugin validate .agents/plugins/lhic-computer-use\nnpx @pinyencheng/lhic mcp config antigravity "$PWD"\n\n# Review the printed JSON, add it to Antigravity, restart, then run /mcp.',
      "lhic_runtime_status\nlhic_browser_start\nlhic_browser_observe\nlhic_browser_act  # exactly one: navigate, click, fill, select, press, or wait\nlhic_browser_observe\nlhic_browser_close",
    ],
    tutoStepsProd: [
      {
        title: "生產 Docker 沙箱配置",
        desc: "在正式環境中使用 Docker 進行物理硬隔離與權限限縮限制。",
      },
      {
        title: "容器低權限環境預檢",
        desc: "以 low-privilege (非 root 用戶 <code>lhic</code>) 打包 Chromium 與 CLI，並禁止掛載敏感的個人設定檔目錄。",
      },
      {
        title: "高風險指令人類簽章驗收",
        desc: "在生產模式下，任何高風險動作必須帶有第三方簽章授權，經 Ed25519 金鑰比對無誤後才允許在 Fast Path 執行。",
      },
    ],
    tutoCodesProd: [
      "# 驗證生產環境配置與預檢\nnpx @pinyencheng/lhic preflight",
      "# 建立容器並以生產配置預檢\ndocker build -t lhic-prod -f apps/cli/Dockerfile .\ndocker run --rm -it lhic-prod lhic run preflight --strict",
      "# 傳入動作檔與人類簽章檔案進行嚴格驗簽執行\nnpx @pinyencheng/lhic run action action.json signature.sig",
    ],
    benchTag: "Performance & Testing",
    benchTitle: "基準測試與抗變性驗證",
    benchSubtitle:
      "LHIC 通過嚴密的本地回歸指標套件，確保程式碼修改不影響系統的高可靠性與安全性。",
    benchCard1Title: "本地回歸測試套件 (50 Fixtures)",
    benchCard1Desc:
      "由 <code>fill_form</code>, <code>download_file</code>, <code>login</code>, <code>search</code>, <code>test_web_flow</code> 各 10 組本地網頁所組成的回歸煙霧測試 (Smoke Suite)。下面為系統設定的硬性驗收門檻：",
    benchGauges: [
      "任務成功率門檻",
      "Fast Path 路由比例",
      "驗證器通過率",
      "中位數 LLM 呼叫次數",
    ],
    benchCard2Title: "網頁變動抗變性消融模擬",
    benchCard2Desc:
      "以固定 seed 的 100 個本機任務，模擬 5 種 UI 排版與命名變體下的表單填寫。這是受控工程消融，不是公開網站或市場 benchmark。",
    benchAblations: [
      "LHIC Semantic 定量 (ARIA / Label 關聯)",
      "Brittle CSS Selector 定位 (固定 Selector 基準線)",
    ],
    benchAblationStats: ["100% 成功率", "20% 成功率"],
    benchConclusion:
      "<strong>消融結果結論：</strong> 在這個固定的 100-task 本機 fixture 中，語意定位處理了 ARIA label、包裹 label 與 placeholder 變體；相對於刻意侷限的固定 selector baseline，觀察到<strong>80 個百分點的受控優勢</strong>。不可用於 SOTA 或一般化主張。",
    compTag: "Comparison",
    compTitle: "與現有 Computer Use 解決方案的差異",
    compSubtitle:
      "LHIC 放棄了高成本、低安全性的「截圖-VLM-滑鼠座標」循環，改用精準的 DOM API 與安全邊界。",
    compHeaders: [
      "架構屬性",
      "傳統 VLM/像素定位方案 (如 Anthropic Computer Use)",
      "LHIC (Local-First Controller)",
    ],
    compRows: [
      [
        "基本操作迴圈",
        "VLM 模型解讀截圖 &rarr; 計算像素座標 &rarr; 模擬滑鼠點擊 (極慢，成本高)",
        "<span class='check-icon'>✓</span> 直接調用 CDP / Playwright DOM 與 ARIA 語意 API。優先走無模型 Fast Path",
      ],
      [
        "定位精準度與抗變性",
        "依賴視覺判讀，受解析度、縮放、滾動影響，易點錯座標造成不可預測後果",
        "<span class='check-icon'>✓</span> 標籤 (label)、角色 (role) 與本地 SQLite 歷史反饋修補定位。排版微調完全不受影響",
      ],
      [
        "安全性與 PII 防護",
        "日誌與 Token 中可能附帶敏感個資與截圖明文，無有效過濾機制",
        "<span class='check-icon'>✓</span> 原生 Regex 敏感資訊脫敏、HTTPS 白名單、本地 JSONL 不保留敏感輸入",
      ],
      [
        "高風險防堵機制",
        "大模型一旦「幻覺」容易自行點擊危險按鈕 (如確認支付、刪除帳號)",
        "<span class='check-icon'>✓</span> 高風險與自訂操作強制阻斷，必須取得由第三方簽發的 Ed25519 簽章憑證才可放行",
      ],
      [
        "執行成功驗證",
        "大模型自己預測「我好像完成了」 (無客觀依據，False-Positive 高)",
        "<span class='check-icon'>✓</span> Verifier 取得 DOM 終端狀態、網路監聽封包或下載成功資訊",
      ],
      [
        "運算資源與成本",
        "每一次滑動與動作均需多次呼叫 VLM API，每步驟數美分，延遲數秒",
        "<span class='check-icon'>✓</span> 本地預測 + Fast Path 毫秒級極速回應，0 大模型 API Token 開銷",
      ],
    ],
    marketCards: [
      {
        title: "市場領先與策略定位",
        desc: "LHIC 並非泛用的網頁「大模型探索代理」，而是鎖定在<strong>企業級高頻率、需要高可靠度與隱私保護的已知操作任務</strong>。當前許多產品追求「完全自主探索」，往往導致昂貴的賬單與隨機性的任務失敗。LHIC 的雙軌路由策略 (Fast/Slow Path) 將企業自動化的邊際成本降至接近零。",
      },
      {
        title: "防偽門檻與基準提交規則",
        desc: "我們絕不宣稱無客觀證據的 SOTA 指標。為保障指標真實性，專案配置了 <code>lhic bench validate-evidence</code> 驗證指令。唯有在 BrowserGym/AgentLab 整合套件下跑完 WorkArena 完整資料集、提交不加 any 修改的映像檔 Hash，並取得獨立第三方的再現，才被允許發布市場基準領先宣稱。",
      },
    ],
    footerDesc:
      "© 2026 LHIC Project. All rights reserved. 本專案採用 MIT 與 Apache 2.0 雙重授權。",
    footerLinks: ["功能總覽", "模組架構", "使用教學", "GitHub"],
  },
  en: {
    nav: [
      "Features",
      "Architecture",
      "Tutorial",
      "Benchmarks",
      "Comparison",
      "GitHub Project",
    ],
    navCta: "Get Started",
    heroDesc:
      "A local-first, semantically controlled browser automation runtime. Standard workflows run with zero LLM calls or visual screenshots, delivering sub-millisecond responses, verified proof, and rigorous sandboxing.",
    heroStart: "Get Started",
    heroGithub: "GitHub Project",
    copyBtn: "Copy",
    featuresTag: "Feature Overview",
    featuresTitle: "Key Features Overview",
    featuresSubtitle:
      "LHIC is designed with 'Determinism and Security' in mind, transforming browser automation into objectively verified flows.",
    features: [
      {
        title: "Zero-LLM Fast Path",
        desc: "For standard workflows with high confidence (>= 0.8) and low risk, LHIC executes them locally using predefined skills, completely eliminating LLM latency and token costs.",
      },
      {
        title: "Semantic Locator Resilience",
        desc: "Uses DOM, ARIA roles, labels, placeholders, and element hierarchies for precision targeting, significantly reducing script breakage under web layout changes.",
      },
      {
        title: "Objective Action Verifiers",
        desc: "Action success is verified objectively by capturing DOM state, URLs, network responses, or file downloads, rather than relying on LLM guesses.",
      },
      {
        title: "Local SQLite Memory",
        desc: "Successful selectors and healing histories are persisted locally in SQLite, enabling self-optimization and locator patching on subsequent runs.",
      },
      {
        title: "Security & Guardrails",
        desc: "Built-in credential redaction and Ed25519 signature checks. High-risk actions require signed approval and connections are strictly limited to allowed origins.",
      },
      {
        title: "Multi-Agent MCP Integration",
        desc: "Exposes standard Model Context Protocol (MCP) APIs (Start, Observe, Act, Close) to interface seamlessly with external AI agents like Antigravity.",
      },
    ],
    archTag: "Architecture & Packages",
    archTitle: "Architecture & Flow",
    archSubtitle:
      "LHIC is built on a modular TypeScript monorepo, resolving browser actions securely and efficiently via a dual-path routing engine.",
    archFlowTitle: "Dual-Path Execution Flow",
    archNodes: [
      {
        title: "User Intent",
        desc: "Natural language or structured JSON input from users",
      },
      {
        title: "@lhic/controller",
        desc: "Performs UI state classification, risk assessment, and confidence scoring",
      },
      {
        title: "Fast Path (Local)",
        desc: "No LLM calls. Executes semantic actions directly using Playwright and @lhic/skills.",
      },
      {
        title: "@lhic/verifier",
        desc: "Audits DOM shifts, URL redirects, network requests, or downloads.",
      },
      {
        title: "SQLite Skill Memory",
        desc: "Saves successful selectors and strategies as local skill memories if verified.",
      },
      {
        title: "Human Approval Flow",
        desc: "Suspends execution and requests an Ed25519 admin signature.",
      },
      {
        title: "Slow Path Planner",
        desc: "Invokes LLM agent planner (e.g., Claude) for step decomposition and recovery.",
      },
      {
        title: "@lhic/trace & @lhic/security",
        desc: "Scrubs passwords/PII and exports redacted JSONL logs.",
      },
    ],
    treeTitle: "Project Monorepo Structure",
    treeSubtitle:
      "Click on folder nodes below to inspect package descriptions.",
    treePlaceholderTitle: "Select a Module",
    treePlaceholderDesc:
      "Click a package or app in the directory tree to inspect its core responsibilities, security details, and architecture design.",
    treeLabels: {
      root: "ComputerIntent (Root)",
      packages: "packages/ (Libraries)",
      apps: "apps/ (Applications)",
      schema: "schema (Core Type Definitions)",
      browser: "browser (CDP Browser Wrapper)",
      verifier: "verifier (Objective Action Verifiers)",
      trace: "trace (Sanitized JSONL Logs)",
      memory: "memory (SQLite Skill Memory)",
      security: "security (Sandbox & Policies)",
      skills: "skills (Reusable Automation Skills)",
      controller: "controller (Brain Routing Brain)",
      cli: "cli (Command Line Tool)",
      "mcp-server": "mcp-server (Model Context Protocol)",
    },
    tutoTag: "Detailed Guide",
    tutoTitle: "Detailed User Guide",
    tutoSubtitle:
      "From local setup to production deployments, learn LHIC's secure automation capabilities. The npx commands below require a published npm package; before publication, use the checkout npm run commands in the README.",
    tutoTabs: [
      "Installation & Init",
      "CLI Development",
      "AI Harness Setup",
      "Production Config",
    ],
    tutoStepsInstall: [
      {
        title: "Start LHIC with npx after publication",
        desc: "Publish the npm package first, then use Node.js 24 or later; no global installation is required.",
      },
      {
        title: "Install Playwright Webdriver",
        desc: "Install Playwright Chromium browser driver for the automation runtime.",
      },
      {
        title: "Verify the Local Runtime",
        desc: "Confirm the prerequisites for browser automation and desktop control are ready.",
      },
    ],
    tutoCodesInstall: [
      "# Available after npm publication\nnpx @pinyencheng/lhic start",
      "npx playwright@1.61.1 install chromium",
      "npx @pinyencheng/lhic preflight\nnpx @pinyencheng/lhic global doctor",
    ],
    tutoStepsCli: [
      {
        title: "Run Semantic Action",
        desc: "Run compiled CLI passing semantic action JSON files:",
      },
      {
        title: "Trace Sanitization Audit",
        desc: "Inspect traces and audit password/cookie redaction status:",
      },
      {
        title: "Resilience Ablation Simulator",
        desc: "Evaluate resilient semantic locators using localized ablation simulation:",
      },
    ],
    tutoCodesCli: [
      "# Execute specific semantic action task\nnpx @pinyencheng/lhic run action action.json",
      "# Audit trace logs for security and validation status\nnpx @pinyencheng/lhic trace inspect path/to/trace.jsonl",
      "# Run 100 ablation test iterations for selector resilience using seed 20260715\nnpx @pinyencheng/lhic bench simulate resilience 100 20260715",
    ],
    tutoStepsMcp: [
      {
        title: "Build and preflight the local runtime",
        desc: "Run the AI harness and Chromium on the same machine. Build the MCP server from this checkout once; use npx for CLI verification only after npm publication.",
      },
      {
        title: "Use the compiled stdio MCP entrypoint",
        desc: "Each MCP server process owns one fresh Chromium session and serializes operations in arrival order. Let the harness launch <code>node</code> directly; do not use <code>npm run</code>, whose lifecycle output can corrupt the MCP JSON stdio stream.",
      },
      {
        title: "Register and live-probe OpenClaw",
        desc: "From the repository root, save LHIC as an OpenClaw-managed local MCP server, then run a live probe to prove it starts and exposes its tools.",
      },
      {
        title: "Configure Hermes as an MCP server",
        desc: "Add LHIC under <code>mcp_servers</code> in <code>~/.hermes/config.yaml</code>. Preserve its serialized session model and give its redacted skill and selector memory a local SQLite path.",
      },
      {
        title: "Use the Antigravity plugin (optional)",
        desc: "This repository includes an Antigravity plugin. Validate it, generate a reviewable configuration snippet, add it to the harness, and confirm the connection with <code>/mcp</code> after restarting.",
      },
      {
        title: "Run your first verifiable task",
        desc: "Ask the harness to use the tools in this order. After every action, check <code>result.success</code>, verifier evidence, and returned state; high- or unknown-risk work still requires human approval.",
      },
    ],
    tutoCodesMcp: [
      "npm ci\nnpm run build\nnpx playwright@1.61.1 install chromium\nnpx @pinyencheng/lhic preflight",
      '# Every harness points at this local, compiled server.\ncommand = "node"\nargs = ["/absolute/path/to/ComputerIntent/apps/mcp-server/dist/index.js"]\ncwd = "/absolute/path/to/ComputerIntent"',
      'openclaw mcp add lhic-computer-use --command node --arg "$PWD/apps/mcp-server/dist/index.js" --cwd "$PWD"\n\nopenclaw mcp doctor lhic-computer-use --probe',
      "# ~/.hermes/config.yaml\nmcp_servers:\n  lhic_computer_use:\n    command: node\n    args:\n      - /absolute/path/to/ComputerIntent/apps/mcp-server/dist/index.js\n    env:\n      LHIC_MEMORY_DATABASE: /absolute/path/to/ComputerIntent/.lhic/skills.sqlite\n    timeout: 45\n    connect_timeout: 20\n    supports_parallel_tool_calls: false",
      'agy plugin validate .agents/plugins/lhic-computer-use\nnpx @pinyencheng/lhic mcp config antigravity "$PWD"\n\n# Review the printed JSON, add it to Antigravity, restart, then run /mcp.',
      "lhic_runtime_status\nlhic_browser_start\nlhic_browser_observe\nlhic_browser_act  # exactly one: navigate, click, fill, select, press, or wait\nlhic_browser_observe\nlhic_browser_close",
    ],
    tutoStepsProd: [
      {
        title: "Hardened Dockerfile Setup",
        desc: "Use multi-stage production Docker configurations for sandbox isolation.",
      },
      {
        title: "Run Non-root Preflight",
        desc: "Enforce non-root execution and verify secure deployment checklist:",
      },
      {
        title: "Cryptographic Signature Sign-off",
        desc: "Enforce Ed25519 signature checks for high-risk actions in production:",
      },
    ],
    tutoCodesProd: [
      "# Run production environment preflight checks\nnpx @pinyencheng/lhic preflight",
      "# Build container and run checks under production isolation\ndocker build -t lhic-prod -f apps/cli/Dockerfile .\ndocker run --rm -it lhic-prod lhic run preflight --strict",
      "# Execute with strict Ed25519 cryptographic signature verification\nnpx @pinyencheng/lhic run action action.json signature.sig",
    ],
    benchTag: "Performance & Testing",
    benchTitle: "Benchmarks & Validation",
    benchSubtitle:
      "LHIC uses local regression metrics to catch changes in supported workflows; they are not market or SOTA measurements.",
    benchCard1Title: "Regression Suite (50 Fixtures)",
    benchCard1Desc:
      "Composed of local test runs (10 variants each). The following targets define core acceptance criteria:",
    benchGauges: [
      "Task Success Rate Limit",
      "Fast Path Ratio",
      "Verifier Pass Rate",
      "Median LLM Calls",
    ],
    benchCard2Title: "Ablation Simulation Study",
    benchCard2Desc:
      "Runs 100 fixed-seed local tasks across five UI layout and naming variants. This is a controlled engineering ablation, not a public-web or market benchmark.",
    benchAblations: [
      "LHIC Semantic Targeting (ARIA/Label)",
      "Brittle CSS Targeting (Baseline)",
    ],
    benchAblationStats: ["100% Success", "20% Success"],
    benchConclusion:
      "<strong>Ablation Conclusion:</strong> On this fixed 100-task local fixture, semantic targeting handles ARIA labels, wrapped labels, and placeholders. Against the intentionally limited static-selector baseline it shows an <strong>80-percentage-point controlled advantage</strong>; it does not support SOTA or general-web claims.",
    compTag: "Comparison",
    compTitle: "Comparison with Existing Solutions",
    compSubtitle:
      "LHIC shifts away from brittle pixel screenshots and moves to precision DOM/ARIA APIs.",
    compHeaders: [
      "Architecture Specs",
      "Traditional Pixel/VLM (e.g. Anthropic Computer Use)",
      "LHIC (Local-First Controller)",
    ],
    compRows: [
      [
        "Execution Loop",
        "VLM reads screenshot &rarr; calculates pixel coordinates &rarr; simulates click (slow, costly)",
        "Interacts via CDP/Playwright DOM and ARIA APIs. Prioritizes local Fast Path.",
      ],
      [
        "Resilience & Targeting",
        "Relies on visuals; impacted by zoom/resolution/scroll. Misclicks cause critical side-effects.",
        "Backed by labels, ARIA roles, and SQLite memory feedback. Immune to layout drift.",
      ],
      [
        "Data Security & Privacy",
        "Passwords/PII/cookies exposed in raw screenshots and logs; no automated redaction.",
        "Native regex sanitization of PII, HTTPS domain allowlist, zero PII at rest in traces.",
      ],
      [
        "Risk Prevention",
        "LLMs prone to hallucinations and executing destructive actions (e.g. pay, delete accounts).",
        "Hard lock on high-risk actions. Execution blocked unless verified by Ed25519 signature.",
      ],
      [
        "Validation Proof",
        "VLM model guesses success ('I think I finished'). High false-positive rates.",
        "Verifier checks DOM endpoint state, HTTP response, or download completion.",
      ],
      [
        "Resource Cost",
        "Requires repeated cloud calls to VLM per step. High cost and latency (seconds).",
        "Sub-millisecond local routing. $0 LLM API token cost for Fast Path.",
      ],
    ],
    marketCards: [
      {
        title: "Market Alignment & Positioning",
        desc: "LHIC targets high-frequency, reliable enterprise automation. We shift away from unpredictable fully-autonomous discovery, dropping marginal run costs to zero.",
      },
      {
        title: "Anti-Falsification & Submission Policy",
        desc: "We enforce rigorous validations. Submissions require unmodified hashes, full dataset audits, and independent verification prior to asserting SOTA status.",
      },
    ],
    footerDesc:
      "© 2026 LHIC Project. All rights reserved. Dual-licensed under the MIT and Apache 2.0 licenses.",
    footerLinks: ["Features", "Architecture", "Tutorial", "GitHub"],
  },
};

const packageDataZH = {
  schema: {
    title: "@lhic/schema",
    desc: "專案最基礎的核心型別與資料綱要定義。使用 Zod 做靜態型別與執行階段校驗，涵蓋 Intent、UIState、SemanticAction、VerifierConditions 與 TraceEvent 等核心實體型別。",
    features: [
      "保證整個 Monorepo 中各套件與應用程式通訊資料格式的一致性。",
      "定義明確的置信度閥值 (Confidence Level) 與風險權重 (Risk Weight)。",
      "規範 Action 執行後的 Verifier 證明資料結構規格。",
    ],
  },
  browser: {
    title: "@lhic/browser",
    desc: "提供 Playwright SDK 與 Chrome DevTools Protocol (CDP) 的底層調用封裝。內建高階瀏覽器實例池與 CDP 畫面影格串流機制，防個資洩漏且支援旁聽控制。",
    features: [
      "瀏覽器實例池 (BrowserPool)：支援預熱、狀態回收清理、以及防個資洩漏機制。",
      "影格即時旁聽 (Screencast)：基於 CDP startScreencast 實現即時 VNC 畫面廣播。",
      "隱身模式 (Stealth) 與代理輪替 (Proxy Rotation) 機制，防爬蟲特徵識別與防封鎖。",
    ],
  },
  verifier: {
    title: "@lhic/verifier",
    desc: "客觀成功驗證模組。負責在動作執行後，對瀏覽器 DOM 狀態變更、網路響應碼、URL 變更或檔案下載串流進行實體校驗，確保步驟不是盲目執行而是確實生效。",
    features: [
      "文件下載驗證：追蹤 Playwright 的 Download 事件，核對下載內容與大小。",
      "網路請求驗證：確認特定 API endpoint 的回傳狀態碼為 2xx。",
      "DOM 狀態比對：支持 XPath、文字內容存在性與屬性值匹配校驗。",
    ],
  },
  trace: {
    title: "@lhic/trace",
    desc: "安全事件追踪與日誌持久化模組。所有任務執行的每一步操作細節與驗證數據均會寫入 Trace 檔案中。支援敏感 PII 全自動遮蔽，且包含 APM 及日誌自動清理功能。",
    features: [
      "自動日誌與截圖過期清理 (Log Pruning)，定期釋放磁碟空間防止硬碟爆滿。",
      "OpenTelemetry (OTLP) 整合：支援導出標準 Trace 格式 Spans 至集中 APM 監控大盤。",
      "為每組 trace 生成獨立 SHA-256 狀態雜湊值，防止操作紀錄被篡改。",
    ],
  },
  memory: {
    title: "@lhic/memory",
    desc: "基於 SQLite (`node:sqlite`) 的本地知識記憶庫。支持耐久執行與步驟恢復，開啟 WAL 模式支持多租戶高併發讀寫。",
    features: [
      "耐久執行與狀態恢復 (Durable Workflows)：基於 SQLite 實現 Cookies/LocalStorage/SessionStorage 保存與步驟還原。",
      "併發 WAL 模式配置與 Busy Timeout 鎖控制，防止併發死鎖。",
      "完全本地存儲，無需任何外部雲端資料庫調用，確保離線可用與極低延遲。",
    ],
  },
  security: {
    title: "@lhic/security",
    desc: "安全邊界控管組件。負責在生產環境 (production) 下落實一系列強制限制，包含 SSL/HTTPS 白名單域名限制、KMS 公鑰簽章校驗與軟體靜態加密防護。",
    features: [
      "KmsKeyManager：使用本機 Ed25519 公鑰或明確設定的 GCP KMS／Vault 解析器；缺少、無效或不支援的解析器一律拒絕，AWS 需 SigV4 驗證的解析器。",
      "金鑰吊銷機制 (CRL) 與快取 TTL 更新限制，防止過期金鑰繼續生效。",
      "原生零依賴的 AES-256-GCM 靜態資料加密層，防資料庫內容遭拷貝洩漏。",
    ],
  },
  skills: {
    title: "@lhic/skills",
    desc: "常用瀏覽器自動化高階複用技能模組。預置了多個具備故障恢復機制的常見網頁行為，如自動填表 (`fill_form`)、檔案下載 (`download_file`)、登入流程 (`login`) 以及網頁跳轉搜尋等。",
    features: [
      "登入技能：內建 CAPTCHA 與多重因素驗證 (2FA) 的 askUser 掛起機制。",
      "表單填寫：支持隨機布局下的標籤尋找與鍵盤交互，絕不包含自動 Submit (送出必須為獨立經批准的動作)。",
      "提供單元測試覆蓋與 benchmarks Fixtures 的預設技能實現。",
    ],
  },
  controller: {
    title: "@lhic/controller",
    desc: "整個 LHIC 的大腦路由器。接收 Intent 並分類網頁 UI 狀態，決定是將任務派發給零成本的 Fast Path，抑或是將任務轉派給 Slow Path LLM Planner / 請求人類介入審查。",
    features: [
      "信賴閥值控管：唯有 UI 預測置信度高於 0.8 且低風險時，才走本地 Fast Path。",
      "內建 Claude 等 Slow Path 代理介面封裝 (預設關閉，確保 Fast Path 零大模型連線)。",
      "動態編譯語意 JSON 到本地執行代碼。",
    ],
  },
  cli: {
    title: "apps/cli",
    desc: "LHIC 的終端 Command Line 介面 (`lhic`)。為開發者與運維人員提供執行 Action 任務、預檢環境、檢查 Trace 安全性以及跑本地 Benchmark 的進入點。",
    features: [
      "安全預檢功能：`lhic run preflight` 確保主機環境變數與容器環境符合生產規格。",
      "加固 Preflight：新增 Non-root 執行與網絡 DNS 完整性/劫持防護預檢。",
      "提供快速的本地回歸基準測試觸發入口 `lhic bench`。",
    ],
  },
  "mcp-server": {
    title: "apps/mcp-server",
    desc: "標準 Model Context Protocol (MCP) 伺服器實現。將 LHIC 的本地安全瀏覽器執行能力，轉化為外部 AI 代理 (例如 Antigravity) 的外掛工具，新增 HTTP 控制面閘道。",
    features: [
      "控制面閘道 (Control Plane Server)：基於原生 http 的 JWT 認證與 IP 限流防護。",
      "嚴格遵循 JSON-RPC stdio 協議，不污染標準輸出流。",
      "在輸出觀察回應時，自動移除所有 form input 中已鍵入的敏感內容，落實防洩防護。",
    ],
  },
};

const packageDataEN = {
  schema: {
    title: "@lhic/schema",
    desc: "The absolute foundation defining core types and data schemas. Utilizes Zod for static and runtime validation, covering Intent, UIState, SemanticAction, VerifierConditions, and TraceEvent.",
    features: [
      "Ensures data schema consistency across all packages and apps in the monorepo.",
      "Defines explicit confidence thresholds and risk weights.",
      "Specifies structural formatting for verifier output tokens.",
    ],
  },
  browser: {
    title: "@lhic/browser",
    desc: "Wraps Playwright and Chrome DevTools Protocol (CDP). Features browser instance pooling and CDP screencast screen-sharing to prevent leakage and allow manual override.",
    features: [
      "BrowserPool: Supports warm instances, isolated contexts, and cookie/session state cleanup.",
      "CDP Screencast: Emits real-time screen frames as JPEG stream for remote manual intervention.",
      "Stealth & Proxy Rotation: Bypasses anti-scrape browser fingerprinting and rotates proxies per context.",
    ],
  },
  verifier: {
    title: "@lhic/verifier",
    desc: "Objective validation engine. Audits final DOM changes, API statuses, and download streams after every action to ensure tasks are completed.",
    features: [
      "Download verification: Tracks Playwright file downloads and validates size/type.",
      "Network verification: Confirms specific REST endpoints return expected 2xx response codes.",
      "DOM state verification: Supports XPath and element presence/attribute checks.",
    ],
  },
  trace: {
    title: "@lhic/trace",
    desc: "Event tracking and logging module. Records every semantic action details and redacted JSONL files. Features dynamic cleanup and OTel exporting.",
    features: [
      "Log Pruning: Automatically purges historical traces and screenshots older than 30 days.",
      "OpenTelemetry Export: Maps local tracing events to OTLP JSON spans for Grafana/Elasticsearch.",
      "State Hash: Generates SHA-256 state hashes to prevent trace manipulation.",
    ],
  },
  memory: {
    title: "@lhic/memory",
    desc: "SQLite-based skill memory. Tracks successful selectors, workflow progress, and supports multi-tenant concurrency.",
    features: [
      "Durable Workflows: Stores cookies, localStorage, and sessionStorage to restore states.",
      "Concurrent WAL mode: Minimizes database locks and deadlocks under heavy concurrent load.",
      "Local store: Operates entirely offline with zero latency.",
    ],
  },
  security: {
    title: "@lhic/security",
    desc: "Core sandbox and policy controller. Enforces domain whitelists, public/private network restrictions, and KMS verification.",
    features: [
      "KmsKeyManager: Verifies Ed25519 keys from local configuration or explicitly configured GCP KMS and Vault resolvers; missing, invalid, and unsupported resolvers fail closed, while AWS requires a SigV4-authenticated resolver.",
      "CRL & Cache TTL: Supports certificate revocation checks and key expiration limits.",
      "AES-256-GCM Encryption: Secures user sessions, cookies, and local database storage at rest.",
    ],
  },
  skills: {
    title: "@lhic/skills",
    desc: "High-level re-usable web automation flows. Bundles standard skills like fill_form, download_file, and login.",
    features: [
      "Login Skill: Built-in 2FA/CAPTCHA suspension flow.",
      "Form Filling: Identifies input tags semantically (never auto-submits forms).",
      "Provides pre-packaged regression smoke tests and benchmark scripts.",
    ],
  },
  controller: {
    title: "@lhic/controller",
    desc: "The router brain. Receives user intents and routes them to either the zero-cost Fast Path or Slow Path planner.",
    features: [
      "Confidence check: Only executes Fast Path if predicted UI confidence >= 0.8.",
      "Slow Path fallbacks: Standard adapters for Claude 3.5 and other agent frameworks.",
      "Semantic Action compiler: Compiles natural language input into JSON actions.",
    ],
  },
  cli: {
    title: "apps/cli",
    desc: "LHIC Command Line Interface (CLI). Entrypoint for running tasks, preflights, and local benchmarks.",
    features: [
      "CLI Preflight: Runs system readiness checks including non-root and DNS hijack checks.",
      "Harness configs: Render MCP setups for Antigravity, Cursor, and VS Code.",
      "Benchmark triggers: Simple runner for local simulation and regression suites.",
    ],
  },
  "mcp-server": {
    title: "apps/mcp-server",
    desc: "Model Context Protocol (MCP) server stdio entrypoint. Exposes LHIC capabilities as tools for external agents, featuring an HTTP Control Plane Gateway.",
    features: [
      "Control Plane: Light-weight API Gateway with JWT authorization and IP-based rate limiting.",
      "Strict stdio: Complies with JSON-RPC over stdio.",
      "Data redaction: Scrubs sensitive forms from observations.",
    ],
  },
};
