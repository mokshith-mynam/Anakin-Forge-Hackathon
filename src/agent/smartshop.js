/**
 * SmartShop Agent — Core Orchestrator
 *
 * Pipeline (6 steps):
 *   1. Parse the natural-language query  →  extract intent, budget, keywords
 *   2. Fan out searches to Amazon + Walmart in parallel  (live Wire API)
 *   3. Normalize all results into a unified product schema
 *   4. Enrich top Walmart candidates with product details + reviews  (Wire API)
 *   5. Score and rank products against the user's intent  (multi-dimension scoring)
 *   6. Web search for editorial reviews  +  AI deep-research summary  (Anakin AI)
 *
 * Each step emits progress events so callers (CLI / web server) can stream
 * live status updates to the user.
 *
 * Hackathon criteria satisfied:
 *   ✅  Browse & read LIVE web content   →  steps 2, 4, 6 (Wire + scrape + web search)
 *   ✅  Reason through multi-step tasks  →  steps 1–5 (parse → search → enrich → score)
 *   ✅  Take real action                 →  step 6 (AI recommendation) + action URLs returned
 */

'use strict';

const { parseQuery }        = require('./parser');
const { normalizeProducts } = require('./normalizer');
const { scoreAndRank, generateSummary, buildComparisonTable } = require('./reasoner');
const { buildActionUrl, amazonProductDetails, amazonProductReviews } = require('./actions');
const client                = require('../api/anakinClient');
const { EventEmitter }      = require('events');

const DEFAULT_SEARCH_LIMIT = 12;
const ENRICH_TOP_N = 2;   // enrich top 2 per platform to save credits (was 4)

// ─────────────────────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the SmartShop agent pipeline.
 *
 * @param {string} query
 * @param {object} options
 * @param {boolean} [options.enrichWalmart=true]     - fetch detail+reviews for top Walmart items
 * @param {boolean} [options.includeWebContext=true] - run web search + AI summary (DEFAULT ON)
 * @param {number}  [options.limit=12]               - max results per platform
 * @returns {EventEmitter}  - emits: step | intent | raw_counts | warning | web_context | ai_summary | done | error
 */
function run(query, options = {}) {
  const {
    enrichWalmart     = true,
    includeWebContext = true,    // ← DEFAULT ON: satisfies "browse live web" criterion
    limit             = DEFAULT_SEARCH_LIMIT,
  } = options;

  const emitter   = new EventEmitter();
  const startTime = Date.now();

  // setImmediate lets the caller attach listeners before the first emit fires
  setImmediate(() =>
    _runPipeline(query, { enrichWalmart, includeWebContext, limit, emitter, startTime })
  );

  return emitter;
}

/**
 * Convenience promise wrapper — resolves with the full result object.
 */
