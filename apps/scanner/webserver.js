// apps/scanner/webserver.js
// Web Scanner (Vue 3 CDN) + Live updates via server-side polling -> browser WebSocket
// Run: NODE_URL=http://localhost:3000 node apps/scanner/webserver.js

const express = require('express');
const path = require('path');
const axios = require('axios');
const { WebSocketServer } = require('ws');

const NODE_URL = process.env.NODE_URL;
const PORT = Number(process.env.SCANNER_PORT);

const app = express();

// -------- Static files (Vue app) --------
const PUB = path.join(__dirname, 'public');
app.use(express.static(PUB));

// -------- Lightweight proxy (avoid CORS) --------
app.get('/api/tip', async (req, res) => {
  try { res.json((await axios.get(`${NODE_URL}/tip`)).data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/chain', async (req, res) => {
  try { res.json((await axios.get(`${NODE_URL}/chain`)).data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/mempool', async (req, res) => {
  try { res.json((await axios.get(`${NODE_URL}/mempool`)).data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/block/:h', async (req, res) => {
  try { res.json((await axios.get(`${NODE_URL}/block/${req.params.h}`)).data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/tx/:id', async (req, res) => {
  try { res.json((await axios.get(`${NODE_URL}/tx/${req.params.id}`)).data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// -------- HTTP server --------
const server = app.listen(PORT, () => {
  console.log(`[SCANNER] Web UI on http://localhost:${PORT}  (proxy to ${NODE_URL})`);
});

// -------- WS to browser clients --------
const wss = new WebSocketServer({ server });
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('[SCANNER] Client connected (WS).');
  ws.on('close', () => clients.delete(ws));
});

// -------- Polling loop: fetch from node and push deltas --------
let lastHeight = -1;
let lastMempoolCount = 0;
let blockTimes = []; // ms timestamps for last N tips
const MOVING_N = 20;

function bitsToTarget(bits) {
  const exp = (bits >>> 24) & 0xff;
  let mant = BigInt(bits & 0x007fffff);
  if (bits & 0x00800000) mant = mant | (1n << 23n);
  const shift = BigInt(8 * (exp - 3));
  return mant << shift;
}
function formatHashrate(hps) {
  if (!isFinite(hps) || hps <= 0) return '—';
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
  let idx = 0;
  while (hps >= 1000 && idx < units.length - 1) { hps /= 1000; idx++; }
  return `${hps.toFixed(2)} ${units[idx]}`;
}
function emitAll(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

async function tick() {
  try {
    const [tipRes, mpRes] = await Promise.allSettled([
      axios.get(`${NODE_URL}/tip`),
      axios.get(`${NODE_URL}/mempool`),
    ]);
    const tip = tipRes.status === 'fulfilled' ? tipRes.value.data : null;
    const mempool = mpRes.status === 'fulfilled' ? mpRes.value.data : [];

    // new block?
    if (tip && typeof tip.index === 'number' && tip.index !== lastHeight) {
      const prev = lastHeight;
      lastHeight = tip.index;

      // update block time moving-average
      const now = Date.now();
      blockTimes.push(now);
      if (blockTimes.length > MOVING_N) blockTimes.shift();

      // estimate stats
      let avgBlockSec = NaN;
      if (blockTimes.length >= 2) {
        const deltas = [];
        for (let i = 1; i < blockTimes.length; i++) deltas.push(blockTimes[i] - blockTimes[i - 1]);
        const avgMs = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        avgBlockSec = avgMs / 1000;
      }
      let estHashrate = '—';
      try {
        // Hashes per block ≈ 2^256 / target
        const target = bitsToTarget(tip.bits >>> 0);
        const two256 = Math.pow(2, 256);
        const approxHashes = two256 / Number(target); // approximate double precision
        const hps = avgBlockSec ? (approxHashes / avgBlockSec) : NaN;
        estHashrate = formatHashrate(hps);
      } catch { /* ignore */ }

      // push full block for UI modal
      let blockFull = null;
      try {
        const b = await axios.get(`${NODE_URL}/block/${tip.index}`);
        blockFull = b.data;
      } catch { }

      emitAll({
        type: 'new_block',
        tip,
        block: blockFull,
        stats: {
          height: tip.index,
          bits: tip.bits,
          avgBlockSec: isFinite(avgBlockSec) ? Number(avgBlockSec.toFixed(2)) : null,
          estHashrate
        }
      });

      // also send “chain window” (last ~50 blocks) for chain strip
      try {
        const chain = (await axios.get(`${NODE_URL}/chain`)).data;
        const window = chain.slice(Math.max(0, chain.length - 50));
        emitAll({ type: 'chain_window', blocks: window });
      } catch { }
    }

    // mempool changes?
    if (Array.isArray(mempool) && mempool.length !== lastMempoolCount) {
      lastMempoolCount = mempool.length;
      emitAll({ type: 'mempool', mempool });
    }
  } catch (e) {
    console.error('[SCANNER] tick error:', e.message);
    emitAll({ type: 'error', error: e.message });
  }
}

setInterval(tick, 1500);

// initial prime (also helps when client connects slightly later)
(async () => {
  await tick();
  console.log('[SCANNER] Polling started (1.5s).');
})();
