/**
 * Anakin MCP Client
 * Thin wrapper around the Anakin MCP HTTP endpoint (https://mcp.anakin.io/mcp).
 *
 * Key rotation: uses KeyPool to automatically switch API keys when one hits
 * its rate/credit limit. All tool wrappers are transparent to this — they
 * just call mcpRequest() and the pool handles key selection + rotation.
 */

'use strict';

require('dotenv').config();
const fetch   = require('node-fetch');
const keyPool = require('./keyPool');

const MCP_URL = process.env.ANAKIN_MCP_URL || 'https://mcp.anakin.io/mcp';

let _requestId = 0;
function nextId() { return ++_requestId; }

// ─────────────────────────────────────────────────────────
//  Core MCP request — with automatic key rotation
// ─────────────────────────────────────────────────────────

/**
 * Send a JSON-RPC 2.0 request to the MCP endpoint.
 * Automatically rotates to the next API key on rate-limit errors.
 *
 * @param {string} method
 * @param {object} params
 * @param {number} maxAttempts  - total attempts across all keys (default: keys × 2)
 * @returns {Promise<any>}      - the `result` field of the JSON-RPC response
 */
async function mcpRequest(method, params = {}, maxAttempts = null) {
  const attempts = maxAttempts ?? keyPool.size * 2;

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: nextId(),
    method,
    params,
  });

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const apiKey = await keyPool.getKey();

    let res;
    try {
      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), 90_000);
      try {
        res = await fetch(MCP_URL, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept':       'application/json, text/event-stream',
            'X-API-Key':    apiKey,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (networkErr) {
      lastError = networkErr;
      await sleep(1000 * attempt);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      lastError = new Error(`MCP HTTP ${res.status}: ${text}`);
      if (res.status === 429) {
        keyPool.markExhausted(apiKey);
        continue;
      }
      throw lastError;
    }

    // Parse SSE stream — find the first `data: {...}` line
    const raw      = await res.text();
    const dataLine = raw.split('\n').find(l => l.startsWith('data:'));

    if (!dataLine) {
      lastError = new Error(`MCP response had no data line:\n${raw.slice(0, 200)}`);
      await sleep(500);
      continue;
    }

    const payload = JSON.parse(dataLine.slice(5).trim());

    if (payload.error) {
      lastError = new Error(`MCP error [${payload.error.code}]: ${payload.error.message}`);
      throw lastError;
    }

    return payload.result;
  }

  throw lastError ?? new Error('mcpRequest failed after all attempts');
}

// ─────────────────────────────────────────────────────────
//  Tool result parser
// ─────────────────────────────────────────────────────────

/**
 * Parse JSON from an MCP tool content block.
 * Detects Wire-level error strings and throws with isRateLimit flag.
 */
function parseToolResult(result) {
  if (!result || !result.content || !result.content[0]) {
    throw new Error('Empty tool result');
  }
  const text = result.content[0].text;

  // Detect plain-text Wire error strings BEFORE attempting JSON parse
  if (typeof text === 'string') {
    if (text.startsWith("Tool '") && text.includes('failed:')) {
      const err       = new Error(text);
      err.isRateLimit = /rate.?limit|burst.?limit|slow.?down|too.?many/i.test(text);
      err.isExhausted = /credit|quota|limit.?reached|out.?of.?credit/i.test(text);
      throw err;
    }
    if (/rate.?limit|burst.?limit|slow.?down|too.?many.?request/i.test(text)) {
      const err       = new Error(text);
      err.isRateLimit = true;
      throw err;
    }
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.status === 'error' && parsed.message) {
      throw new Error(`Wire error: ${parsed.message}`);
    }
    return parsed;
  } catch (jsonErr) {
    if (jsonErr.message.startsWith('Wire error:')) throw jsonErr;
    return text; // genuine plain-text result
  }
}

// ─────────────────────────────────────────────────────────
//  Rate-limit retry wrapper — rotates key on each failure
// ─────────────────────────────────────────────────────────

/**
 * Wraps a tool call with automatic key rotation on rate-limit errors.
 * On each rate-limit hit it marks the current key exhausted and retries
 * immediately with the next key in the pool.
 */
async function withRotation(fn) {
  const maxTries = keyPool.size * 2 + 1;
  let lastError;

  for (let i = 0; i < maxTries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLimit = err.isRateLimit || err.isExhausted ||
        /rate.?limit|burst.?limit|slow.?down|too.?many|credit/i.test(err.message);

      if (isLimit) {
        // Mark the key that just failed (mcpRequest already called getKey, so
        // currentIndex is still pointing at it)
        const currentKey = await keyPool.getKey();
        keyPool.markExhausted(currentKey);
        // No sleep — getKey() will wait if all keys are cooling
        continue;
      }
      throw err; // non-rate-limit error — propagate immediately
    }
  }

  throw lastError ?? new Error('All key rotation attempts exhausted');
}

// ─────────────────────────────────────────────────────────
//  Exported tool wrappers
// ─────────────────────────────────────────────────────────

async function amazonSearch(query, limit = 10) {
  return withRotation(async () => {
    const result = await mcpRequest('tools/call', {
      name: 'wire_read_action',
      arguments: { action_id: 'am_search_products', params: { query, limit } },
    });
    return parseToolResult(result);
  });
}

async function walmartSearch(query, limit = 10) {
  return withRotation(async () => {
    const result = await mcpRequest('tools/call', {
      name: 'wire_read_action',
      arguments: { action_id: 'walmart_search', params: { query, limit } },
    });
    return parseToolResult(result);
  });
}

async function walmartProductDetails(itemId) {
  return withRotation(async () => {
    const result = await mcpRequest('tools/call', {
      name: 'wire_read_action',
      arguments: { action_id: 'walmart_product_details', params: { item_id: String(itemId) } },
    });
    return parseToolResult(result);
  });
}

async function walmartReviews(itemId) {
  return withRotation(async () => {
    const result = await mcpRequest('tools/call', {
      name: 'wire_read_action',
      arguments: { action_id: 'walmart_reviews', params: { item_id: String(itemId), page: 1 } },
    });
    return parseToolResult(result);
  });
}

async function scrape(url, genJson = false) {
  return withRotation(async () => {
    const result = await mcpRequest('tools/call', {
      name: 'scrape',
      arguments: { url, generateJson: genJson, forceFresh: true },
    });
    return parseToolResult(result);
  });
}

async function webSearch(prompt, limit = 8) {
  return withRotation(async () => {
    const result = await mcpRequest('tools/call', {
      name: 'search',
      arguments: { prompt, limit },
    });
    return parseToolResult(result);
  });
}

async function deepResearch(prompt, schema = null) {
  return withRotation(async () => {
    const args = { prompt };
    if (schema) args.schema = schema;
    const result = await mcpRequest('tools/call', {
      name: 'deep_research',
      arguments: args,
    });
    return parseToolResult(result);
  });
}

async function wireDiscover(q, limit = 5) {
  return withRotation(async () => {
    const result = await mcpRequest('tools/call', {
      name: 'wire_discover',
      arguments: { q, limit },
    });
    return parseToolResult(result);
  });
}

// ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  amazonSearch,
  walmartSearch,
  walmartProductDetails,
  walmartReviews,
  scrape,
  webSearch,
  deepResearch,
  wireDiscover,
  mcpRequest,
  parseToolResult,
  keyPool,  // expose pool so server can show status
};
