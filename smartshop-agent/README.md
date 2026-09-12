# 🛍️ SmartShop AI Agent

> **Anakin Forge Hackathon Submission · Sept 7–14, 2026**
> Prizes: 🥇 PS5 · 🥈 MSI Gaming Monitor

An autonomous AI shopping agent that takes a plain-English query, searches Amazon and Walmart **live**, reasons through prices / ratings / reviews using a multi-step pipeline, generates an **AI-powered recommendation**, and can autonomously **add the best pick to your cart** using a real cloud browser.

---

## Hackathon criteria — all three covered

| Criterion | How SmartShop satisfies it |
|---|---|
| ✅ **Browse & read live web content** | Steps 2 + 4: real-time Wire API calls to Amazon (`am_search_products`, `am_product_details`) and Walmart (`walmart_search`, `walmart_reviews`). Step 6: Anakin `search` tool fetches live editorial web reviews for the top product. |
| ✅ **Reason through multi-step tasks** | 6-step autonomous pipeline: parse intent → parallel search → normalize → enrich (with live details + reviews) → score/rank (5-dimension scoring model) → AI deep-research summary. Every step depends on the previous one's output. |
| ✅ **Take real action** | Step 6 fires Anakin `deep_research` to generate a structured AI recommendation. The UI exposes per-product action buttons: Amazon opens the `/gp/aws/cart/add` pre-filled cart URL; the `browser_task` MCP tool drives a real cloud Chromium instance to navigate the product page and attempt an add-to-cart — all without human clicks. |

---

## Architecture

```
User query (plain English)
         │
         ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Step 1 · Parse Intent                                    │
  │  parser.js — extract keywords, budget, category, sort    │
  └────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Step 2 · Live Search  (parallel)                         │
  │  Wire: am_search_products  +  walmart_search              │
  └────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Step 3 · Normalise                                       │
  │  normalizer.js — unified schema across both platforms    │
  └────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Step 4 · Enrich  (top 4 per platform, parallel)          │
  │  Wire: am_product_details + am_product_reviews            │
  │  Wire: walmart_product_details + walmart_reviews          │
  └────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Step 5 · Score & Rank                                    │
  │  reasoner.js — 100-pt model: value/rating/reviews/        │
  │                features/stock. Peer-relative pricing.     │
  └────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Step 6 · Live Web + AI Summary                           │
  │  Anakin search — live editorial web reviews               │
  │  Anakin deep_research — structured AI recommendation      │
  │  (verdict · recommendation · pros · cons)                 │
  └────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Action Layer                                             │
  │  Amazon: /gp/aws/cart/add  (pre-filled cart URL)          │
  │  All:    browser_task  (Anakin cloud browser agent)       │
  │          navigates → finds Add to Cart → clicks           │
  └──────────────────────────────────────────────────────────┘
```

---

## Anakin MCP tools used

| Tool | Step | Purpose |
|---|---|---|
| `wire_read_action → am_search_products` | 2 | Amazon keyword product search |
| `wire_read_action → walmart_search` | 2 | Walmart keyword product search |
| `wire_read_action → am_product_details` | 4 | Amazon product detail enrichment |
| `wire_read_action → am_product_reviews` | 4 | Amazon review data enrichment |
| `wire_read_action → walmart_product_details` | 4 | Walmart product detail enrichment |
| `wire_read_action → walmart_reviews` | 4 | Walmart review data enrichment |
| `search` | 6 | Live web editorial review search |
| `deep_research` | 6 | AI-generated structured recommendation |
| `browser_task` | Action | Cloud browser add-to-cart automation |
| `scrape` | Action | Product page full-spec extraction |

---

## Tech stack

