# 第三方基準提交指南

## 📋 總覽

以下是你需要申請/提交的基準，按優先級排序：

---

## 1️⃣ WebArena（最重要）

**網站**: https://webarena.dev/
**代碼**: https://github.com/web-arena-x/webarena
**任務數**: 812 個瀏覽器任務
**當前 SOTA**: 95.6% (Qwen3-235B-A22B)

### 如何提交
- **不需要申請** — 自託管開源基準
- 本地運行 Docker 環境，執行你的 agent，發布結果到 GitHub/論文
- 社區通過 GitHub、arXiv、Steel.dev 追蹤結果

### 步驟
```bash
# 1. Fork 倉庫
git clone https://github.com/web-arena-x/webarena.git
cd webarena

# 2. 啟動 Docker 環境
docker compose up -d

# 3. 運行你的 agent
python run.py --agent lhic

# 4. 發布結果到 GitHub
# 5. 提交到 Steel.dev 或發布 arXiv 論文
```

### 你需要準備
- [x] GitHub 倉庫（已有）
- [ ] WebArena 環境（需要 Docker）
- [ ] Agent 適配器代碼
- [ ] 完整執行軌跡
- [ ] 技術報告

---

## 2️⃣ OSWorld（桌面自動化）

**網站**: https://osworld-v1.xlang.ai/
**代碼**: https://github.com/xlang-ai/osworld
**任務數**: 369 個桌面任務
**當前 SOTA**: 85% (Claude Mythos 5)

### 如何提交
- **需要聯繫維護者** — 需要在他們的環境中運行驗證
- 提交到 https://github.com/xlang-ai/osworld 的 Issues
- 或聯繫 xlang-ai 團隊安排評估

### 步驟
```bash
# 1. Fork 倉庫
git clone https://github.com/xlang-ai/osworld.git
cd osworld

# 2. 安裝依賴
pip install -r requirements.txt

# 3. 運行評估
python run_eval.py --agent lhic

# 4. 提交結果到維護者
```

### 你需要準備
- [x] GitHub 倉庫（已有）
- [ ] Linux VM 環境
- [ ] Agent 適配器代碼
- [ ] 聯繫維護者

---

## 3️⃣ WebVoyager（真實網站）

**代碼**: https://github.com/MinorJerry/WebVoyager
**任務數**: 643 個真實網站任務
**當前 SOTA**: 89.1% (Browser Use)

### 如何提交
- **不需要申請** — 自託管開源基準
- 本地運行，發布結果到 GitHub/論文
- 社區通過 GitHub 追蹤結果

### 步驟
```bash
# 1. Fork 倉庫
git clone https://github.com/MinorJerry/WebVoyager.git
cd WebVoyager

# 2. 安裝依賴
pip install -r requirements.txt

# 3. 運行評估
python auto_eval.py --agent lhic

# 4. 發布結果到 GitHub
```

### 你需要準備
- [x] GitHub 倉庫（已有）
- [ ] Agent 適配器代碼
- [ ] 完整執行軌跡
- [ ] 技術報告

---

## 4️⃣ WorkArena（企業自動化）

**網站**: https://workarena.servicenow.com/
**代碼**: https://github.com/ServiceNow/WorkArena
**任務數**: 341 個企業任務
**注意**: 需要 Hugging Face 門控訪問

### 如何提交
- **需要申請** — 需要 Hugging Face 門控訪問
- 申請地址: https://huggingface.co/datasets/ServiceNow/WorkArena
- 提交結果到 GitHub Issues

### 步驟
1. 申請 Hugging Face 門控訪問
2. 等待批准
3. 下載數據集
4. 運行評估
5. 提交結果

---

## 5️⃣ BrowserGym（元框架）

**代碼**: https://github.com/ServiceNow/BrowserGym
**用途**: 統一多個基準的評估框架

### 如何使用
```bash
# 安裝
pip install browsergym

# 運行 WebArena
python -m browsergym.webarena --agent lhic

# 運行 WorkArena
python -m browsergym.workarena --agent lhic
```

---

## 📝 提交模板

### GitHub Issue 模板（用於 WebArena/OSWorld）

```markdown
# LHIC Benchmark Submission

## Agent Information
- **Name**: LHIC (Local Human Intent Controller)
- **Version**: 0.1.0
- **Repository**: https://github.com/chengmatt416/LHIC

## Results

### WebArena (812 tasks)
- Success Rate: X%
- Average Steps: X
- Average Latency: Xms

### OSWorld (369 tasks)
- Success Rate: X%
- Average Steps: X

## Methodology
- Observation: DOM + Accessibility Tree
- Action Space: Semantic actions (click, fill, navigate, etc.)
- Planning: Fast Path (zero LLM calls) + Slow Path (GPT-5.6/Claude)
- Learning: One-shot learning, failure learning, skill composition

## Reproduction
```bash
git clone https://github.com/chengmatt416/LHIC.git
cd LHIC
npm ci
npm run build
npm run bench:webarena
```

## Artifacts
- Execution traces: [link]
- Screenshots: [link]
- Technical report: [link]
```

---

## 🎯 優先級建議

### 立即（本週）
1. ✅ 推送代碼到 GitHub
2. ✅ 準備技術報告
3. ⏳ 申請 WorkArena Hugging Face 訪問

### 短期（1-2 週）
1. 運行 WebVoyager（最簡單，不需要 Docker）
2. 發布結果到 GitHub
3. 提交到 Steel.dev

### 中期（2-4 週）
1. 運行 WebArena（需要 Docker）
2. 運行 OSWorld（需要 Linux VM）
3. 聯繫 OSWorld 維護者

### 長期（1-2 月）
1. 發布 arXiv 論文
2. 提交到所有基準
3. 申請學術會議

---

## 📞 聯繫方式

| 基準 | 聯繫方式 |
|------|----------|
| WebArena | GitHub Issues: https://github.com/web-arena-x/webarena |
| OSWorld | GitHub Issues: https://github.com/xlang-ai/osworld |
| WebVoyager | GitHub Issues: https://github.com/MinorJerry/WebVoyager |
| WorkArena | Hugging Face: https://huggingface.co/datasets/ServiceNow/WorkArena |
| Steel.dev | https://leaderboard.steel.dev |

---

## 💡 提示

1. **透明度** — 公開所有執行軌跡和方法論
2. **可重現性** — 提供詳細的重現步驟
3. **完整性** — 運行完整套件，不要選擇性報告
4. **誠實** — 報告所有失敗和限制
5. **社區** — 參與 GitHub 討論，回應問題
