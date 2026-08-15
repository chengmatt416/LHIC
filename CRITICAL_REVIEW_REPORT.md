# LHIC 超級嚴格審查報告

## Local Human Intent Controller — Critical Architecture & Market Review

**審查日期**: 2026-08-07
**審查範圍**: 全部 12 個 packages、4 個 apps、所有測試、文檔、安全實現
**審查方法**: 14 個並行深度審查代理，逐文件源碼審計

---

## 一、執行摘要（Executive Summary）

### 總體評分：6.5 / 10

LHIC 是一個有野心的項目——試圖成為 computer-use agent 的安全執行運行時。它有紮實的安全基礎（Ed25519 approvals、PII redaction、AES-256-GCM encryption），清晰的 Fast Path / Slow Path 雙路架構，以及真實的 game training 實現。

**但距離 SOTA 還有顯著差距。** 以下是致命問題：

| 嚴重度      | 數量 | 說明                         |
| ----------- | ---- | ---------------------------- |
| 🔴 CRITICAL | 8    | 安全漏洞、架構缺陷、功能空殼 |
| 🟠 HIGH     | 12   | 會影響生產可用性的問題       |
| 🟡 MEDIUM   | 15   | 品質、測試、UX 問題          |
| 🟢 LOW      | 10   | 代碼品質、文檔問題           |

---

## 二、致命問題（CRITICAL — 必須立即修復）

### C1. 安全閥門繞過：低風險操作跳過所有審批驗證

**文件**: `packages/security/src/action-approval.ts`
**影響**: 災難性

`validateActionApproval` 在 `evaluateRisk` 返回 `requiresConfirmation: false` 時直接 return — 跳過簽名驗證、scope 檢查、hash 綁定、時間戳驗證、重放保護。攻擊者只需將 `riskLevel` 設為 `"low"` 就能繞過整個審批鏈。

更糟的是，破壞意圖檢測（`isDestructiveAction`）只用正則匹配確切關鍵詞（`delete`, `remove`, `pay`）。`terminate all sessions`、`purge old records` 等語義等價的表述全部通過。

### C2. 簽名驗證默認關閉

**文件**: `packages/security/src/action-approval.ts`, `packages/skills/src/os-bridge.ts`, `packages/browser/src/playwright-direct-executor.ts`
**影響**: 災難性

`requireSignature` 默認為 `process.env.LHIC_ENV === 'production'`。如果 `LHIC_ENV` 未設置（這是默認情況），所有操作在零密碼學驗證下運行。**沒有任何警告日誌。**

### C3. Claude Slow Path Provider 完全無功能

**文件**: `packages/controller/src/claude-provider.ts`
**影響**: 高

`ClaudeSlowPathProvider.reason()` 返回自由文本，**不返回結構化 actions**。`toStagePlan()` 要求 `actions.length > 0`，所以 Claude 的提案永遠產生 `undefined`，任務直接被 `blocked`。這意味著 Claude 作為 Slow Path 提供者是**完全無效的**——浪費預算調用然後阻塞任務。

### C4. 靜態 scrypt salt 消除部署間熵

**文件**: `packages/security/src/encryption.ts`, `packages/memory/src/workflow-state.ts`
**影響**: 高

`deriveKey` 使用硬編碼 salt `'lhic-encryption-v1'`。兩個使用相同 secret 的部署產生相同的 key。彩虹表可以輕易構建。應該使用 per-deployment 隨機 salt 存儲在密文旁邊。

### C5. BrowserPool 無並發保護

**文件**: `packages/browser/src/browser-pool.ts`
**影響**: 高

`acquirePage()` 和 `releasePage()` 操作一個 `Set` 但沒有鎖。兩個並發的 `acquirePage()` 調用可能同時看到 `size > 0`，抓取同一個 Set 迭代器條目，共享同一個 context。

### C6. HTTP Control Plane 完全是空殼

**文件**: `apps/mcp-server/src/control-plane.ts`
**影響**: 高

`ControlPlaneServer` 的兩個端點返回硬編碼響應（`"new-task-uuid"` 和 `"completed"`）。沒有實際的任務管理、沒有與 MCP session 的集成、沒有狀態持久化。任何依賴 HTTP API 提交或跟踪任務的客戶端會得到**偽造數據**。

### C7. SSRF DNS Rebinding TOCTOU

**文件**: `packages/browser/src/playwright-direct-executor.ts`
**影響**: 高

`validateNavigationTarget` 在導航時解析 DNS，但客戶端 JS 可以構造一個在 DNS 檢查通過後解析到私有 IP 的 URL（DNS rebinding）。`assertPublicHostname` 調用發生在 `route.fallback()` 之前，但實際的 TCP 連接發生在之後。

