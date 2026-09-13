/**
 * SmartShop Agent — Web Server
 * Exposes:
 *   POST /api/search          — run the agent, returns JSON result
 *   GET  /api/search/stream   — SSE streaming version (live progress updates)
 *   GET  /                    — serves the web UI
 */

'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const agent   = require('./agent/smartshop');
const { browserAddToCart, scrapeProductPage } = require('./agent/actions');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'ui/public')));

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'SmartShop', version: '1.0.0' });
});

// ── Key pool status ───────────────────────────────────────
app.get('/api/keys/status', (_req, res) => {
  const { keyPool } = require('./api/anakinClient');
  res.json({ keys: keyPool.status(), total: keyPool.size });
});

// ── Key diagnostic — tests first key with a live API call ─
app.get('/api/keys/test', async (req, res) => {
  try {
    const fetch  = require('node-fetch');
    const { keyPool } = require('./api/anakinClient');
    const key = await keyPool.getKey();
    const MCP_URL = process.env.ANAKIN_MCP_URL || 'https://mcp.anakin.io/mcp';

    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json, text/event-stream',
        'X-API-Key':    key,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method:  'tools/call',
        params: { name: 'wire_read_action', arguments: { action_id: 'am_search_products', params: { query: 'test', limit: 1 } } },
      }),
      signal: AbortSignal.timeout(60000),
    });

    const raw      = await response.text();
    const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
    const payload  = dataLine ? JSON.parse(dataLine.slice(5)) : null;
    const text     = payload?.result?.content?.[0]?.text || '';

    res.json({
      keySuffix:   key.slice(-8),
      httpStatus:  response.status,
      success:     text.toLowerCase().includes('product'),
      responseText: text.slice(0, 300),
      serverIP:    req.socket.localAddress,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/search — blocking JSON response ─────────────
app.post('/api/search', async (req, res) => {
  const { query, enrichWalmart = true, includeWebContext = false, limit = 12 } = req.body;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required and must be a non-empty string.' });
  }

  try {
    const result = await agent.search(query.trim(), { enrichWalmart, includeWebContext, limit });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[POST /api/search] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/search/stream — SSE live progress ────────────
app.get('/api/search/stream', async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'q query param is required' });
  }

  // Set up SSE
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  function sendEvent(type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  sendEvent('start', { query });

  try {
    const emitter = await agent.run(query, {
      enrichWalmart:     req.query.enrich !== 'false',
      includeWebContext: req.query.web    !== 'false',  // DEFAULT ON — only off if ?web=false
      limit:             parseInt(req.query.limit, 10) || 12,
    });

    emitter.on('step',       d => sendEvent('step',       d));
    emitter.on('intent',     d => sendEvent('intent',     d));
    emitter.on('warning',    d => sendEvent('warning',    { message: d }));
    emitter.on('raw_counts', d => sendEvent('raw_counts', d));
    emitter.on('web_context',d => sendEvent('web_context',d));
    emitter.on('ai_summary', d => sendEvent('ai_summary', d));  // ← was missing

    emitter.on('done', result => {
      sendEvent('done', result);
      res.end();
    });

    emitter.on('error', err => {
      sendEvent('error', { message: err.message });
      res.end();
    });

    req.on('close', () => {
      emitter.removeAllListeners();
    });
  } catch (err) {
    sendEvent('error', { message: err.message });
    res.end();
  }
});

// ── POST /api/action — agent takes a real browser action on a product ────────
//  body: { product: { id, platform, url, title }, action: 'add_to_cart'|'scrape' }
app.post('/api/action', async (req, res) => {
  const { product, action = 'add_to_cart' } = req.body;

  if (!product || !product.url) {
    return res.status(400).json({ error: 'product.url is required' });
  }

  // Stream the action progress over SSE so the UI can show live steps
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  function send(type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  send('start', { action, product: product.title });

  try {
    if (action === 'scrape') {
      send('step', { label: `📄 Scraping product page for full specs…` });
      const result = await scrapeProductPage(product);
      send('done', result);
    } else {
      // Default: browser add-to-cart (the "real action" for the hackathon demo)
      send('step', { label: `🤖 Launching cloud browser agent for "${product.title?.slice(0,50)}"…` });
      send('step', { label: `🌐 Navigating to ${product.platform === 'amazon' ? 'Amazon' : 'Walmart'} product page…` });
      const result = await browserAddToCart(product);
      send('step', { label: `✅ Browser task complete — ${result.browserResult?.success ? 'added to cart!' : 'action attempted'}` });
      send('done', result);
    }
  } catch (err) {
    console.error('[POST /api/action] Error:', err.message);
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

// ── GET /api/action/stream — same as above but GET for EventSource ────────────
app.get('/api/action/stream', async (req, res) => {
  const productUrl      = req.query.url;
  const productPlatform = req.query.platform || 'amazon';
  const productId       = req.query.id       || '';
  const productTitle    = req.query.title    || 'Product';

  if (!productUrl) {
    return res.status(400).json({ error: 'url query param is required' });
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  function send(type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  send('start', { url: productUrl });

  try {
    send('step', { label: `🤖 Launching Anakin cloud browser agent…` });
    send('step', { label: `🌐 Navigating to ${productPlatform === 'amazon' ? 'Amazon' : 'Walmart'} product page…` });

    const result = await browserAddToCart({
      id:       productId,
      platform: productPlatform,
      url:      productUrl,
      title:    productTitle,
    });

    send('step', { label: `✅ Browser task complete!` });
    send('done', result);
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});


app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'ui/public/index.html'));
});

const httpServer = app.listen(PORT, () => {
  console.log(`\n🛍  SmartShop Agent running at http://localhost:${PORT}`);
  console.log(`   POST http://localhost:${PORT}/api/search`);
  console.log(`   GET  http://localhost:${PORT}/api/search/stream?q=<query>\n`);
});

module.exports = httpServer;
