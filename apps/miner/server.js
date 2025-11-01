// apps/miner/server.js
// PoW miner with compact target bits & polite CPU usage + logs
// Run: node apps/miner/server.js --address <ADDRESS>

const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const argv = require('minimist')(process.argv.slice(2));

const minerAddress = argv.address || argv.a;
if (!minerAddress) {
  console.error('Usage: node apps/miner/server.js --address <ADDRESS>');
  process.exit(1);
}
const NODE_URL = process.env.NODE_URL;
const NODE_WS = process.env.NODE_WS;

const log = (...a) => console.log('[MINER]', ...a);

const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const headerHash = (block) => sha256Hex(Buffer.from(`${block.index}|${block.previousHash}|${block.timestamp}|${block.merkleRoot}|${block.nonce}|${block.bits}`));
const bitsToTarget = (bits) => {
  const exp = (bits >>> 24) & 0xff;
  let mant = BigInt(bits & 0x007fffff);
  if (bits & 0x00800000) mant = mant | (1n << 23n);
  const shift = BigInt(8 * (exp - 3));
  return mant << shift;
};

function meets(hexHash, bits) {
  return BigInt('0x' + hexHash) <= bitsToTarget(bits);
}

async function mineOnce() {
  const { data: cand } = await axios.get(`${NODE_URL}/block/candidate/${minerAddress}`);
  let block = cand;
  const target = bitsToTarget(block.bits);
  const start = Date.now();
  let nonce = 0;
  let iter = 0;

  while (true) {
    for (let i = 0; i < 5000; i++) {
      block.nonce = nonce++;
      block.timestamp = Date.now();
      block.hash = headerHash(block);
      iter++;
      if (BigInt('0x' + block.hash) <= target) {
        log(`FOUND index=${block.index} nonce=${block.nonce} hash=${block.hash.slice(0, 16)}… bits=${block.bits.toString(16)} iters=${iter} ${(Date.now() - start)}ms`);
        return block;
      }
    }
    // give CPU a breath & allow new tip/candidate
    await new Promise(r => setTimeout(r, 10));
    if (Date.now() - start > 2500) return null; // refresh candidate periodically
  }
}

(async () => {
  log('connecting WS', NODE_WS);
  try {
    const ws = new WebSocket(NODE_WS);
    ws.on('open', () => log('WS connected'));
    ws.on('message', (m) => {
      try {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'new_block') {
          log(`tip advanced -> #${msg.block.index}`);
        }
      } catch { }
    });
  } catch { }

  while (true) {
    try {
      const b = await mineOnce();
      if (b) {
        try {
          const res = await axios.post(`${NODE_URL}/blocks`, b);
          log('submit ->', res.data);
        } catch (e) {
          log('submit rejected:', e.response ? e.response.data : e.message);
        }
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (e) {
      log('miner error:', e.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
})();