### C8. Schema 驗證器是篩子，不是牆

**文件**: `packages/schema/src/`
**影響**: 高

- `isTraceEvent` 接受任何 payload（`type` 是無約束的 `string`，`timestamp` 不檢查 ISO 8601）
- `isNormalizedUIState` 是淺層驗證——從不驗證 `UIObject` 元素
- `isUserIntent` 跳過 `riskLevel` 驗證——攻擊者可以設 `riskLevel: "none"` 繞過風險門控
- 所有頂層驗證器不拒絕未知 key
- 5 個 `Record<string, unknown>` 逃逸艙口

---

## 三、高嚴重度問題（HIGH — 影響生產可用性）

### H1. Confidence Scorer 是 4-bucket 枚舉，不是 scorer

`scoreConfidence()` 只返回 {0.3, 0.6, 0.65, 0.9} 四個值。沒有連續評分、沒有歷史準確率加權、沒有 per-stage 校準。0.8 閾值將整個 confidence 概念簡化為二元判斷。

### H2. Action Compiler 對大多數意圖產生空計劃

`compileActions()` 對 `login`、`form_filling`、`test_web_flow`、`unknown` 返回 `{ actions: [], missingInformation: [...] }`。這些意圖沒有本地計劃，`hasLocalPlan` 永遠是 false。在 `fast_only` 模式下，任務直接 `blocked`。

### H3. BrowserStateObserver 錯過 Shadow DOM

使用 `locator('button, input, select, textarea, canvas, a[href], [role]').evaluateAll()` — 完全錯過 Shadow DOM 封裝的控件、`<details>/<summary>`、`role="dialog"`、`div[tabindex]`。現代 SPA 大量使用 Shadow DOM。

### H4. 缺失依賴：`@lhic/verifier`

MCP server 導入 `VerifierEngine` 但 `package.json` 中沒有聲明 `@lhic/verifier` 依賴。只有因為 workspace hoisting 才能工作。

### H5. URL verifier 對非 HTTP URL 會崩潲

`new URL(url).searchParams.has(...)` 在 `page.url()` 返回 `about:blank` 或 `data:...` 時會拋出 `TypeError: Invalid URL`。

### H6. KMS 'revoked' 檢查是子字符串匹配

`keyId.includes('revoked')` — `'my-revokedkey-backup'` 被錯誤拒絕；真正已撤銷但名稱不含 'revoked' 的 key 從 cache 中提供過時數據。

### H7. KMS keyId→env-var 映射有碰撞風險

`keyId.toUpperCase().replace(/[^A-Z0-9_]/g, '_')` — `'my.key'` 和 `'my_key'` 映射到同一個 env var。

### H8. 簽名驗證錯誤被靜默吞掉

`isValidSignature` 和 `verifyKmsSignature` catch 所有錯誤並返回 false。網絡故障、格式錯誤的 key 或 crypto bug 靜默拒絕合法審批。

### H9. 硬編碼 scrypt salt 在 memory 包中重複

`packages/memory/src/skill-store.ts` 也使用相同的硬編碼 salt。

### H10. `ensureColumn()` 使用原始 SQL 插值

`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}` — 目前安全因為輸入是硬編碼的，但函數簽名接受任意字符串。

### H11. `failureCount` 是死代碼

`SelectorMemory` 的 `failureCount` 列存在於 schema 和 interface 中，但沒有方法寫入它。永遠返回 0。

### H12. OTel Exporter 完全無功能

沒有 parent-child spans、沒有 duration（startTime === endTime）、silent-drop、dead export。`pruneTraces` 也沒有外部消費者。

---

## 四、市場定位分析（Market Position）

### 競爭格局

| 產品                       | 定位               | LHIC 優勢            | LHIC 劣勢                            |
| -------------------------- | ------------------ | -------------------- | ------------------------------------ |
| **Playwright**             | 瀏覽器自動化框架   | 更高層抽象、安全審批 | Playwright 是基礎設施，LHIC 是應用層 |
| **BrowserUse**             | AI 瀏覽器代理      | 本地執行、安全邊界   | 社區大、模型支持廣                   |
| **Anthropic Computer Use** | 模型原生計算機控制 | 確定性 Fast Path     | 模型能力差距巨大                     |
| **UI-TARS**                | 視覺理解+操作      | 離線技能學習         | 視覺理解能力差距                     |
| **AgentQL**                | 結構化網頁數據     | 完整代理執行         | 數據提取更成熟                       |
| **WorkArena/WebArena**     | 基準測試           | 有基準意識           | 未在標準基準上驗證                   |

### SOTA 差距分析