- **Runtime**: Node.js 20
- **AI / Data**: [Anakin MCP](https://mcp.anakin.io/mcp) — Wire API, web search, deep research, browser tasks
- **Web server**: Express 5 (SSE streaming)
- **CLI**: chalk + ora
- **Frontend**: Vanilla JS / CSS — no framework, instant load, dark theme

---

## Quick start

### 1. Install

```bash
cd smartshop-agent
npm install
```

### 2. Configure

```
ANAKIN_API_KEY=ask_your_key_here
ANAKIN_MCP_URL=https://mcp.anakin.io/mcp
PORT=3000
```

### 3. Run the web UI

```bash
npm start
# → http://localhost:3000
```

### 4. Run the CLI

```bash
node src/cli.js "best laptop under $800 for coding"
node src/cli.js "wireless headphones between $50 and $150"
node src/cli.js --no-enrich "4K TV under $500"
node src/cli.js --json "gaming headset under $80"   # raw JSON
node src/cli.js --help
```

---

## API reference

### `POST /api/search` — full pipeline, returns JSON

```json
{
  "query": "best laptop under $800 for coding",
  "enrichWalmart": true,
  "includeWebContext": true,
  "limit": 12
}
```

**Response shape**

```json
{
  "success": true,
  "intent":      { "keywords": "laptop for coding", "maxPrice": 800, "category": "electronics" },
  "products":    [ { "rank": 1, "title": "...", "price": 749.99, "score": 82, "actionUrl": "...", "actionLabel": "Add to Amazon Cart" } ],
  "table":       [ ... ],
  "topSummary":  { "verdict": "...", "recommendation": "...", "pros": [...], "cons": [...] },
  "webSnippets": [ { "title": "...", "snippet": "...", "url": "..." } ],
  "actionItems": [ { "title": "...", "platform": "amazon", "url": "...", "score": 82 } ],
  "sources":     { "amazon": 12, "walmart": 11 },
  "durationMs":  14200
}
```

### `GET /api/search/stream?q=<query>` — SSE live progress

```
event: step        → { step: 2, label: "🛒 Searching Amazon & Walmart live…" }
event: intent      → { keywords, maxPrice, category, … }
event: raw_counts  → { amazon: 12, walmart: 11 }
event: web_context → { snippets: [{title, snippet, url}] }
event: ai_summary  → { verdict, recommendation, pros, cons }
event: warning     → { message }
event: done        → full result object
```

### `GET /api/action/stream?url=&platform=&id=&title=` — browser task SSE

Launches an Anakin cloud browser agent to navigate to the product page and add to cart.

```
event: step  → { label: "🌐 Navigating to Amazon product page…" }
event: done  → { browserResult: { success, steps_taken, cart_status, final_url } }
```

---

## Scoring model

Every product is scored out of 100 across five dimensions:

| Dimension | Max | Logic |
|---|---|---|
| Value | 30 | Price relative to peers + budget ceiling; respects sort preference |
| Rating | 25 | Star rating × review-volume credibility (log-scaled) |
| Reviews | 20 | Log-scaled review count against peer maximum |
| Features | 15 | Feature richness (bullet count) + keyword relevance to query |
| Stock | 10 | In-stock flag (6 pts) + Prime / Walmart+ shipping (4 pts) |

---

## Project structure

```
smartshop-agent/
├── src/
│   ├── api/
│   │   └── anakinClient.js    ← MCP HTTP client — all Anakin tool wrappers
│   ├── agent/
│   │   ├── parser.js          ← NL query → intent (budget, keywords, category)
│   │   ├── normalizer.js      ← Amazon + Walmart raw → unified product schema
│   │   ├── reasoner.js        ← 5-dimension scoring, ranking, comparison table
│   │   ├── smartshop.js       ← 6-step pipeline orchestrator (EventEmitter)
│   │   └── actions.js         ← Action layer (cart URL, browser_task, scrape)
│   ├── ui/public/
│   │   └── index.html         ← Web UI (SSE streaming, pipeline viz, dark theme)
│   ├── cli.js                 ← Terminal interface
│   └── server.js              ← Express server + all API endpoints
├── .env
├── package.json
└── README.md
```

---

*Built for the [Anakin Forge Hackathon](https://anakin.io/hackathon/anakin-forge) · Sept 7–14, 2026*
*Registered on [Unstop](https://unstop.com/hackathons/anakin-forge-hackathon-anakin-skywalker-pvt-ltd-1742485)*
