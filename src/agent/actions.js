/**
 * SmartShop Agent — Actions Module
 *
 * Implements the "real action" criterion of the Anakin Forge Hackathon.
 * Rather than stopping at a recommendation, the agent can:
 *
 *   1. open()        — Construct and return a direct purchase / add-to-cart URL
 *   2. browserTask() — Use Anakin's cloud browser agent (browser_task MCP tool)
 *                      to navigate to the product page and attempt to add it to
 *                      the cart autonomously. This is a real, multi-step browser
 *                      action: navigate → find button → click → confirm.
 *   3. fetchDetails()— Scrape the product page for full specs not in the listing
 *
 * No credentials are required for the demo — the agent navigates the public
 * product page and demonstrates the add-to-cart flow without completing checkout.
 */

'use strict';

const client = require('../api/anakinClient');

// ─────────────────────────────────────────────────────────────────────────────
//  1. Cart URL builder (instant, no API call needed)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a direct "add to cart" or product page URL for a normalised product.
 * For Amazon we can pre-load the cart via the /gp/aws/cart/add endpoint.
 * For Walmart we send to the product detail page (no public cart-add URL exists).
 *
 * @param {object} product  - normalised product from the pipeline
 * @returns {{ actionUrl: string, actionLabel: string, actionType: string }}
 */
function buildActionUrl(product) {
  if (product.platform === 'amazon' && product.id) {
    return {
      actionUrl:   `https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=${product.id}&Quantity.1=1`,
      actionLabel: 'Add to Amazon Cart',
      actionType:  'add_to_cart',
    };
  }
  if (product.platform === 'walmart' && product.id) {
    // Walmart add-to-cart requires auth; send user to product page instead
    return {
      actionUrl:   product.url || `https://www.walmart.com/ip/${product.id}`,
      actionLabel: 'View on Walmart',
      actionType:  'view_product',
    };
  }
  return {
    actionUrl:   product.url || '',
    actionLabel: 'View Product',
    actionType:  'view_product',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. Browser task — autonomous cloud-browser action via Anakin browser_task
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Use Anakin's browser_task tool to navigate to the product page and attempt
 * to add it to the cart. This is a real autonomous browser action — the agent
 * drives a cloud Chromium instance through multiple steps without human input.
 *
 * The task is intentionally safe:
 *   - It does NOT complete checkout or charge any payment method
 *   - It stops after adding to cart (or reaching the login wall)
 *   - It returns a structured result with steps taken + screenshot evidence
 *
 * @param {object} product       - normalised product
 * @param {object} [outputSchema]- optional JSON schema for structured result
 * @returns {Promise<object>}
 */
async function browserAddToCart(product) {
  const { actionUrl, actionLabel } = buildActionUrl(product);

  if (!actionUrl) {
    throw new Error('No product URL available for browser action');
  }

  const prompt = product.platform === 'amazon'
    ? `Navigate to this Amazon product page: ${product.url || actionUrl}. ` +
      `Find the "Add to Cart" button and click it. ` +
      `If a login page appears, stop and report that authentication is required. ` +
      `Do NOT proceed past the cart page. ` +
      `Return: whether add-to-cart succeeded, current cart status, and any error.`
    : `Navigate to this Walmart product page: ${product.url || actionUrl}. ` +
      `Find the "Add to cart" button and click it. ` +
      `If a login page appears, stop and report that authentication is required. ` +
      `Do NOT proceed past the cart page. ` +
      `Return: whether add-to-cart succeeded, current cart status, and any error.`;

  const result = await client.mcpRequest('tools/call', {
    name: 'browser_task',
    arguments: {
      prompt,
      url: product.url || actionUrl,
      max_steps: 8,
      timeout_ms: 60000,
      output_schema: {
        type: 'object',
        properties: {
          success:      { type: 'boolean', description: 'Whether add-to-cart action succeeded' },
          steps_taken:  { type: 'number',  description: 'Number of browser steps performed' },
          cart_status:  { type: 'string',  description: 'Current cart state after action' },
          final_url:    { type: 'string',  description: 'URL the browser ended on' },
          error:        { type: 'string',  description: 'Error message if action failed' },
          requires_auth:{ type: 'boolean', description: 'True if login was required' },
        },
      },
    },
  });

  const parsed = client.parseToolResult(result);
  return {
    product:     { title: product.title, platform: product.platform, url: product.url },
    actionLabel,
    actionUrl,
    browserResult: parsed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  3. Scrape product page for full specs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scrape the product detail page and return full specs as markdown + JSON.
 * Used to enrich Amazon products the same way Walmart products get enriched
 * via the Wire detail endpoint.
 *
 * @param {object} product  - normalised product (must have a url)
 * @returns {Promise<{ markdown: string, specs: object }>}
 */
async function scrapeProductPage(product) {
  if (!product.url) throw new Error('Product has no URL to scrape');

  const scraped = await client.scrape(product.url, true /* generateJson */);

  const specs = scraped?.generatedJson || {};
  const markdown = scraped?.markdown   || '';

  return { markdown, specs };
}

// ─────────────────────────────────────────────────────────────────────────────
//  4. Enrich Amazon product details via Wire (am_product_details)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch full Amazon product details using the am_product_details Wire action.
 * Mirrors the Walmart enrichment step done in the main pipeline.
 *
 * @param {string} asin  - Amazon ASIN
 * @returns {Promise<object>}
 */
async function amazonProductDetails(asin) {
  const result = await client.mcpRequest('tools/call', {
    name: 'wire_read_action',
    arguments: {
      action_id: 'am_product_details',
      params: { asin },
    },
  });
  return client.parseToolResult(result);
}

/**
 * Fetch Amazon product reviews via the am_product_reviews Wire action.
 *
 * @param {string} asin  - Amazon ASIN
 * @returns {Promise<object>}
 */
async function amazonProductReviews(asin) {
  const result = await client.mcpRequest('tools/call', {
    name: 'wire_read_action',
    arguments: {
      action_id: 'am_product_reviews',
      params: { asin },
    },
  });
  return client.parseToolResult(result);
}

module.exports = {
  buildActionUrl,
  browserAddToCart,
  scrapeProductPage,
  amazonProductDetails,
  amazonProductReviews,
};