**LHIC 聲稱的 SOTA 特徵 vs 實際狀態：**

1. ✅ **Fast Path 零 LLM 調用** — 真實，但只對 5 個內建技能有效
2. ❌ **語義定位彈性** — 80pp 提升只在受控 ablation 中，不是通用基準
3. ⚠️ **安全審批鏈** — 架構正確但實現有致命繞過漏洞
4. ⚠️ **技能學習** — 機制完整但 promotion gate 太保守（3 次獨立運行 + holdout）
5. ❌ **標準基準驗證** — 未在 WorkArena、WebArena、OSWorld 上驗證
6. ❌ **多模型支持** — Claude provider 完全無效
7. ⚠️ **Game training** — 真實實現但與核心價值主張關聯不清

### 市場弱點

1. **Node.js 24 硬性要求** — 排斥 90%+ 的潛在用戶
2. **無 Python SDK** — AI/ML 生態系統主要語言
3. **無標準基準分數** — 沒有 WorkArena/WebArena 成績，無法與 SOTA 對比
4. **npm 包名 `@pinyencheng/lhic`** — 個人 scope，不專業
5. **文檔主要面向評審，不是開發者** — 太多 "Build Week" 語言
6. **Desktop app 未發布** — Electron 應用仍是開發構建
7. **Shared skills 依賴 Appwrite** — 額外基礎設施依賴

---

## 五、架構問題

### A1. 雙重決策樹 drift 風險

`FastPathRouter.decide()` 和 `StageRouter.route()` 有並行但略有不同的決策邏輯。`decide()` 檢查 per-action risk，`route()` 只檢查 `intent.riskLevel`。Shadow mode 下兩者都運行，但 production 只用 `StageRouter`。

### A2. Controller barrel export 暴露所有內部 API

`packages/controller/src/index.ts` 導出 43 個符號——所有內部實現細節都是公共 API。

### A3. MCP server 1297 行單文件

`apps/mcp-server/src/index.ts` 把所有工具定義、session 管理、審批流程、stdio 入口點放在一個文件中。

### A4. CLI 使用手寫 if/else 路由

`apps/cli/src/main.ts` 是 ~340 行的順序 if/else 塊匹配命令字符串。沒有命令框架。

### A5. Reward 函數重複 3 次

`game-training-2d`、`game-training-3d` 和 `worker.py` 各自獨立實現相同的 reward 函數。

### A6. `requiresApproval()` 在兩個地方實現

`multi-path-task-controller.ts` 和 `browser-plan-runner.ts` 各自實現，邏輯略有不同。

---

## 六、測試覆蓋評估

| 類別          | 評分 | 說明                                       |
| ------------- | ---- | ------------------------------------------ |
| 安全路徑      | 8/10 | 幾乎每個邊界都測試了 PII redaction 和審批  |
| 技能集成      | 9/10 | 真實 Playwright 集成測試，帶 verifier 證據 |
| CLI 命令      | 9/10 | 每個命令都有測試                           |
| Browser 內部  | 5/10 | target-resolver（最關鍵組件）零測試        |
| Schema 驗證   | 3/10 | 52 個符號只有 3 個測試                     |
| Game training | 2/10 | 14 個源文件只有 2 個測試                   |
| Desktop app   | 6/10 | 主進程好，renderer 零測試                  |

**關鍵未測試路徑**：

- `target-resolver.ts` — 所有瀏覽器自動化的核心，200+ 行零測試
- `confidence-scorer.ts` — 直接決定 Fast/Slow Path 路由
- `stage-classifier.ts` — 意圖分類
- `preflight.ts` — 環境健康檢查
- `path-routing.ts` — 審計軌跡記錄

---

## 七、優先修復路線圖

### Phase 1: 安全補丁（立即）

1. 修復 VULN-01：低風險操作也必須通過基本驗證
2. 修復 VULN-02：requireSignature 默認 true
3. 修復 VULN-03：per-deployment random salt
4. 修復 C7：DNS rebinding 防護（pin resolved IP）
5. 修復 C5：BrowserPool 加鎖

### Phase 2: 功能補全（1-2 週）

1. Claude provider 結構化輸出
2. Confidence scorer 升級為連續函數
3. Action compiler 覆蓋所有意圖類型
4. Shadow DOM 支持
5. URL verifier 非 HTTP 防護

### Phase 3: SOTA 競爭力（2-4 週）

1. 標準基準集成（WorkArena/WebArena）
2. Python SDK
3. 多模型 benchmark 對比
4. 性能基準（延遲、成功率）
5. 社區文檔和貢獻指南

---

_報告基於 14 個並行源碼審計代理的逐文件分析。所有發現均可在源碼中直接驗證。_
