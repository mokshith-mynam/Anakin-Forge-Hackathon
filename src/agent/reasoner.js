/**
 * Reasoner
 * Scores, ranks, and explains a unified product list.
 * Pure logic — deterministic scoring so results are reproducible and auditable.
 *
 * Scoring dimensions (out of 100):
 *   - Value score    (30 pts): price relative to budget ceiling & peers
 *   - Rating score   (25 pts): star rating weighted by review volume
 *   - Review score   (20 pts): review count (log-scaled so outliers don't dominate)
 *   - Feature score  (15 pts): feature richness + keyword relevance
 *   - Stock score    (10 pts): availability + Prime/Walmart+ shipping
 */

'use strict';

const MAX_SCORE = 100;

/**
 * Clamp a value between min and max.
 */
function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

/**
 * Score products against the user's intent.
 *
 * @param {object[]} products   - normalized product list
 * @param {object}   intent     - parsed query (keywords, maxPrice, minPrice, sortPreference)
 * @returns {object[]}          - products with added `score`, `scoreBreakdown`, `recommendation` fields, sorted desc
 */
function scoreAndRank(products, intent) {
  if (!products.length) return [];

  const { maxPrice, minPrice, sortPreference, keywords } = intent;
  const keywordTokens = keywords
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 2);

  // Filter out products that violate hard price constraints
  const eligible = products.filter(p => {
    if (p.price === null) return true; // keep unknown-price products for now
    if (maxPrice && p.price > maxPrice) return false;
    if (minPrice && p.price < minPrice) return false;
    return true;
  });

  // Use eligible set for peer comparison; fall back to full set if all filtered
  const pool = eligible.length > 0 ? eligible : products;

  // Pre-compute peer stats for relative scoring
  const prices = pool.map(p => p.price).filter(v => v !== null);
  const minPeer  = prices.length ? Math.min(...prices) : 0;
  const maxPeer  = prices.length ? Math.max(...prices) : 1;
  const peerRange = maxPeer - minPeer || 1;

  const reviews = pool.map(p => p.reviewCount || 0);
  const maxReviews = Math.max(...reviews, 1);

  function scoreValue(product) {
    if (product.price === null) return 15; // neutral score for missing price
    // A lower price relative to peers = better value score, unless user wants premium
    const relativePos = (product.price - minPeer) / peerRange; // 0=cheapest, 1=most expensive
    if (sortPreference === 'price_asc') {
      return 30 * (1 - relativePos);
    } else if (sortPreference === 'price_desc') {
      return 30 * relativePos;
    } else {
      // Balanced value: reward items near the lower-middle of the price range
      const valueMid = 0.35;
      const dist = Math.abs(relativePos - valueMid);
      return 30 * (1 - clamp(dist / 0.65, 0, 1));
    }
  }

  function scoreRating(product) {
    if (!product.rating) return 10; // neutral
    // Scale 0–5 stars to 0–25; penalise very low review counts (< 10)
    const stars = clamp(product.rating, 0, 5);
    const credibility = product.reviewCount
      ? clamp(Math.log10(product.reviewCount + 1) / Math.log10(1001), 0, 1)
      : 0.3;
    return 25 * (stars / 5) * (0.5 + 0.5 * credibility);
  }

  function scoreReviewCount(product) {
    if (!product.reviewCount) return 5;
    // Log-scale: 1000 reviews ≈ full score
    const logScore = Math.log10(product.reviewCount + 1) / Math.log10(maxReviews + 1);
    return 20 * logScore;
  }

  function scoreFeatures(product) {
    let pts = 0;
    // Feature richness (up to 10 pts)
    pts += Math.min(product.features.length * 2, 10);
    // Keyword relevance (up to 5 pts)
    const text = `${product.title} ${product.features.join(' ')}`.toLowerCase();
    const matches = keywordTokens.filter(t => text.includes(t)).length;
    pts += Math.min(matches * (5 / Math.max(keywordTokens.length, 1)), 5);
    return pts;
  }

  function scoreStock(product) {
    let pts = 0;
    if (product.inStock) pts += 6;
    if (product.prime)   pts += 4;
    return pts;
  }

  // Score each product in the pool
  const scored = pool.map(product => {
    const valueScore   = scoreValue(product);
    const ratingScore  = scoreRating(product);
    const reviewScore  = scoreReviewCount(product);
    const featureScore = scoreFeatures(product);
    const stockScore   = scoreStock(product);

    const total = clamp(
      valueScore + ratingScore + reviewScore + featureScore + stockScore,
      0,
      MAX_SCORE,
    );

    const discount = product.originalPrice && product.price
      ? Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100)
      : null;

    return {
      ...product,
      score: Math.round(total),
      scoreBreakdown: {
        value:   Math.round(valueScore),
        rating:  Math.round(ratingScore),
        reviews: Math.round(reviewScore),
        features: Math.round(featureScore),
        stock:   Math.round(stockScore),
      },
      discount,
    };
  });

  // Sort by total score descending
  scored.sort((a, b) => b.score - a.score);

  // Add human-readable recommendation labels to top results
  const labels = ['🥇 Best Pick', '🥈 Runner-Up', '🥉 Third Choice'];
  scored.forEach((p, i) => {
    p.rank = i + 1;
    p.recommendation = i < labels.length ? labels[i] : `#${i + 1}`;
  });

  return scored;
}

