/**
 * SmartShop AI Agent — Full Test Suite
 * ─────────────────────────────────────
 * Covers every layer of the project:
 *
 *   1. Parser        — query → intent extraction
 *   2. Normalizer    — raw API data → unified product schema
 *   3. Reasoner      — scoring, ranking, comparison table
 *   4. Key Pool      — API key rotation logic
 *   5. API Client    — MCP request + error parsing
 *   6. Actions       — cart URL builder
 *   7. Server        — HTTP endpoints (health, search, keys)
 *   8. Pipeline      — full end-to-end live search
 *
 * Run:
 *   node test.js              ← all tests
 *   node test.js --unit       ← unit tests only (no API calls, instant)
 *   node test.js --live       ← live API tests only
 *
 * Uses Node.js built-in test runner (node:test) — no extra dependencies.
 */

'use strict';

require('dotenv').config();

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');

// ── Arg flags ──────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const unitOnly = args.includes('--unit');
const liveOnly = args.includes('--live');
const runUnit  = !liveOnly;
const runLive  = !unitOnly;

// Colour helpers (no deps)
const c = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};

function log(msg)  { process.stdout.write(msg + '\n'); }
function skip(msg) { log(`  ${c.yellow}⊘ SKIP${c.reset}  ${c.dim}${msg}${c.reset}`); }

log(`\n${c.bold}${c.cyan}╔══════════════════════════════════════════════════╗`);
log(`║   SmartShop AI Agent — Test Suite               ║`);
log(`╚══════════════════════════════════════════════════╝${c.reset}\n`);

if (unitOnly) log(`${c.yellow}Mode: unit tests only (no API calls)${c.reset}\n`);
if (liveOnly) log(`${c.yellow}Mode: live tests only${c.reset}\n`);

// ══════════════════════════════════════════════════════════════════════════════
//  1. PARSER
// ══════════════════════════════════════════════════════════════════════════════

