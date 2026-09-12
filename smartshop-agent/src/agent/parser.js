/**
 * Query Parser
 * Extracts intent, budget, and keywords from a plain-English shopping query.
 * Pure logic — no LLM needed, keeps latency low for this step.
 */

'use strict';

/**
 * Parse a shopping query into structured intent.
 *
 * Examples:
 *   "best laptop under $800 for coding"
 *   → { keywords: "laptop for coding", maxPrice: 800, minPrice: null, category: "electronics" }
 *
 *   "wireless headphones between $50 and $150"
 *   → { keywords: "wireless headphones", maxPrice: 150, minPrice: 50, category: "electronics" }
 *
 * @param {string} query
 * @returns {{
 *   original: string,
 *   keywords: string,
 *   maxPrice: number|null,
 *   minPrice: number|null,
 *   category: string,
 *   sortPreference: string
 * }}
 */
function parseQuery(query) {
  const q = query.trim();

  // ── Price extraction ──────────────────────────────────────
  let maxPrice = null;
  let minPrice = null;

  // "between $X and $Y" / "from $X to $Y"
  const rangeMatch = q.match(/(?:between|from)\s*\$?([\d,]+)\s*(?:and|to)\s*\$?([\d,]+)/i);
  if (rangeMatch) {
    minPrice = parseFloat(rangeMatch[1].replace(',', ''));
    maxPrice = parseFloat(rangeMatch[2].replace(',', ''));
  }

  // "under $X" / "below $X" / "less than $X" / "cheaper than $X"
  const maxMatch = q.match(/(?:under|below|less\s+than|cheaper\s+than|up\s+to|max(?:imum)?)\s*\$?([\d,]+)/i);
  if (maxMatch && !maxPrice) {
    maxPrice = parseFloat(maxMatch[1].replace(',', ''));
  }

  // "over $X" / "above $X" / "more than $X"
  const minMatch = q.match(/(?:over|above|more\s+than|at\s+least)\s*\$?([\d,]+)/i);
  if (minMatch && !minPrice) {
    minPrice = parseFloat(minMatch[1].replace(',', ''));
  }

  // standalone "$X" treated as max if no other price found
  if (!maxPrice && !minPrice) {
    const singlePrice = q.match(/\$?([\d,]+(?:\.\d+)?)\s*(?:dollars?|usd)?/i);
    if (singlePrice) {
      const val = parseFloat(singlePrice[1].replace(',', ''));
      if (val > 0) maxPrice = val;
    }
  }

  // ── Sort preference ───────────────────────────────────────
  let sortPreference = 'best_match';
  if (/cheapest|lowest\s+price|most\s+affordable|budget/i.test(q)) sortPreference = 'price_asc';
  if (/expensive|premium|high.?end|luxury/i.test(q)) sortPreference = 'price_desc';
  if (/top.?rated|best.?rated|highest.?rated|most\s+reviewed/i.test(q)) sortPreference = 'rating';
  if (/newest|latest|new\s+release/i.test(q)) sortPreference = 'newest';

  // ── Category detection ────────────────────────────────────
  const categoryMap = [
    [/\b(laptop|notebook|macbook|chromebook|ultrabook)\b/i, 'electronics'],
    [/\b(phone|iphone|android|smartphone|mobile)\b/i, 'electronics'],
    [/\b(tablet|ipad)\b/i, 'electronics'],
    [/\b(headphone|headphones|earbud|earbuds|airpod|airpods|speaker|audio)\b/i, 'electronics'],
    [/\b(tv|television|monitor|display|screen)\b/i, 'electronics'],
    [/\b(camera|lens|dslr|mirrorless)\b/i, 'electronics'],
    [/\b(gaming|console|playstation|xbox|nintendo|gpu|graphics card)\b/i, 'electronics'],
    [/\b(keyboard|mouse|webcam|microphone|desk)\b/i, 'computers'],
    [/\b(shoe|sneaker|boot|sandal)\b/i, 'clothing'],
    [/\b(shirt|pant|jacket|dress|clothing|apparel|fashion)\b/i, 'clothing'],
    [/\b(book|novel|textbook)\b/i, 'books'],
    [/\b(toy|lego|puzzle|game\s+for\s+kids)\b/i, 'toys'],
    [/\b(kitchen|blender|coffee|cookware|appliance)\b/i, 'home'],
    [/\b(vacuum|mattress|sofa|furniture|bedding)\b/i, 'home'],
    [/\b(fitness|dumbbell|treadmill|yoga|gym)\b/i, 'sports'],
    [/\b(vitamin|supplement|protein|skincare|beauty)\b/i, 'health'],
    [/\b(car|auto|motorcycle|tire|vehicle)\b/i, 'automotive'],
    [/\b(tool|drill|saw|wrench|power\s+tool)\b/i, 'tools'],
  ];

  let category = 'general';
  for (const [pattern, cat] of categoryMap) {
    if (pattern.test(q)) { category = cat; break; }
  }

  // ── Keyword cleaning ──────────────────────────────────────
  // Remove price phrases, filler words, and budget descriptors to get clean search terms
  let keywords = q
    .replace(/(?:between|from)\s*\$?[\d,]+\s*(?:and|to)\s*\$?[\d,]+/gi, '')
    .replace(/(?:under|below|less\s+than|cheaper\s+than|up\s+to|maximum?)\s*\$?[\d,]+/gi, '')
    .replace(/(?:over|above|more\s+than|at\s+least)\s*\$?[\d,]+/gi, '')
    .replace(/\$[\d,]+(?:\.\d+)?/gi, '')
    .replace(/\b(find|show|get|give|suggest|recommend|look\s+for|search\s+for|i\s+want|i\s+need|i'm\s+looking\s+for|what(?:'s|\s+is)\s+(?:the\s+)?best)\b/gi, '')
    .replace(/\b(good|great|decent|solid|quality|nice|best|top|cheap|budget|affordable|premium|best\s+value)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!keywords) keywords = q; // fallback to original if over-stripped

  return {
    original: q,
    keywords,
    maxPrice,
    minPrice,
    category,
    sortPreference,
  };
}

module.exports = { parseQuery };
