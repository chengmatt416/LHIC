# Benchmark 成本與需求分析

## 總覽

| 基準 | 任務數 | 需要 LLM API | 需要 Docker | 需要 VM | 預估成本 | 當前 SOTA |
|------|--------|-------------|-------------|---------|----------|-----------|
| **WebArena** | 812 | ✅ 是 | ✅ 是 | ❌ | ~$330 USD | 95.6% |
| **WebVoyager** | 643 | ✅ 是 | ❌ | ❌ | ~$150 USD | 89.1% |
| **OSWorld** | 369 | ✅ 是 | ❌ | ✅ 是 | ~$200 USD | 85% |
| **GAIA** | 466 | ✅ 是 | ❌ | ❌ | ~$91 USD | ~70% |

## 詳細成本分析

### WebArena (812 tasks)
- 平均 input tokens: 60,000/任務
- 平均 output tokens: 15,000/任務
- 使用 Claude Sonnet 4.6: ~$329/次
- 使用 GPT-4o: ~$200/次
- 使用 GPT-4.1: ~$150/次
- **需要 Docker 環境運行自託管網站**

### WebVoyager (643 tasks)
- 平均 input tokens: ~10,000/任務 (包含截圖)
- 平均 output tokens: ~2,000/任務
- 使用 GPT-4o: ~$50-80/次
- 使用 Claude Sonnet 4.6: ~$100-150/次
- **最容易運行，不需要 Docker**

### OSWorld (369 tasks)
- 需要 Linux 桌面 VM
- 需要 LLM API
- 預估成本: ~$200/次

## 為什麼需要 LLM API？

LHIC 的架構:
```
Fast Path (零 LLM) → 只對 5 個預學習技能有效
  - login
  - search
  - fill_form
  - download_file
  - test_web_flow

Slow Path (需要 LLM) → 對未知任務
  - 理解自然語言任務描述
  - 觀察 UI 狀態並決定行動
  - 處理錯誤和恢復
```

基準測試的任務是任意的（例如「找到一個有超過100條評論的素食千層麵食譜」），不是預先學習的技能。**必須使用 Slow Path (LLM)。**

## 建議方案

### 方案 A: 使用 OpenAI GPT-4o (最便宜)
- WebVoyager: ~$50-80
- WebArena: ~$200
- 總計: ~$250-280
- 需要: OpenAI API key

### 方案 B: 使用 Claude Sonnet 4.6 (最佳品質)
- WebVoyager: ~$100-150
- WebArena: ~$330
- 總計: ~$430-480
- 需要: Anthropic API key

### 方案 C: 使用開源模型 (免費但品質較低)
- 使用 Llama 3.1 70B 或 Qwen2.5 72B
- 需要: 本地 GPU 或 Together AI / Fireworks AI API
- Together AI: ~$0.9/1M tokens → 總計 ~$50-100
- 需要: 本地 2×A100 GPU 或雲端 API

### 方案 D: 先跑小樣本驗證
- WebVoyager 50 任務: ~$5-10
- 驗證架構可行後再跑完整版
- 最低風險

## 需要你提供的

1. **API Key**: OpenAI 或 Anthropic
2. **預算**: 你願意花多少？
3. **環境**: 是否有 Docker？是否有 GPU？

## 排行榜第一的現實

當前 SOTA:
- WebArena: 95.6% (Qwen3-235B-A22B)
- WebVoyager: 89.1% (Browser Use + GPT-4o)
- OSWorld: 85% (Claude Mythos 5)

**要達到第一，需要:**
1. 強大的 LLM backbone (GPT-4o/Claude/GPT-5)
2. LHIC 的學習和優化框架
3. 完整的基準運行
4. 可能需要多次運行和調優

**估計總成本: $300-500 USD 用於 API 調用**