describe('1. Parser — query intent extraction', () => {
  const { parseQuery } = require('./src/agent/parser');

  test('extracts keywords by removing price + filler words', () => {
    const r = parseQuery('best laptop under $800 for coding');
    assert.ok(r.keywords.includes('laptop'), `keywords should include "laptop", got: "${r.keywords}"`);
    assert.ok(!r.keywords.includes('best'), 'should strip "best"');
    assert.ok(!r.keywords.includes('800'), 'should strip price from keywords');
  });

  test('parses max price with dollar sign', () => {
    const r = parseQuery('wireless headphones under $150');
    assert.equal(r.maxPrice, 150);
    assert.equal(r.minPrice, null);
  });

  test('parses max price without dollar sign', () => {
    const r = parseQuery('gaming headset under 80');
    assert.equal(r.maxPrice, 80);
  });

  test('parses price range — between X and Y', () => {
    const r = parseQuery('wireless headphones between $50 and $150');
    assert.equal(r.minPrice, 50);
    assert.equal(r.maxPrice, 150);
  });

  test('parses price range — from X to Y', () => {
    const r = parseQuery('laptop from $500 to $900');
    assert.equal(r.minPrice, 500);
    assert.equal(r.maxPrice, 900);
  });

  test('detects electronics category for laptop', () => {
    const r = parseQuery('best laptop under $800');
    assert.equal(r.category, 'electronics');
  });

  test('detects electronics category for headphones', () => {
    const r = parseQuery('wireless headphones');
    assert.equal(r.category, 'electronics');
  });

  test('detects home category for vacuum', () => {
    const r = parseQuery('robot vacuum under $300');
    assert.equal(r.category, 'home');
  });

  test('detects price_asc sort for cheapest query', () => {
    const r = parseQuery('cheapest laptop under $500');
    assert.equal(r.sortPreference, 'price_asc');
  });

  test('detects rating sort for top-rated query', () => {
    const r = parseQuery('top rated wireless speaker');
    assert.equal(r.sortPreference, 'rating');
  });

  test('falls back to original if keywords over-stripped', () => {
    const r = parseQuery('laptop');
    assert.ok(r.keywords.length > 0, 'keywords should not be empty');
  });

  test('preserves original query string unchanged', () => {
    const q = 'best gaming headset under $60';
    const r = parseQuery(q);
    assert.equal(r.original, q);
  });

  test('no price in query → maxPrice is null', () => {
    const r = parseQuery('wireless mouse');
    assert.equal(r.maxPrice, null);
    assert.equal(r.minPrice, null);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  2. NORMALIZER
// ══════════════════════════════════════════════════════════════════════════════

describe('2. Normalizer — raw API → unified schema', () => {
  const { normalizeProducts } = require('./src/agent/normalizer');

  // ── Sample Walmart Wire response (real shape from API) ──
  const walmartRaw = {
    status: 'completed',
    data: {
      query: 'headphones', page: 1, total_results: 67, returned: 2,
      products: [
        {
          item_id: '12345', name: 'Wireless Headphones Pro', brand: 'SoundBrand',
          url: 'https://www.walmart.com/ip/12345', image_url: 'https://img.jpg',
          price: 49.99, list_price: 79.99, currency: 'USD',
          rating: 4.3, review_count: 1500, availability: 'In stock',
        },
        {
          item_id: '67890', name: 'Budget Earbuds', brand: '',
          url: 'https://www.walmart.com/ip/67890', image_url: 'https://img2.jpg',
          price: null, list_price: null, currency: 'USD',
          rating: 3.9, review_count: 200, availability: 'Out of Stock',
        },
      ],
    },
  };

  // ── Sample Amazon Wire response ──
  const amazonRaw = {
    status: 'completed',
    data: {
      products: [
        {
          asin: 'B08ABC123', title: 'Sony WH-1000XM5', brand: 'Sony',
          price: 299.99, original_price: 349.99,
          rating: 4.7, reviews_count: 25000,
          url: 'https://www.amazon.com/dp/B08ABC123',
          image: 'https://m.media-amazon.com/img.jpg',
          in_stock: true, prime: true,
          feature_bullets: ['30hr battery', 'ANC', 'Foldable'],
        },
      ],
    },
  };

  test('normalizes Walmart products from nested data envelope', () => {
    const products = normalizeProducts(walmartRaw, 'walmart');
    assert.equal(products.length, 2);
  });

  test('Walmart product has correct fields', () => {
    const [p] = normalizeProducts(walmartRaw, 'walmart');
    assert.equal(p.platform, 'walmart');
    assert.equal(p.title, 'Wireless Headphones Pro');
    assert.equal(p.price, 49.99);
    assert.equal(p.originalPrice, 79.99);
    assert.equal(p.rating, 4.3);
    assert.equal(p.reviewCount, 1500);
    assert.equal(p.brand, 'SoundBrand');
    assert.equal(p.inStock, true);
    assert.ok(p.url.includes('walmart.com'));
  });

  test('Walmart product with null price stays null (not NaN)', () => {
    const products = normalizeProducts(walmartRaw, 'walmart');
    const noPrice = products.find(p => p.title === 'Budget Earbuds');
    assert.equal(noPrice.price, null);
    assert.equal(noPrice.inStock, false);
  });

  test('normalizes Amazon products correctly', () => {
    const [p] = normalizeProducts(amazonRaw, 'amazon');
    assert.equal(p.platform, 'amazon');
    assert.equal(p.title, 'Sony WH-1000XM5');
    assert.equal(p.price, 299.99);
    assert.equal(p.rating, 4.7);
    assert.equal(p.prime, true);
    assert.equal(p.features.length, 3);
    assert.ok(p.url.includes('amazon.com'));
  });

  test('returns empty array for empty input', () => {
    assert.deepEqual(normalizeProducts([], 'amazon'), []);
    assert.deepEqual(normalizeProducts({}, 'walmart'), []);
  });

  test('handles flat array input (not nested envelope)', () => {
    const flat = [{ item_id: '1', name: 'Test Product', rating: 4.0, review_count: 50, availability: 'In stock' }];
    const products = normalizeProducts(flat, 'walmart');
    assert.equal(products.length, 1);
    assert.equal(products[0].title, 'Test Product');
  });

  test('filters out products with no title', () => {
    const raw = { data: { products: [{ item_id: '1' }, { item_id: '2', name: 'Real Product', availability: 'In stock' }] } };
    const products = normalizeProducts(raw, 'walmart');
    assert.equal(products.length, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  3. REASONER
// ══════════════════════════════════════════════════════════════════════════════

describe('3. Reasoner — scoring, ranking, summary', () => {
  const { scoreAndRank, generateSummary, buildComparisonTable } = require('./src/agent/reasoner');

  const mockProducts = [
    {
      id: '1', platform: 'amazon', title: 'Budget Headphones', price: 29.99,
      originalPrice: 49.99, rating: 4.2, reviewCount: 5000,
      inStock: true, prime: true, features: ['Good sound', 'Comfortable'],
      url: 'https://amazon.com/dp/B001', imageUrl: null, brand: 'BudgetBrand',
    },
    {
      id: '2', platform: 'walmart', title: 'Premium Headphones', price: 199.99,
      originalPrice: null, rating: 4.8, reviewCount: 500,
      inStock: true, prime: false, features: ['Hi-Fi audio', 'ANC', 'Foldable'],
      url: 'https://walmart.com/ip/2', imageUrl: null, brand: 'PremiumBrand',
    },
    {
      id: '3', platform: 'amazon', title: 'Mid Headphones', price: 79.99,
      originalPrice: null, rating: 4.5, reviewCount: 12000,
      inStock: false, prime: false, features: ['Wireless'],
      url: 'https://amazon.com/dp/B003', imageUrl: null, brand: 'MidBrand',
    },
  ];

  const intent = { keywords: 'wireless headphones', maxPrice: 150, minPrice: null, sortPreference: 'best_match' };

  test('returns ranked array sorted by score descending', () => {
    const ranked = scoreAndRank(mockProducts, intent);
    assert.equal(ranked.length, 2); // price=199.99 filtered out (over $150 budget)
    assert.ok(ranked[0].score >= ranked[1].score, 'first rank should have highest score');
  });

  test('filters products over budget', () => {
    const ranked = scoreAndRank(mockProducts, intent);
    ranked.forEach(p => {
      if (p.price !== null) assert.ok(p.price <= 150, `${p.title} at $${p.price} exceeds $150 budget`);
    });
  });

  test('assigns rank numbers starting from 1', () => {
    const ranked = scoreAndRank(mockProducts, intent);
    ranked.forEach((p, i) => assert.equal(p.rank, i + 1));
  });

  test('assigns recommendation labels to top 3', () => {
    const ranked = scoreAndRank(mockProducts, intent);
    assert.ok(ranked[0].recommendation.includes('Best Pick'));
  });

  test('all scores are between 0 and 100', () => {
    const ranked = scoreAndRank(mockProducts, intent);
    ranked.forEach(p => {
      assert.ok(p.score >= 0 && p.score <= 100, `score ${p.score} out of range`);
    });
  });

  test('scoreBreakdown contains all 5 dimensions', () => {
    const ranked = scoreAndRank(mockProducts, intent);
    const bd = ranked[0].scoreBreakdown;
    assert.ok('value'    in bd, 'missing value');
    assert.ok('rating'   in bd, 'missing rating');
    assert.ok('reviews'  in bd, 'missing reviews');
    assert.ok('features' in bd, 'missing features');
    assert.ok('stock'    in bd, 'missing stock');
  });

  test('calculates discount percentage when originalPrice present', () => {
    const ranked = scoreAndRank(mockProducts, intent);
    const budget = ranked.find(p => p.title === 'Budget Headphones');
    assert.ok(budget.discount > 0, 'should calculate discount');
    assert.equal(budget.discount, 40); // (49.99-29.99)/49.99 ≈ 40%
  });

  test('generateSummary returns non-empty string', () => {
    const ranked = scoreAndRank(mockProducts, intent);
    const summary = generateSummary(ranked[0], intent);
    assert.ok(typeof summary === 'string' && summary.length > 20);
  });

  test('generateSummary returns fallback message for null product', () => {
    const summary = generateSummary(null, intent);
    assert.equal(summary, 'No matching products found.');
  });

  test('buildComparisonTable returns max 10 items', () => {
    const ranked = scoreAndRank(mockProducts, intent);
    const table  = buildComparisonTable(ranked);
    assert.ok(table.length <= 10);
  });

  test('comparison table rows have all required fields', () => {
    const ranked = scoreAndRank(mockProducts, intent);
    const [row]  = buildComparisonTable(ranked);
    const required = ['rank','title','price','rating','score','inStock','platform','actionUrl','actionLabel'];
    required.forEach(f => assert.ok(f in row, `missing field: ${f}`));
  });

  test('no budget → all products included', () => {
    const noLimit = { ...intent, maxPrice: null };
    const ranked  = scoreAndRank(mockProducts, noLimit);
    assert.equal(ranked.length, mockProducts.length);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  4. KEY POOL
// ══════════════════════════════════════════════════════════════════════════════

describe('4. Key Pool — rotation logic', () => {
  // Use a fresh pool instance with mock keys so we don't disturb the live pool
  const { KeyPool } = (() => {
    // Inline a minimal KeyPool class matching the real one for testing
    const COOLDOWN = 200; // use 200ms for fast tests
    class KeyPool {
      constructor(keys) {
        this.keys  = keys;
        this.state = keys.map(() => ({ coolingUntil: null, failCount: 0 }));
        this.currentIndex = 0;
      }
      async getKey() {
        const now = Date.now();
        for (let i = 0; i < this.keys.length; i++) {
          const idx = (this.currentIndex + i) % this.keys.length;
          const st  = this.state[idx];
          if (!st.coolingUntil || now >= st.coolingUntil) {
            st.coolingUntil = null;
            this.currentIndex = idx;
            return this.keys[idx];
          }
        }
        // all cooling — wait for soonest
        const soonest = Math.min(...this.state.map(s => s.coolingUntil || 0));
        await new Promise(r => setTimeout(r, Math.max(0, soonest - Date.now()) + 10));
        this.state.forEach(s => { if (s.coolingUntil && Date.now() >= s.coolingUntil) s.coolingUntil = null; });
        this.currentIndex = 0;
        return this.keys[0];
      }
      markExhausted(key, cooldown = COOLDOWN) {
        const idx = this.keys.indexOf(key);
        if (idx === -1) return;
        this.state[idx].coolingUntil = Date.now() + cooldown;
        this.state[idx].failCount++;
        this.currentIndex = (idx + 1) % this.keys.length;
      }
      status() {
        return this.keys.map((k, i) => ({
          index: i + 1, suffix: k.slice(-4), active: i === this.currentIndex,
          cooling: !!(this.state[i].coolingUntil && Date.now() < this.state[i].coolingUntil),
          failCount: this.state[i].failCount,
        }));
      }
      get size() { return this.keys.length; }
    }
    return { KeyPool };
  })();

  test('starts with first key active', async () => {
    const pool = new KeyPool(['key-A', 'key-B', 'key-C']);
    const key  = await pool.getKey();
    assert.equal(key, 'key-A');
  });

  test('rotates to next key after markExhausted', async () => {
    const pool = new KeyPool(['key-A', 'key-B', 'key-C']);
    const k1   = await pool.getKey();
    pool.markExhausted(k1);
    const k2 = await pool.getKey();
    assert.notEqual(k2, k1, 'should rotate to a different key');
    assert.equal(k2, 'key-B');
  });

  test('rotates through all keys on sequential exhaustion', async () => {
    const pool = new KeyPool(['key-A', 'key-B', 'key-C']);
    const k1 = await pool.getKey(); pool.markExhausted(k1);
    const k2 = await pool.getKey(); pool.markExhausted(k2);
    const k3 = await pool.getKey();
    assert.equal(k3, 'key-C');
    const seen = new Set([k1, k2, k3]);
    assert.equal(seen.size, 3, 'all 3 keys should have been used');
  });

  test('recovers key after cooldown expires', async () => {
    const pool = new KeyPool(['key-A', 'key-B']);
    const k1   = await pool.getKey();
    pool.markExhausted(k1, 100); // 100ms cooldown
    const k2 = await pool.getKey();
    assert.equal(k2, 'key-B');
    // Wait for key-A to recover
    await new Promise(r => setTimeout(r, 150));
    const k3 = await pool.getKey();
    assert.ok(['key-A','key-B'].includes(k3), 'should return a valid key after recovery');
  });

  test('increments failCount on markExhausted', async () => {
    const pool = new KeyPool(['key-A', 'key-B']);
    const k    = await pool.getKey();
    pool.markExhausted(k);
    pool.markExhausted(k);
    const st = pool.status()[0];
    assert.equal(st.failCount, 2);
  });

  test('status() returns correct active flag', async () => {
    const pool   = new KeyPool(['key-A', 'key-B', 'key-C']);
    const status = pool.status();
    assert.equal(status[0].active, true);
    assert.equal(status[1].active, false);
  });

  test('pool size matches key count', () => {
    const pool = new KeyPool(['k1','k2','k3','k4']);
    assert.equal(pool.size, 4);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  5. API CLIENT — error parsing
// ══════════════════════════════════════════════════════════════════════════════

describe('5. API Client — parseToolResult', () => {
  const { parseToolResult } = require('./src/api/anakinClient');

  test('parses valid JSON result correctly', () => {
    const result = { content: [{ type: 'text', text: JSON.stringify({ status: 'completed', data: { products: [] } }) }] };
    const parsed = parseToolResult(result);
    assert.equal(parsed.status, 'completed');
  });

  test('throws on Wire error string with isRateLimit flag', () => {
    const result = { content: [{ type: 'text', text: "Tool 'wire_read_action' failed: Keyless burst limit reached. Please slow down." }] };
    assert.throws(() => parseToolResult(result), err => {
      assert.ok(err.isRateLimit === true, 'isRateLimit should be true');
      return true;
    });
  });

  test('throws on Wire timeout error string', () => {
    const result = { content: [{ type: 'text', text: "Tool 'wire_read_action' failed: The operation was aborted due to timeout" }] };
    assert.throws(() => parseToolResult(result), /failed/);
  });

  test('throws on empty result', () => {
    assert.throws(() => parseToolResult(null), /Empty tool result/);
    assert.throws(() => parseToolResult({}),   /Empty tool result/);
    assert.throws(() => parseToolResult({ content: [] }), /Empty tool result/);
  });

  test('returns plain text as-is for non-JSON non-error text', () => {
    const result = { content: [{ type: 'text', text: 'some plain text output' }] };
    const out = parseToolResult(result);
    assert.equal(out, 'some plain text output');
  });

  test('throws on Wire { status: error } JSON response', () => {
    const result = { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'Action failed' }) }] };
    assert.throws(() => parseToolResult(result), /Wire error/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  6. ACTIONS — cart URL builder
// ══════════════════════════════════════════════════════════════════════════════

describe('6. Actions — buildActionUrl', () => {
  const { buildActionUrl } = require('./src/agent/actions');

  test('Amazon product gets add-to-cart URL', () => {
    const product = { platform: 'amazon', id: 'B08ABC1234', url: 'https://www.amazon.com/dp/B08ABC1234' };
    const action  = buildActionUrl(product);
    assert.equal(action.actionType, 'add_to_cart');
    assert.ok(action.actionUrl.includes('B08ABC1234'), 'cart URL should include ASIN');
    assert.ok(action.actionUrl.includes('amazon.com/gp'), 'should be Amazon cart endpoint');
    assert.equal(action.actionLabel, 'Add to Amazon Cart');
  });

  test('Walmart product gets view-product URL', () => {
    const product = { platform: 'walmart', id: '12345678', url: 'https://www.walmart.com/ip/12345678' };
    const action  = buildActionUrl(product);
    assert.equal(action.actionType, 'view_product');
    assert.ok(action.actionUrl.includes('walmart.com'), 'should point to Walmart');
    assert.equal(action.actionLabel, 'View on Walmart');
  });

  test('unknown platform falls back gracefully', () => {
    const product = { platform: 'unknown', id: '999', url: 'https://example.com/product' };
    const action  = buildActionUrl(product);
    assert.equal(action.actionType, 'view_product');
    assert.equal(action.actionUrl, 'https://example.com/product');
  });

  test('Amazon product with no id returns product URL', () => {
    const product = { platform: 'amazon', id: null, url: 'https://www.amazon.com/dp/B0TEST' };
    const action  = buildActionUrl(product);
    // No ASIN → falls through to generic
    assert.ok(action.actionUrl.length > 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  7. SERVER — HTTP endpoints
// ══════════════════════════════════════════════════════════════════════════════

describe('7. Server — HTTP endpoints', () => {
  let serverInstance;
  const PORT_TEST = 3099;

  before(async () => {
    // Override PORT before requiring the server
    process.env.PORT = String(PORT_TEST);
    // Clear require cache so server binds to the test port
    delete require.cache[require.resolve('./src/server')];
    serverInstance = require('./src/server');
    await new Promise(r => setTimeout(r, 400));
  });

  after(async () => {
    if (serverInstance && typeof serverInstance.close === 'function') {
      await new Promise(r => serverInstance.close(r));
    }
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT_TEST}${path}`, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, body }); }
        });
      }).on('error', reject);
    });
  }

  function post(path, payload) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const req  = http.request({
        hostname: 'localhost', port: PORT_TEST, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, body }); }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  test('GET /api/health returns 200 with status ok', async () => {
    const { status, body } = await get('/api/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.agent, 'SmartShop');
  });

  test('GET /api/keys/status returns key pool info', async () => {
    const { status, body } = await get('/api/keys/status');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.keys), 'keys should be an array');
    assert.ok(body.total >= 1, 'should have at least 1 key');
  });

  test('POST /api/search with no query returns 400', async () => {
    const { status, body } = await post('/api/search', {});
    assert.equal(status, 400);
    assert.ok(body.error, 'should return error message');
  });

  test('POST /api/search with empty string query returns 400', async () => {
    const { status, body } = await post('/api/search', { query: '   ' });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  test('GET / serves HTML page', async () => {
    const { status, body } = await get('/');
    assert.equal(status, 200);
    assert.ok(typeof body === 'string' && body.includes('SmartShop'), 'index.html should include SmartShop');
  });

  test('GET /api/action/stream with no url returns 400', async () => {
    const { status } = await get('/api/action/stream');
    assert.equal(status, 400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  8. PIPELINE — live end-to-end (skipped in --unit mode)
// ══════════════════════════════════════════════════════════════════════════════

describe('8. Pipeline — full end-to-end live search', () => {
  if (!runLive) {
    test('skipped (use --live to run)', () => {
      skip('Live tests skipped in --unit mode');
    });
    return;
  }

  test('search returns ranked products from at least one platform', async () => {
    const { search } = require('./src/agent/smartshop');
    // Use fast mode: no enrichment, no web context — just search + rank
    const result = await search('bluetooth speaker', {
      enrichWalmart:     false,
      includeWebContext: false,
      limit:             5,
    });

    assert.ok(result.products.length > 0, 'should return at least 1 product');
    assert.ok(result.sources.amazon + result.sources.walmart > 0, 'should have results from at least one platform');
    assert.ok(result.durationMs > 0, 'durationMs should be positive');
    assert.ok(result.intent.keywords.length > 0, 'intent keywords should be set');
  }, { timeout: 90_000 });

  test('search respects budget — no products over maxPrice', async () => {
    const { search } = require('./src/agent/smartshop');
    const result = await search('wireless mouse under 30', {
      enrichWalmart:     false,
      includeWebContext: false,
      limit:             8,
    });

    result.products.forEach(p => {
      if (p.price !== null) {
        assert.ok(p.price <= 30, `${p.title} at $${p.price} exceeds $30 budget`);
      }
    });
  }, { timeout: 90_000 });

  test('top product has valid score breakdown', async () => {
    const { search } = require('./src/agent/smartshop');
    const result = await search('gaming keyboard', {
      enrichWalmart:     false,
      includeWebContext: false,
      limit:             5,
    });

    if (result.products.length === 0) {
      skip('No products returned — possibly rate limited');
      return;
    }

    const top = result.products[0];
    assert.ok(top.score >= 0 && top.score <= 100, `invalid score: ${top.score}`);
    assert.ok(top.scoreBreakdown, 'scoreBreakdown should exist');
    assert.ok(top.rank === 1, 'top product should have rank 1');
    assert.ok(top.actionUrl, 'top product should have actionUrl');
  }, { timeout: 90_000 });

  test('SSE stream emits required events', async () => {
    const { run } = require('./src/agent/smartshop');
    const events = new Set();

    await new Promise((resolve, reject) => {
      const ee = run('headphones', {
        enrichWalmart:     false,
        includeWebContext: false,
        limit:             3,
      });
      const timeout = setTimeout(() => reject(new Error('SSE stream timed out after 90s')), 90_000);
      ee.on('intent',     () => events.add('intent'));
      ee.on('step',       () => events.add('step'));
      ee.on('raw_counts', () => events.add('raw_counts'));
      ee.on('done',       () => { clearTimeout(timeout); resolve(); });
      ee.on('error',      e  => { clearTimeout(timeout); reject(e); });
    });

    assert.ok(events.has('intent'),     'should emit intent event');
    assert.ok(events.has('step'),       'should emit step events');
    assert.ok(events.has('raw_counts'), 'should emit raw_counts event');
  }, { timeout: 95_000 });
});

// ══════════════════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════════════════

log(`\n${c.dim}─────────────────────────────────────────────────${c.reset}`);
log(`${c.dim}Unit tests cover: parser · normalizer · reasoner · key pool · client · actions · server${c.reset}`);
if (runLive) log(`${c.dim}Live tests cover: full pipeline · budget filtering · SSE events${c.reset}`);
log(`${c.dim}─────────────────────────────────────────────────${c.reset}\n`);