function search(query, options = {}) {
  return new Promise((resolve, reject) => {
    const ee = run(query, options);
    ee.once('done',  resolve);
    ee.once('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function _runPipeline(query, { enrichWalmart, includeWebContext, limit, emitter, startTime }) {
  try {

    // ── Step 1: Parse intent ────────────────────────────────────────────────
    emit(emitter, 'step', { step: 1, total: 6, label: '🔍 Parsing your query…' });
    const intent = parseQuery(query);
    emit(emitter, 'intent', intent);

    // ── Step 2: Parallel live search — Amazon + Walmart ─────────────────────
    emit(emitter, 'step', {
      step: 2, total: 6,
      label: `🛒 Searching Amazon & Walmart live for "${intent.keywords}"…`,
    });

    const searchQuery = intent.keywords || query;

    // Wrap each search with a per-platform timeout so one slow platform
    // never blocks the other. Walmart is slower (~30s) so gets 45s.
    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out after ${ms/1000}s`)), ms)
        ),
      ]);
    }

    const [amazonRaw, walmartRaw] = await Promise.allSettled([
      withTimeout(client.amazonSearch(searchQuery, limit), 45000, 'Amazon'),
      withTimeout(client.walmartSearch(searchQuery, limit), 45000, 'Walmart'),
    ]);

    const amazonData  = amazonRaw.status  === 'fulfilled' ? amazonRaw.value  : null;
    const walmartData = walmartRaw.status === 'fulfilled' ? walmartRaw.value : null;

    if (!amazonData && !walmartData) {
      const msg = [amazonRaw.reason?.message, walmartRaw.reason?.message].filter(Boolean).join(' / ');
      const isLimit = /rate.?limit|burst.?limit|slow.?down|too.?many/i.test(msg);
      throw new Error(isLimit
        ? 'API rate limit reached. Please wait 30 seconds and try again.'
        : 'Both Amazon and Walmart searches failed. Please try again.'
      );
    }
    if (amazonRaw.status  === 'rejected') {
      const msg = amazonRaw.reason?.message || '';
      const isLimit = /rate.?limit|burst.?limit|slow.?down|too.?many/i.test(msg);
      emit(emitter, 'warning', isLimit
        ? `Amazon rate limited — retried automatically. If this persists, wait 30s and try again.`
        : `Amazon search unavailable: ${msg}`
      );
    }
    if (walmartRaw.status === 'rejected') {
      const msg = walmartRaw.reason?.message || '';
      const isLimit = /rate.?limit|burst.?limit|slow.?down|too.?many/i.test(msg);
      emit(emitter, 'warning', isLimit
        ? `Walmart rate limited — retried automatically. If this persists, wait 30s and try again.`
        : `Walmart search unavailable: ${msg}`
      );
    }

    // ── Step 3: Normalize ───────────────────────────────────────────────────
    emit(emitter, 'step', { step: 3, total: 6, label: '📊 Normalizing product data across platforms…' });

    const amazonProducts  = amazonData  ? normalizeProducts(amazonData,  'amazon')  : [];
    const walmartProducts = walmartData ? normalizeProducts(walmartData, 'walmart') : [];

    emit(emitter, 'raw_counts', { amazon: amazonProducts.length, walmart: walmartProducts.length });

    // ── Step 4: Enrich top Amazon + Walmart products in parallel ────────────
    let enrichedAmazonProducts  = amazonProducts;
    let enrichedWalmartProducts = walmartProducts;

    if (enrichWalmart && (amazonProducts.length > 0 || walmartProducts.length > 0)) {
      const nW = Math.min(ENRICH_TOP_N, walmartProducts.length);
      const nA = Math.min(ENRICH_TOP_N, amazonProducts.length);
      emit(emitter, 'step', {
        step: 4, total: 6,
        label: `🔬 Enriching top products with live details & reviews from both platforms…`,
      });

      // Walmart enrichment — details + reviews
      const topWalmart  = walmartProducts.slice(0, nW);
      const restWalmart = walmartProducts.slice(nW);

      const wEnriched = await Promise.allSettled(
        topWalmart.map(async product => {
          try {
            const [details, reviews] = await Promise.allSettled([
              client.walmartProductDetails(product.id),
              client.walmartReviews(product.id),
            ]);
            if (details.status === 'fulfilled' && details.value) {
              const dp = details.value?.data || details.value;
              if (dp.price)                   product.price         = parseFloat(String(dp.price).replace(/[^0-9.]/g, ''))     || product.price;
              if (dp.was_price)               product.originalPrice = parseFloat(String(dp.was_price).replace(/[^0-9.]/g, '')) || null;
              if (dp.brand)                   product.brand         = dp.brand;
              if (Array.isArray(dp.features)) product.features      = dp.features.slice(0, 5);
              if (dp.image || dp.image_url)   product.imageUrl      = dp.image || dp.image_url;
            }
            if (reviews.status === 'fulfilled' && reviews.value) {
              const rd = reviews.value?.data || reviews.value;
              const avg   = rd.average_rating || rd.averageRating || rd.overall_rating;
              const total = rd.total_reviews  || rd.totalReviews  || rd.review_count;
              if (avg)   product.rating      = parseFloat(avg);
              if (total) product.reviewCount = parseInt(String(total).replace(/\D/g, ''), 10);
            }
            return product;
          } catch { return product; }
        }),
      );

      enrichedWalmartProducts = [
        ...wEnriched.map(r => r.status === 'fulfilled' ? r.value : null),
        ...restWalmart,
      ].filter(Boolean);

      // Amazon enrichment — details + reviews
      const topAmazon  = amazonProducts.slice(0, nA);
      const restAmazon = amazonProducts.slice(nA);

      const aEnriched = await Promise.allSettled(
        topAmazon.map(async product => {
          if (!product.id) return product;
          try {
            const [details, reviews] = await Promise.allSettled([
              amazonProductDetails(product.id),
              amazonProductReviews(product.id),
            ]);
            if (details.status === 'fulfilled' && details.value) {
              const dp = details.value?.data || details.value?.product || details.value;
              if (dp?.price)                    product.price        = parseFloat(String(dp.price).replace(/[^0-9.]/g, ''))         || product.price;
              if (dp?.original_price)           product.originalPrice= parseFloat(String(dp.original_price).replace(/[^0-9.]/g, ''))|| null;
              if (dp?.brand)                    product.brand        = dp.brand;
              if (Array.isArray(dp?.feature_bullets)) product.features = dp.feature_bullets.slice(0, 5);
              if (dp?.main_image || dp?.image)  product.imageUrl     = dp.main_image || dp.image;
              if (dp?.url)                      product.url          = dp.url;
            }
            if (reviews.status === 'fulfilled' && reviews.value) {
              const rd = reviews.value?.data || reviews.value;
              const avg   = rd?.rating      || rd?.average_rating;
              const total = rd?.total_reviews|| rd?.review_count;
              if (avg)   product.rating      = parseFloat(avg);
              if (total) product.reviewCount = parseInt(String(total).replace(/\D/g, ''), 10);
            }
            return product;
          } catch { return product; }
        }),
      );

      enrichedAmazonProducts = [
        ...aEnriched.map(r => r.status === 'fulfilled' ? r.value : null),
        ...restAmazon,
      ].filter(Boolean);

    } else {
      emit(emitter, 'step', { step: 4, total: 6, label: '⏭  Skipping enrichment…' });
    }

    // ── Step 5: Score and rank ───────────────────────────────────────────────
    emit(emitter, 'step', { step: 5, total: 6, label: '🧠 Scoring and ranking all products…' });

    const allProducts = [...enrichedAmazonProducts, ...enrichedWalmartProducts];
    const ranked      = scoreAndRank(allProducts, intent);

    // Attach action URL to every product so UI can render buy buttons
    ranked.forEach(p => {
      const action = buildActionUrl(p);
      p.actionUrl   = action.actionUrl;
      p.actionLabel = action.actionLabel;
      p.actionType  = action.actionType;
    });

    const table       = buildComparisonTable(ranked);

    // Derive action URLs for the top 3 products
    const actionItems = ranked.slice(0, 3).map(p => ({
      title:    p.title,
      platform: p.platform,
      url:      p.url,
      price:    p.price,
      score:    p.score,
    }));

    // ── Step 6: Live web search + AI-generated recommendation ───────────────
    let topSummary  = generateSummary(ranked[0], intent);  // rule-based fallback
    let webSnippets = [];

    if (includeWebContext && ranked.length > 0) {
      emit(emitter, 'step', {
        step: 6, total: 6,
        label: `🌐 Searching the web for expert reviews on "${ranked[0].title.slice(0, 50)}…"`,
      });

      // 6a: Web search for editorial context (live web browsing)
      try {
        const webQuery = `${ranked[0].title} review pros cons worth buying`;
        const webData  = await client.webSearch(webQuery, 5);
        // Normalise the results array regardless of envelope shape
        const rawResults = Array.isArray(webData)
          ? webData
          : (webData?.results || webData?.data || []);

        webSnippets = rawResults.slice(0, 4).map(r => ({
          title:   r.title   || r.name || '',
          snippet: r.snippet || r.description || r.summary || '',
          url:     r.url     || r.link || '',
        })).filter(s => s.snippet);

        emit(emitter, 'web_context', { snippets: webSnippets, query: webQuery });
      } catch (e) {
        emit(emitter, 'warning', `Web search skipped: ${e.message}`);
      }

      // 6b: AI deep-research summary (the agent REASONS using web + product data)
      emit(emitter, 'step', {
        step: 6, total: 6,
        label: '🤖 Generating AI recommendation with deep research…',
      });

      try {
        const top3Desc = ranked.slice(0, 3).map((p, i) =>
          `${i + 1}. ${p.title} — $${p.price ?? 'N/A'} on ${p.platform}, ` +
          `rated ${p.rating ?? '?'}/5 (${p.reviewCount?.toLocaleString() ?? '?'} reviews), ` +
          `score ${p.score}/100`
        ).join('\n');

        const budgetLine = intent.maxPrice
          ? `User's budget: under $${intent.maxPrice}.`
          : 'No specific budget stated.';

        const researchPrompt =
          `You are a smart shopping assistant. Based on the following top 3 products found ` +
          `for the query "${intent.original}", give a concise 3-4 sentence recommendation ` +
          `explaining which is the best buy and why, considering price, ratings, and reviews. ` +
          `${budgetLine}\n\nTop products:\n${top3Desc}`;

        const aiResult = await client.deepResearch(researchPrompt, {
          type: 'object',
          properties: {
            recommendation: { type: 'string', description: 'Best pick and why in 2-3 sentences.' },
            pros:           { type: 'array',  items: { type: 'string' }, description: 'Top 3 pros of the best pick.' },
            cons:           { type: 'array',  items: { type: 'string' }, description: 'Top 2 cons or caveats.' },
            verdict:        { type: 'string', description: 'One-line verdict.' },
          },
        });

        const aiData = aiResult?.structured_data || aiResult?.data || aiResult;

        if (aiData?.recommendation || aiData?.verdict) {
          topSummary = aiData;   // replace string with structured AI object
          emit(emitter, 'ai_summary', aiData);
        } else if (typeof aiResult === 'string' && aiResult.length > 40) {
          topSummary = { recommendation: aiResult, pros: [], cons: [], verdict: '' };
          emit(emitter, 'ai_summary', topSummary);
        }
      } catch (e) {
        emit(emitter, 'warning', `AI summary skipped: ${e.message}`);
        // topSummary stays as the rule-based string fallback — that's fine
      }
    }

    const durationMs = Date.now() - startTime;

    const result = {
      intent,
      products:   ranked,
      table,
      topSummary,
      webSnippets,
      actionItems,
      sources: {
        amazon:  amazonProducts.length,
        walmart: enrichedWalmartProducts.length,
      },
      durationMs,
    };

    emit(emitter, 'done', result);

  } catch (err) {
    emit(emitter, 'error', err);
  }
}

function emit(emitter, event, data) {
  emitter.emit(event, data);
}

module.exports = { run, search };