/**
 * Generate a plain-English summary for the top-ranked product.
 * @param {object}   topProduct  - scored + ranked product
 * @param {object}   intent      - parsed query
 * @returns {string}
 */
function generateSummary(topProduct, intent) {
  if (!topProduct) return 'No matching products found.';

  const lines = [];
  const p = topProduct;

  lines.push(`**${p.recommendation}: ${p.title}**`);

  if (p.price !== null) {
    const priceStr = `$${p.price.toFixed(2)}`;
    const discountStr = p.discount && p.discount > 0
      ? ` (${p.discount}% off original $${p.originalPrice.toFixed(2)})`
      : '';
    lines.push(`Price: ${priceStr}${discountStr} on ${p.platform === 'amazon' ? 'Amazon' : 'Walmart'}`);
  }

  if (p.rating) {
    const stars = '★'.repeat(Math.round(p.rating)) + '☆'.repeat(5 - Math.round(p.rating));
    const reviewStr = p.reviewCount ? ` from ${p.reviewCount.toLocaleString()} reviews` : '';
    lines.push(`Rating: ${stars} ${p.rating.toFixed(1)}${reviewStr}`);
  }

  if (p.prime) {
    lines.push(`✓ ${p.platform === 'amazon' ? 'Amazon Prime' : 'Walmart+'} eligible`);
  }

  if (p.features.length > 0) {
    lines.push('\nKey features:');
    p.features.slice(0, 3).forEach(f => lines.push(`  • ${f}`));
  }

  if (intent.maxPrice && p.price !== null) {
    const saving = intent.maxPrice - p.price;
    if (saving > 0) {
      lines.push(`\n💰 $${saving.toFixed(2)} under your $${intent.maxPrice} budget`);
    }
  }

  lines.push(`\n🔗 ${p.url}`);

  return lines.join('\n');
}

/**
 * Build a comparison table row for each product.
 * @param {object[]} rankedProducts
 * @returns {object[]}  - lightweight objects suitable for table rendering
 */
function buildComparisonTable(rankedProducts) {
  return rankedProducts.slice(0, 10).map(p => ({
    rank:        p.rank,
    label:       p.recommendation,
    platform:    p.platform === 'amazon' ? '🛒 Amazon' : '🏪 Walmart',
    title:       p.title.length > 60 ? p.title.slice(0, 57) + '…' : p.title,
    price:       p.price !== null ? `$${p.price.toFixed(2)}` : 'N/A',
    originalPrice: p.originalPrice ? `$${p.originalPrice.toFixed(2)}` : null,
    discount:    p.discount ? `-${p.discount}%` : '—',
    rating:      p.rating ? `${p.rating.toFixed(1)} ★` : '—',
    reviews:     p.reviewCount ? p.reviewCount.toLocaleString() : '—',
    score:       p.score,
    inStock:     p.inStock ? '✓' : '✗',
    prime:       p.prime ? '✓' : '—',
    url:         p.url         || '',
    actionUrl:   p.actionUrl   || p.url || '',
    actionLabel: p.actionLabel || 'View Product',
    actionType:  p.actionType  || 'view_product',
    imageUrl:    p.imageUrl    || '',
    brand:       p.brand       || '',
    features:    p.features,
    breakdown:   p.scoreBreakdown,
  }));
}

module.exports = { scoreAndRank, generateSummary, buildComparisonTable };
