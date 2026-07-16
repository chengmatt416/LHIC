const i18nPage = {
    zh: {
        nav: ["功能總覽", "架構與模組", "使用教學", "基準測試", "方案對比", "GitHub 專案"],
        navCta: "快速開始",
        heroDesc: "基於本地優先與語意控制的瀏覽器操作運行時。日常已知的工作流自動化執行無須呼叫 LLM 也不依賴圖像畫面，提供毫秒級響應、客觀驗證證據與嚴格的安全防護。",
        heroStart: "開始使用",
        heroGithub: "GitHub 專案",
        featuresTag: "Feature Overview",
        featuresTitle: "核心功能總覽",
        featuresSubtitle: "LHIC 的核心設計理念是「確定性與安全性」，將瀏覽器操作轉變為客觀可驗證的自動化程序。",
        features: [
            { title: "Zero-LLM Fast Path", desc: "對於置信度高（&ge; 0.8）且為低風險的已知工作流，LHIC 直接呼叫本地預測與語意技能進行執行，徹底消除大模型的延遲與 Token 費用。" },
            { title: "語意定位抗變性", desc: "優先使用 DOM、ARIA 輔助角色、標籤 (label)、佔位符 (placeholder) 與包裹關係進行精準定位，大幅降低網頁排版異動帶來的腳本崩潰機率。" },
            { title: "客觀結果驗證器", desc: "每項操作的成功不靠模型猜測，而是由驗證器模組 (Verifier) 直接收集 DOM、URL、網路請求與檔案下載等客觀數據，作為執行通過的硬性指標。" },
            { title: "本地 SQLite 記憶庫", desc: "執行成功後，選擇器與故障修復歷史將持久化至本地 SQLite。下次執行同類網頁時，系統能主動進行選擇器修補與策略優化。" },
            { title: "極致隱私與遮蔽", desc: "自動在日誌中遮蔽敏感 PII (密碼、Cookie、Email、Token、手機)。高風險動作在生產環境中需經過由 Ed25519 數位簽章驗證的人類審批流。" },
            { title: "多代理 MCP 整合", desc: "提供標準 Model Context Protocol (MCP) 伺服器，對外曝露標準 API (Start, Observe, Act, Close)，完美對接外部 AI 代理 (例如 Antigravity)。" }
        ],
        archTag: "Architecture & Packages",
        archTitle: "架構與分支結構",
        archSubtitle: "LHIC 基於模組化 TypeScript 單一儲存庫 (Monorepo) 構建，透過雙路徑路由決策引擎實現安全高效的瀏覽器操作。",
        archFlowTitle: "雙路徑決策執行流程",
        archNodes: [
            { title: "User Intent", desc: "使用者輸入的自然語言或 JSON 意圖" },
            { title: "@lhic/controller", desc: "進行 UI 階段分類、風險評估與置信度評分" },
            { title: "Fast Path (本地執行)", desc: "無大模型呼叫，直接利用 Playwright 與 @lhic/skills 執行語意動作。" },
            { title: "@lhic/verifier", desc: "抓取 DOM 變更、URL、網路請求或檔案，比對驗證。" },
            { title: "SQLite Skill Memory", desc: "若驗證通過，將成功選擇器與策略沉澱為本地技能記憶。" },
            { title: "Human Approval Flow", desc: "暫停執行並向管理端申請 Ed25519 人類授權簽章。" },
            { title: "Slow Path Planner", desc: "呼叫大模型代理 (如 Claude 介面) 進行步驟拆解與例外修復。" },
            { title: "@lhic/trace & @lhic/security", desc: "脫敏遮蔽 PII 與機敏參數，輸出 redacted JSONL 日誌。" }
        ],
        treeTitle: "專案分支樹結構",
        treeSubtitle: "點擊下方資料夾節點可查看該套件說明。",
        treePlaceholder: "點擊下方資料夾節點可查看該套件/應用程式的功能說明與職責。",
        tutoTag: "Detailed Guide",
        tutoTitle: "詳細使用教學",
        tutoSubtitle: "從環境建置到生產部署，逐步引導您掌握 LHIC 的強大安全自動化能力。",
        tutoTabs: ["安裝與初始化", "CLI 開發使用", "MCP 代理整合", "生產安全配置"],
        tutoStepsInstall: [
            { title: "安裝專案依賴與建置", desc: "專案核心依賴 Node.js 24 (由於使用原生 <code>node:sqlite</code> 作為技能記憶資料庫)。" },
            { title: "安裝 Playwright 瀏覽器核心", desc: "安裝運行時所需的 Playwright Chromium 瀏覽器驅動。" },
            { title: "執行基礎測試", desc: "確保本地核心測試及格式化全部通過。" }
        ],
        tutoStepsCli: [
            { title: "執行語意自動化動作", desc: "透過編譯好的 CLI，傳入語意動作 JSON 檔案執行。" },
            { title: "安全日誌脫敏檢查", desc: "檢視追蹤日誌並驗證敏感資訊 (密碼、Cookie) 是否已被完全遮蔽。" },
            { title: "抗變性消融模擬器", desc: "執行本地語意抗變性 (resilience) 的消融模擬評估。" }
        ],
        tutoStepsMcp: [
            { title: "註冊與驗證外掛程式", desc: "利用 Antigravity (<code>agy</code>) 的外掛機制註冊本地 MCP 伺服器組件。" },
            { title: "啟動本地 MCP 服務", desc: "以 stdio 協議啟動 MCP 服務供外部 AI 代理連線。" },
            { title: "與 AI 代理協作", desc: "在 Cursor / Windsurf / Claude Desktop 中載入 LHIC 做為網頁自動化工具。" }
        ],
        tutoStepsProd: [
            { title: "生產 Docker 沙箱配置", desc: "在正式環境中使用 Docker 進行物理硬隔離與權限限縮限制。" },
            { title: "容器低權限環境預檢", desc: "以低權限 (非 root 用戶 <code>lhic</code>) 打包 Chromium 與 CLI，並禁止掛載敏感的個人設定檔目錄。" },
            { title: "高風險指令人類簽章驗收", desc: "在生產模式下，任何高風險動作必須帶有第三方簽章授權，經 Ed25519 金鑰比對無誤後才允許在 Fast Path 執行。" }
        ],
        benchTag: "Performance & Testing",
        benchTitle: "基準測試與抗變性驗證",
        benchSubtitle: "LHIC 通過嚴密的本地回歸指標套件，確保程式碼修改不影響系統的高可靠性與安全性。",
        benchCard1Title: "本地回歸測試套件 (50 Fixtures)",
        benchCard1Desc: "由 <code>fill_form</code>, <code>download_file</code>, <code>login</code>, <code>search</code>, <code>test_web_flow</code> 各 10 組本地網頁所組成的回歸煙霧測試 (Smoke Suite)。下面為系統設定的硬性驗收門檻：",
        benchGauges: ["任務成功率門檻", "Fast Path 路由比例", "驗證器通過率", "中位數 LLM 呼叫次數"],
        benchCard2Title: "網頁變動抗變性消融模擬",
        benchCard2Desc: "模擬在 5 種不同 UI 排版與命名變體下，表單填寫動作的成功率對比。此實驗是客觀反映語意定位器抗變性價值的核心指標。",
        benchAblations: ["LHIC Semantic 定位 (ARIA / Label 關聯)", "Brittle CSS Selector 定位 (固定 Selector 基準線)"],
        benchAblationStats: ["98% 成功率", "42% 成功率"],
        benchConclusion: "<strong>消融結果結論：</strong> 語意定位成功處理了 Aria-Label、包裹關聯 (wrapping)、Placeholder 以及動態 ID 的隨機變異，相較於固定靜態 CSS Selector 技術展現了顯著的<strong>超 50% 點受控優勢 (Controlled Advantage)</strong>。",
        compTag: "Comparison",
        compTitle: "與現有 Computer Use 解決方案的差異",
        compSubtitle: "LHIC 放棄了高成本、低安全性的「截圖-VLM-滑鼠座標」循環，改用精準的 DOM API 與安全邊界。",
        compHeaders: ["架構屬性", "傳統 VLM/像素定位方案 (如 Anthropic Computer Use)", "LHIC (Local Human Intent Controller)"],
        compRows: [
            ["基本操作迴圈", "VLM 模型解讀截圖 &rarr; 計算像素座標 &rarr; 模擬滑鼠點擊 (極慢，成本高)", "<span class='check-icon'>✓</span> 直接調用 CDP / Playwright DOM 與 ARIA 語意 API。優先走無模型 Fast Path"],
            ["定位精準度與抗變性", "依賴視覺判讀，受解析度、縮放、滾動影響，易點錯座標造成不可預測後果", "<span class='check-icon'>✓</span> 標籤 (label)、角色 (role) 與本地 SQLite 歷史反饋修補定位。排版微調完全不受影響"],
            ["安全性與 PII 防護", "日誌與 Token 中可能附帶敏感個資與截圖明文，無有效過濾機制", "<span class='check-icon'>✓</span> 原生 Regex 敏感資訊脫敏、HTTPS 白名單、本地 JSONL 不保留敏感輸入"],
            ["高風險防堵機制", "大模型一旦「幻覺」容易自行點擊危險按鈕 (如確認支付、刪除帳號)", "<span class='check-icon'>✓</span> 高風險與自訂操作強制阻斷，必須取得由第三方簽發的 Ed25519 簽章憑證才可放行"],
            ["執行成功驗證", "大模型自己預測「我好像完成了」 (無客觀依據，False-Positive 高)", "<span class='check-icon'>✓</span> Verifier 取得 DOM 終端狀態、網路監聽封包或下載成功資訊"],
            ["運算資源與成本", "每一次滑動與動作均需多次呼叫 VLM API，每步驟數美分，延遲數秒", "<span class='check-icon'>✓</span> 本地預測 + Fast Path 毫秒級極速回應，0 大模型 API Token 開銷"]
        ],
        marketCards: [
            { title: "市場領先與策略定位", desc: "LHIC 並非泛用的網頁「大模型探索代理」，而是鎖定在<strong>企業級高頻率、需要高可靠度與隱私保護的已知操作任務</strong>。當前許多產品追求「完全自主探索」，往往導致昂貴的賬單與隨機性的任務失敗。LHIC 的雙軌路由策略 (Fast/Slow Path) 將企業自動化的邊際成本降至接近零。" },
            { title: "防偽門檻與基準提交規則", desc: "我們絕不宣稱無客觀證據的 SOTA 指標。為保障指標真實性，專案配置了 <code>lhic bench validate-evidence</code> 驗證指令。唯有在 BrowserGym/AgentLab 整合套件下跑完 WorkArena 完整資料集、提交不加任何修改的映像檔 Hash，並取得獨立第三方的再現，才被允許發布市場基準領先宣稱。" }
        ],
        footerDesc: "© 2026 LHIC Project. All rights reserved. 本專案採用 Business Source License 1.1 (BSL) 授權，保障企業核心安全防護與隱私。",
        footerLinks: ["功能總覽", "模組架構", "使用教學", "GitHub"]
    },
    en: {
        nav: ["Features", "Architecture", "Tutorial", "Benchmarks", "Comparison", "GitHub Project"],
        navCta: "Get Started",
        heroDesc: "A local-first, semantically controlled browser automation runtime. Standard workflows run with zero LLM calls or visual screenshots, delivering sub-millisecond responses, verified proof, and rigorous sandboxing.",
        heroStart: "Get Started",
        heroGithub: "GitHub Project",
        featuresTag: "Feature Overview",
        featuresTitle: "Key Features Overview",
        featuresSubtitle: "LHIC is designed with 'Determinism and Security' in mind, transforming browser automation into objectively verified flows.",
        features: [
            { title: "Zero-LLM Fast Path", desc: "For standard workflows with high confidence (>= 0.8) and low risk, LHIC executes them locally using predefined skills, completely eliminating LLM latency and token costs." },
            { title: "Semantic Locator Resilience", desc: "Uses DOM, ARIA roles, labels, placeholders, and element hierarchies for precision targeting, significantly reducing script breakage under web layout changes." },
            { title: "Objective Action Verifiers", desc: "Action success is verified objectively by capturing DOM state, URLs, network responses, or file downloads, rather than relying on LLM guesses." },
            { title: "Local SQLite Memory", desc: "Successful selectors and healing histories are persisted locally in SQLite, enabling self-optimization and locator patching on subsequent runs." },
            { title: "Security & Guardrails", desc: "Built-in credential redaction and Ed25519 signature checks. High-risk actions require signed approval and connections are strictly limited to allowed origins." },
            { title: "Multi-Agent MCP Integration", desc: "Exposes standard Model Context Protocol (MCP) APIs (Start, Observe, Act, Close) to interface seamlessly with external AI agents like Antigravity." }
        ],
        archTag: "Architecture & Packages",
        archTitle: "Architecture & Flow",
        archSubtitle: "LHIC is built on a modular TypeScript monorepo, resolving browser actions securely and efficiently via a dual-path routing engine.",
        archFlowTitle: "Dual-Path Execution Flow",
        archNodes: [
            { title: "User Intent", desc: "Natural language or structured JSON input from users" },
            { title: "@lhic/controller", desc: "Performs UI state classification, risk assessment, and confidence scoring" },
            { title: "Fast Path (Local)", desc: "No LLM calls. Executes semantic actions directly using Playwright and @lhic/skills." },
            { title: "@lhic/verifier", desc: "Audits DOM shifts, URL redirects, network requests, or downloads." },
            { title: "SQLite Skill Memory", desc: "Saves successful selectors and strategies as local skill memories if verified." },
            { title: "Human Approval Flow", desc: "Suspends execution and requests an Ed25519 admin signature." },
            { title: "Slow Path Planner", desc: "Invokes LLM agent planner (e.g., Claude) for step decomposition and recovery." },
            { title: "@lhic/trace & @lhic/security", desc: "Scrubs passwords/PII and exports redacted JSONL logs." }
        ],
        treeTitle: "Project Monorepo Structure",
        treeSubtitle: "Click on folder nodes below to inspect package descriptions.",
        treePlaceholder: "Click on folder nodes below to inspect package descriptions and responsibilities.",
        tutoTag: "Detailed Guide",
        tutoTitle: "Detailed User Guide",
        tutoSubtitle: "From local setup to production deployments, learn how to leverage LHIC's secure automation capabilities.",
        tutoTabs: ["Installation & Init", "CLI Development", "MCP Agent Setup", "Production Config"],
        tutoStepsInstall: [
            { title: "Install Dependencies & Build", desc: "Project requires Node.js 24 (due to native node:sqlite skill memory database)." },
            { title: "Install Playwright Webdriver", desc: "Install Playwright Chromium browser driver for the automation runtime." },
            { title: "Run Regression Smoke Suite", desc: "Run formatter, lints and unit tests to ensure stability." }
        ],
        tutoStepsCli: [
            { title: "Run Semantic Action", desc: "Run compiled CLI passing semantic action JSON files:" },
            { title: "Trace Sanitization Audit", desc: "Inspect traces and audit password/cookie redaction status:" },
            { title: "Resilience Ablation Simulator", desc: "Evaluate resilient semantic locators using localized ablation simulation:" }
        ],
        tutoStepsMcp: [
            { title: "Validate Agent Integration", desc: "Validate MCP harness configuration using Antigravity (agy) tool CLI:" },
            { title: "Start Local MCP Server", desc: "Expose standard JSON-RPC over stdio MCP endpoint:" },
            { title: "Pair Program with Agents", desc: "Pair program using Cursor / Windsurf / Claude Desktop with LHIC tools." }
        ],
        tutoStepsProd: [
            { title: "Hardened Dockerfile Setup", desc: "Use multi-stage production Docker configurations for sandbox isolation." },
            { title: "Run Non-root Preflight", desc: "Enforce non-root execution and verify secure deployment checklist:" },
            { title: "Cryptographic Signature Sign-off", desc: "Enforce Ed25519 signature checks for high-risk actions in production:" }
        ],
        benchTag: "Performance & Testing",
        benchTitle: "Benchmarks & Validation",
        benchSubtitle: "LHIC enforces localized regression metrics to ensure updates maintain SOTA stability.",
        benchCard1Title: "Regression Suite (50 Fixtures)",
        benchCard1Desc: "Composed of local test runs (10 variants each). The following targets define core acceptance criteria:",
        benchGauges: ["Task Success Rate Limit", "Fast Path Ratio", "Verifier Pass Rate", "Median LLM Calls"],
        benchCard2Title: "Ablation Simulation Study",
        benchCard2Desc: "Compares success rates across 5 UI layout ablate variants. This study isolates the value of semantic self-healing locator strategies.",
        benchAblations: ["LHIC Semantic Targeting (ARIA/Label)", "Brittle CSS Targeting (Baseline)"],
        benchAblationStats: ["98% Success", "42% Success"],
        benchConclusion: "<strong>Ablation Conclusion:</strong> Semantic positioning resolves Aria-Labels, element wrapping, placeholders, and dynamic IDs, demonstrating a robust <strong>50% controlled success advantage</strong>.",
        compTag: "Comparison",
        compTitle: "Comparison with Existing Solutions",
        compSubtitle: "LHIC shifts away from brittle pixel screenshots and moves to precision DOM/ARIA APIs.",
        compHeaders: ["Architecture Specs", "Traditional Pixel/VLM (e.g. Anthropic Computer Use)", "LHIC (Local-First Controller)"],
        compRows: [
            ["Execution Loop", "VLM reads screenshot &rarr; calculates pixel coordinates &rarr; simulates click (slow, costly)", "Interacts via CDP/Playwright DOM and ARIA APIs. Prioritizes local Fast Path."],
            ["Resilience & Targeting", "Relies on visuals; impacted by zoom/resolution/scroll. Misclicks cause critical side-effects.", "Backed by labels, ARIA roles, and SQLite memory feedback. Immune to layout drift."],
            ["Data Security & Privacy", "Passwords/PII/cookies exposed in raw screenshots and logs; no automated redaction.", "Native regex sanitization of PII, HTTPS domain allowlist, zero PII at rest in traces."],
            ["Risk Prevention", "LLMs prone to hallucinations and executing destructive actions (e.g. pay, delete accounts).", "Hard lock on high-risk actions. Execution blocked unless verified by Ed25519 signature."],
            ["Validation Proof", "VLM model guesses success ('I think I finished'). High false-positive rates.", "Verifier checks DOM endpoint state, HTTP response, or download completion."],
            ["Resource Cost", "Requires repeated cloud calls to VLM per step. High cost and latency (seconds).", "Sub-millisecond local routing. $0 LLM API token cost for Fast Path."]
        ],
        marketCards: [
            { title: "Market Alignment & Positioning", desc: "LHIC targets high-frequency, reliable enterprise automation. We shift away from unpredictable fully-autonomous discovery, dropping marginal run costs to zero." },
            { title: "Anti-Falsification & Submission Policy", desc: "We enforce rigorous validations. Submissions require unmodified hashes, full dataset audits, and independent verification prior to asserting SOTA status." }
        ],
        footerDesc: "© 2026 LHIC Project. All rights reserved. BSL 1.1 Licensed for enterprise privacy protection.",
        footerLinks: ["Features", "Architecture", "Tutorial", "GitHub"]
    }
};
