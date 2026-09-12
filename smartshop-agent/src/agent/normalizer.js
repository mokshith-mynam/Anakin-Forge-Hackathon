/**
 * Product Normalizer
 * Maps raw API responses from Amazon and Walmart into a unified product schema
 * so the reasoner can compare apples to apples.
 */

'use strict';

/**
 * Unified product shape:
 * {
 *   id:          string   — platform-specific ID (ASIN / Walmart item_id)
 *   platform:    'amazon' | 'walmart'
 *   title:       string
 *   price:       number | null   — parsed USD price
 *   originalPrice: number | null — before discount
 *   currency:    string
 *   rating:      number | null   — 0–5
 *   reviewCount: number | null
 *   imageUrl:    string | null
 *   url:         string | null
 *   brand:       string | null
 *   inStock:     boolean
 *   prime:       boolean         — Amazon Prime / Walmart+ eligible
 *   features:    string[]        — bullet-point highlights
 *   raw:         object          — original API payload for reference
 * }
 */

function parsePrice(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return val;
  const str = String(val).replace(/[^0-9.]/g, '');
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

function normalizeAmazonProduct(item) {
  // Amazon Wire (am_search_products) returns varied shapes — handle both
  const price =
    parsePrice(item.price) ||
    parsePrice(item.current_price) ||
    parsePrice(item.deal_price) ||
    parsePrice(item.list_price) ||
    null;

  const originalPrice =
    parsePrice(item.original_price) ||
    parsePrice(item.list_price) ||
    null;

  const rating =
    typeof item.rating === 'number' ? item.rating :
    parsePrice(item.stars) || parsePrice(item.rating) || null;

  const reviewCount =
    typeof item.review_count === 'number' ? item.review_count :
    typeof item.reviews_count === 'number' ? item.reviews_count :
    parseInt(String(item.reviews_count || item.review_count || '0').replace(/\D/g, ''), 10) || null;

  const features = [];
  if (Array.isArray(item.feature_bullets)) features.push(...item.feature_bullets);
  if (Array.isArray(item.features)) features.push(...item.features);
  if (item.description && features.length === 0) features.push(item.description);

  return {
    id: item.asin || item.id || String(Math.random()),
    platform: 'amazon',
    title: item.title || item.name || 'Unknown product',
    price,
    originalPrice,
    currency: 'USD',
    rating,
    reviewCount,
    imageUrl: item.image || item.thumbnail || item.main_image || null,
    url: item.url || item.link ||
         (item.asin ? `https://www.amazon.com/dp/${item.asin}` : null),
    brand: item.brand || null,
    inStock: item.in_stock !== false && item.availability !== 'Out of Stock',
    prime: item.prime === true || item.is_prime === true,
    features: features.slice(0, 5),
    raw: item,
  };
}

function normalizeWalmartProduct(item) {
  const price =
    parsePrice(item.price) ||
    parsePrice(item.sale_price) ||
    parsePrice(item.current_price) ||
    null;

  const originalPrice =
    parsePrice(item.was_price) ||
    parsePrice(item.list_price) ||
    parsePrice(item.original_price) ||
    null;

  const rating =
    parsePrice(item.rating) ||
    parsePrice(item.customer_rating) ||
    parsePrice(item.average_rating) ||
    null;

  const reviewCount =
    parseInt(
      String(item.num_reviews || item.review_count || item.reviews_count || '0')
        .replace(/\D/g, ''),
      10
    ) || null;

  const features = [];
  if (Array.isArray(item.short_description_html)) {
    features.push(...item.short_description_html.map(s => s.replace(/<[^>]+>/g, '')));
  }
  if (Array.isArray(item.features)) features.push(...item.features);
  if (item.short_description && features.length === 0) {
    features.push(item.short_description.replace(/<[^>]+>/g, ''));
  }

  const itemId = item.item_id || item.id || item.usItemId;

  // Determine in-stock status from availability string or boolean flags
  const availability = String(item.availability || '').toLowerCase();
  const inStock = item.available_online !== false &&
                  item.in_stock !== false &&
                  (availability === '' || availability.includes('in stock') || availability.includes('available'));

  return {
    id: String(itemId || Math.random()),
    platform: 'walmart',
    title: item.title || item.name || 'Unknown product',
    price,
    originalPrice,
    currency: 'USD',
    rating,
    reviewCount,
    imageUrl: item.image || item.image_url || item.thumbnail_image || null,
    url: item.product_url ||
         item.url ||
         (itemId ? `https://www.walmart.com/ip/${itemId}` : null),
    brand: item.brand || item.brand_name || item.seller_name || null,
    inStock,
    prime: item.wplus_eligible === true,
    features: features.slice(0, 5),
    raw: item,
  };
}

/**
 * Normalize a raw list from either platform.
 * @param {object[]|object} data  - raw API response (array or object with items array)
 * @param {'amazon'|'walmart'}  platform
 * @returns {NormalizedProduct[]}
 */
function normalizeProducts(data, platform) {
  // Unwrap common envelope shapes
  let items = data;
  if (typeof data === 'string') {
    try { items = JSON.parse(data); } catch { return []; }
  }
  if (!Array.isArray(items)) {
    // Handle { status, data: { products: [...] } } (Walmart Wire shape)
    items =
      (items.data && items.data.products) ||
      (items.data && Array.isArray(items.data) ? items.data : null) ||
      items.products ||
      items.results ||
      items.items ||
      items.search_results ||
      (items.result ? [items.result] : null) ||
      [];
  }

  if (!Array.isArray(items)) return [];

  const normalize = platform === 'amazon'
    ? normalizeAmazonProduct
    : normalizeWalmartProduct;

  return items
    .map(item => {
      try { return normalize(item); }
      catch { return null; }
    })
    .filter(Boolean)
    .filter(p => p.title && p.title !== 'Unknown product');
}

module.exports = { normalizeProducts, normalizeAmazonProduct, normalizeWalmartProduct };
