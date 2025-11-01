// apps/blockchain/server.js
// Mini Bitcoin-like Full Node (ECDSA verify + P2P + Compact Target Bits)
// Run: node apps/blockchain/server.js

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const crypto = require('crypto');
const { initP2P, p2pBroadcast, p2pOnMessage } = require('./p2p');

const log = (...a) => console.log('[NODE]', ...a);
const warn = (...a) => console.warn('[NODE]', ...a);

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// -------------------- Directories --------------------
const DATA_DIR = __dirname + '/data';
const BLOCK_DIR = DATA_DIR + '/blocks';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BLOCK_DIR)) fs.mkdirSync(BLOCK_DIR, { recursive: true });

// -------------------- Config --------------------
const HTTP_PORT = process.env.PORT;
const P2P_PORT = process.env.P2P_PORT;
const PEERS = process.env.PEERS ? JSON.parse(process.env.PEERS) : []

let config = {
  adjustEvery: 10,          // Bitcoin adjusts difficulty every 10 blocks
  targetBlockTimeSec: 10,   // Target block time: 30 seconds
  blockSubsidy: 5,          // Initial mining reward: 5 BTC
  halvingInterval: 100,     // Reward halving occurs every 500
  coinbaseMaturity: 2,      // Coinbase rewards can be spent only after 2 confirmations
  maxBlockTx: 25,           // Larger block capacity to simulate realistic blocks
  bits: 0x1e00ffff          // Initial network difficulty
};

const CONFIG_FILE = DATA_DIR + '/config.json';
if (fs.existsSync(CONFIG_FILE)) {
  try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch { }
} else {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// -------------------- State --------------------
let chain = [];             // array of blocks
let mempool = {};           // txid -> tx
let utxo = new Map();       // `${txid}:${index}` -> { amount, address, blockHeight, isCoinbase }
let seenTx = new Set();     // prevent gossip loops
let seenBlockHash = new Set();
let mempoolSpent = new Set(); // 'txid:index'

// -------------------- Utils --------------------
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function txIdFor(tx) {
  // deterministic id without sig variability: inputs(txid,index,pubKey) + outputs
  const copy = {
    inputs: (tx.inputs || []).map(i => ({ txid: i.txid, index: i.index, pubKey: i.pubKey })),
    outputs: (tx.outputs || []).map(o => ({ address: o.address, amount: o.amount }))
  };
  return sha256Hex(Buffer.from(JSON.stringify(copy)));
}

function headerHash(block) {
  const header = `${block.index}|${block.previousHash}|${block.timestamp}|${block.merkleRoot}|${block.nonce}|${block.bits}`;
  return sha256Hex(Buffer.from(header));
}

function merkleRoot(txids) {
  if (!txids.length) return sha256Hex(Buffer.from(''));
  let nodes = txids.map(t => Buffer.from(t, 'hex'));
  while (nodes.length > 1) {
    if (nodes.length % 2 === 1) nodes.push(nodes[nodes.length - 1]);
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) {
      next.push(Buffer.from(sha256Hex(Buffer.concat([nodes[i], nodes[i + 1]])), 'hex'));
    }
    nodes = next;
  }
  return nodes[0].toString('hex');
}

// --- Compact Target Bits (Bitcoin-like) ---
function bitsToTarget(bits) {
  const size = (bits >>> 24) & 0xff;
  let mant = BigInt(bits & 0x007fffff);
  let target;
  if (size <= 3) {
    const shift = 8n * (3n - BigInt(size));
    target = mant >> shift;
  } else {
    const shift = 8n * (BigInt(size) - 3n);
    target = mant << shift;
  }
  return target;
}

function targetToBits(target) {
  if (target <= 0n) return 0;
  let hex = target.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let size = Math.ceil(hex.length / 2);
  let mantBytes;
  if (size <= 3) {
    mantBytes = hex.padStart(6, '0');
  } else {
    mantBytes = hex.slice(0, 6);
    if (parseInt(mantBytes.slice(0, 2), 16) & 0x80) {
      mantBytes = ('00' + mantBytes.slice(0, 4));
      size += 1;
    }
  }
  let mant = parseInt(mantBytes, 16) & 0x007fffff;
  return ((size << 24) | mant) >>> 0;
}

function hashMeetsBits(hexHash, bits) {
  const h = BigInt('0x' + hexHash);
  const target = bitsToTarget(bits);
  return h <= target;
}

// -------------------- Persistence --------------------
function saveBlock(block) {
  fs.writeFileSync(`${BLOCK_DIR}/block_${block.index}.json`, JSON.stringify(block, null, 2));
}
function loadBlocks() {
  const files = fs.readdirSync(BLOCK_DIR).filter(f => f.startsWith('block_') && f.endsWith('.json'));
  files.sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]));
  for (const f of files) {
    const b = JSON.parse(fs.readFileSync(`${BLOCK_DIR}/${f}`, 'utf8'));
    chain.push(b);
    seenBlockHash.add(headerHash(b));
  }
}
function rebuildUTXO() {
  utxo = new Map();
  for (const b of chain) {
    for (const tx of b.transactions) {
      // spend inputs
      for (const i of tx.inputs || []) utxo.delete(`${i.txid}:${i.index}`);
      // add outputs
      tx.outputs.forEach((o, idx) => {
        utxo.set(`${tx.id}:${idx}`, { amount: o.amount, address: o.address, blockHeight: b.index, isCoinbase: !!tx.isCoinbase });
      });
    }
  }
}

// -------------------- Consensus Rules --------------------
function getBlockReward(height) {
  const halvings = Math.floor(height / config.halvingInterval);
  const r = Math.floor(config.blockSubsidy / Math.pow(2, halvings));
  return Math.max(r, 0);
}

function pubKeyToAddress(pubKeyHex) {
  // address = RIPEMD160(SHA256(pubKey))
  const sha = crypto.createHash('sha256').update(Buffer.from(pubKeyHex, 'hex')).digest();
  return crypto.createHash('ripemd160').update(sha).digest('hex');
}

function verifyInputSig(tx, inputIndex) {
  const ec = new (require('elliptic').ec)('secp256k1');
  const inp = tx.inputs[inputIndex];
  const pub = inp.pubKey;
  const sigHex = inp.sig;
  if (!pub || !sigHex) throw new Error('missing pubKey or sig');

  // Sighash (ALL): hash( JSON.stringify({inputs:[{txid,index}], outputs}) )
  const msg = sha256Hex(Buffer.from(JSON.stringify({
    inputs: tx.inputs.map(i => ({ txid: i.txid, index: i.index })),
    outputs: tx.outputs.map(o => ({ address: o.address, amount: o.amount }))
  })));

  const key = ec.keyFromPublic(pub, 'hex');
  const sig = Buffer.from(sigHex, 'hex');
  let ok = false;
  try { ok = key.verify(msg, sig); } catch { ok = false; }
  if (!ok) throw new Error('bad signature');
  return true;
}

function validateTx(tx, currentHeight) {
  if (!tx || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs)) throw new Error('invalid tx format');

  if (tx.isCoinbase) {
    if (tx.inputs.length !== 0) throw new Error('coinbase must have no inputs');
    tx.outputs.forEach(o => { if (o.amount <= 0) throw new Error('coinbase bad amount'); });
    return true;
  }

  let inSum = 0, outSum = 0;
  const used = new Set();

  // check inputs exist & mature & signatures correct & address matches pubKey
  for (let idx = 0; idx < tx.inputs.length; idx++) {
    const i = tx.inputs[idx];
    const key = `${i.txid}:${i.index}`;
    if (used.has(key)) throw new Error('double spend in tx');
    used.add(key);

    const entry = utxo.get(key);
    if (!entry) throw new Error('missing UTXO ' + key);
    if (entry.isCoinbase && (currentHeight - entry.blockHeight) < config.coinbaseMaturity)
      throw new Error('coinbase not mature');

    // verify signature
    verifyInputSig(tx, idx);

    // verify that provided pubKey actually controls the referenced output address
    const addr = pubKeyToAddress(i.pubKey);
    if (addr !== entry.address) throw new Error('pubKey does not match UTXO address');

    inSum += entry.amount;
  }

  for (const o of tx.outputs) {
    if (o.amount <= 0) throw new Error('output <= 0');
    outSum += o.amount;
  }
  if (inSum < outSum) throw new Error('inputs < outputs');
  return true;
}

function validateBlock(block) {
  const tip = chain[chain.length - 1];
  if (chain.length === 0) {
    if (block.index !== 0) throw new Error('genesis index must be 0');
  } else {
    if (block.index !== tip.index + 1) throw new Error('bad index');
    if (block.previousHash !== headerHash(tip)) throw new Error('prev hash mismatch');
  }

  // timestamp sanity check
  const MAX_FUTURE = 2 * 60 * 60 * 1000; // 2 hours
  if (block.timestamp > Date.now() + MAX_FUTURE)
    throw new Error('timestamp too far in future');

  // basic header checks
  const txids = block.transactions.map(t => t.id);
  if (merkleRoot(txids) !== block.merkleRoot) throw new Error('merkle mismatch');
  const hh = headerHash(block);
  if (!hashMeetsBits(hh, block.bits)) throw new Error('insufficient PoW');

  // tx rules
  let coinbaseCount = 0;
  let feeTotal = 0;

  // temp UTXO (for intra-block spends)
  const temp = new Map(utxo);
  for (const tx of block.transactions) {
    if (tx.isCoinbase) {
      coinbaseCount++;
      if (tx.inputs.length !== 0) throw new Error('coinbase has inputs');
      // add outputs
      tx.outputs.forEach((o, idx) => temp.set(`${tx.id}:${idx}`, { amount: o.amount, address: o.address, blockHeight: block.index, isCoinbase: true }));
    } else {
      // spend
      let inSum = 0, outSum = 0;
      for (let idx = 0; idx < tx.inputs.length; idx++) {
        const i = tx.inputs[idx];
        const key = `${i.txid}:${i.index}`;
        const ent = temp.get(key);
        if (!ent) throw new Error('missing input ' + key);
        // signature check against original tx object (already contains sigs)
        // enforce coinbase maturity
        if (ent.isCoinbase && (block.index - ent.blockHeight) < config.coinbaseMaturity) {
          throw new Error('coinbase not mature');
        }
        verifyInputSig(tx, idx);
        // pubKey matches address
        const addr = pubKeyToAddress(i.pubKey);
        if (addr !== ent.address) throw new Error('pubKey!=address');
        inSum += ent.amount;
        temp.delete(key);
      }
      tx.outputs.forEach(o => outSum += o.amount);
      if (inSum < outSum) throw new Error('tx spends more than inputs');
      feeTotal += (inSum - outSum);
      // add outputs
      tx.outputs.forEach((o, idx) => temp.set(`${tx.id}:${idx}`, { amount: o.amount, address: o.address, blockHeight: block.index, isCoinbase: false }));
    }
  }
  if (coinbaseCount !== 1) throw new Error('block must have exactly 1 coinbase');

  // coinbase value <= subsidy + fees
  const expected = getBlockReward(block.index) + feeTotal;
  const coinbase = block.transactions.find(t => t.isCoinbase);
  const cbOut = coinbase.outputs.reduce((s, o) => s + o.amount, 0);
  if (cbOut > expected) throw new Error(`coinbase too large: ${cbOut} > ${expected}`);

  return true;
}

function applyBlock(block) {
  // spend & create
  for (const tx of block.transactions) {
    for (const i of tx.inputs || []) utxo.delete(`${i.txid}:${i.index}`);
    tx.outputs.forEach((o, idx) => utxo.set(`${tx.id}:${idx}`, { amount: o.amount, address: o.address, blockHeight: block.index, isCoinbase: !!tx.isCoinbase }));
    if (mempool[tx.id]) {
      for (const i of (tx.inputs || [])) mempoolSpent.delete(`${i.txid}:${i.index}`);
      delete mempool[tx.id];
    }
  }
  chain.push(block);
  saveBlock(block);
  seenBlockHash.add(headerHash(block));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  log(`Accepted block #${block.index} hash=${headerHash(block).slice(0, 16)}… txs=${block.transactions.length}`);
}

function maybeRetarget() {
  const h = chain.length;
  if (h === 0 || h % config.adjustEvery !== 0) return;
  const last = chain[h - 1];
  const first = chain[h - config.adjustEvery];
  const actual = (last.timestamp - first.timestamp) / 1000;
  const expected = config.adjustEvery * config.targetBlockTimeSec;
  let ratio = expected / (actual || 1);
  // clamp (like BTC caps to 4x)
  const minR = 0.25, maxR = 4;
  if (ratio < minR) ratio = minR;
  if (ratio > maxR) ratio = maxR;

  const curTarget = bitsToTarget(config.bits);
  let newTarget = BigInt(curTarget / BigInt(Math.round(1 / ratio * 1e6))) * BigInt(1e6); // smooth-ish
  if (newTarget <= 0n) newTarget = 1n;
  const newBits = targetToBits(newTarget);
  log(`Retarget @${h}: actual=${actual.toFixed(2)}s expected=${expected}s ratio=${ratio.toFixed(3)} bits ${config.bits.toString(16)} -> ${newBits.toString(16)}`);
  config.bits = newBits >>> 0;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// -------------------- API --------------------
app.get('/config', (req, res) => res.json(config));
app.get('/chain', (req, res) => res.json(chain));
app.get('/tip', (req, res) => res.json(chain[chain.length - 1] || null));
app.get('/block/:h', (req, res) => {
  const h = +req.params.h;
  if (Number.isNaN(h) || h < 0 || h >= chain.length) return res.status(404).json({ error: 'not found' });
  res.json(chain[h]);
});
app.get('/mempool', (req, res) => res.json(Object.values(mempool)));
app.get('/utxos/:addr', (req, res) => {
  const addr = req.params.addr;
  const out = [];
  for (const [k, v] of utxo.entries()) {
    if (v.address === addr) {
      const [txid, idx] = k.split(':');
      out.push({ txid, index: +idx, amount: v.amount, blockHeight: v.blockHeight, isCoinbase: v.isCoinbase });
    }
  }
  res.json({ utxos: out });
});
app.get('/tx/:id', (req, res) => {
  const id = req.params.id;
  for (const b of chain) {
    const t = b.transactions.find(x => x.id === id);
    if (t) return res.json({ tx: t, blockHeight: b.index });
  }
  if (mempool[id]) return res.json({ tx: mempool[id], blockHeight: null });
  res.status(404).json({ error: 'not found' });
});

app.post('/transactions', (req, res) => {
  try {
    const tx = req.body;
    if (!tx.id) tx.id = txIdFor(tx);
    // validation against current UTXO/state
    validateTx(tx, chain.length);

    // prevent mempool double spend
    for (const i of tx.inputs) {
      const key = `${i.txid}:${i.index}`;
      if (mempoolSpent.has(key)) throw new Error('mempool double spend');
    }

    if (mempool[tx.id]) return res.status(200).json({ ok: true, id: tx.id, note: 'duplicate in mempool' });

    mempool[tx.id] = tx;
    for (const i of tx.inputs) mempoolSpent.add(`${i.txid}:${i.index}`);

    seenTx.add(tx.id);
    log(`+ mempool tx ${tx.id.slice(0, 16)}…`);
    // Gossip to peers
    p2pBroadcast({ type: 'tx', tx });
    res.json({ ok: true, id: tx.id });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.post('/blocks', (req, res) => {
  try {
    const block = req.body;
    // recompute ids if missing
    for (const t of block.transactions) if (!t.id) t.id = txIdFor(t);
    // validate & apply
    validateBlock(block);
    applyBlock(block);
    maybeRetarget();
    // gossip
    p2pBroadcast({ type: 'block', block });
    res.json({ ok: true, height: block.index });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// block candidate for miners
app.get('/block/candidate/:address', (req, res) => {
  try {
    const addr = req.params.address;
    const tip = chain[chain.length - 1];
    const index = tip.index + 1;
    const previousHash = headerHash(tip);

    // Build coinbase
    const txs = [];
    const coinbase = {
      isCoinbase: true,
      inputs: [],
      outputs: [{ address: addr, amount: getBlockReward(index) }],
      id: null
    };

    // pick some mempool txs (no fee sorting here for brevity)
    const pool = Object.values(mempool).slice(0, config.maxBlockTx);
    // Compute fees to add to coinbase
    let fee = 0;
    for (const t of pool) {
      let inSum = 0, outSum = 0;
      for (const i of t.inputs) {
        const u = utxo.get(`${i.txid}:${i.index}`);
        if (u) inSum += u.amount;
      }
      for (const o of t.outputs) outSum += o.amount;
      if (inSum > outSum) fee += (inSum - outSum);
      txs.push(t);
    }
    coinbase.outputs[0].amount += fee;

    // finalize ids
    coinbase.id = txIdFor(coinbase);
    const list = [coinbase, ...txs];
    list.forEach(t => { if (!t.id) t.id = txIdFor(t); });

    const block = {
      index,
      previousHash,
      timestamp: Date.now(),
      transactions: list,
      merkleRoot: merkleRoot(list.map(t => t.id)),
      nonce: 0,
      bits: config.bits
    };
    block.hash = headerHash(block);
    res.json(block);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------------------- Boot --------------------
const server = app.listen(HTTP_PORT, () => {
  log(`HTTP listening on ${HTTP_PORT}`);
  loadBlocks();
  if (chain.length === 0) {
    const genesis = {
      index: 0,
      previousHash: '0',
      timestamp: Date.now(),
      transactions: [{
        id: 'genesis',
        isCoinbase: true,
        inputs: [],
        outputs: [{ address: 'genesis', amount: 0 }]
      }],
      merkleRoot: merkleRoot(['genesis']),
      nonce: 0,
      bits: config.bits
    };
    genesis.hash = headerHash(genesis);
    saveBlock(genesis);
    chain.push(genesis);
    seenBlockHash.add(headerHash(genesis));
  }
  rebuildUTXO();
  log(`Loaded ${chain.length} blocks. Tip #${chain.length - 1}`);
});

// -------------------- P2P Wiring --------------------
initP2P({
  p2pPort: P2P_PORT, peers: PEERS, onOpen: () => {
    log(`P2P listening on ${P2P_PORT} peers=${PEERS.length}`);
  }
});

// Incoming P2P messages
p2pOnMessage(async (msg) => {
  try {
    if (msg.type === 'tx') {
      const tx = msg.tx;
      if (!tx.id) tx.id = txIdFor(tx);
      if (seenTx.has(tx.id) || mempool[tx.id]) return;
      validateTx(tx, chain.length);
      for (const i of tx.inputs) {
        const k = `${i.txid}:${i.index}`;
        if (mempoolSpent.has(k)) throw new Error('mempool double spend');
      }
      mempool[tx.id] = tx;
      for (const i of tx.inputs) mempoolSpent.add(`${i.txid}:${i.index}`);

      seenTx.add(tx.id);
      log(`[P2P] tx ${tx.id.slice(0, 12)}… added from peer`);
      // rebroadcast
      p2pBroadcast({ type: 'tx', tx });
    } else if (msg.type === 'block') {
      const b = msg.block;
      const hh = headerHash(b);
      if (seenBlockHash.has(hh)) return;
      // ensure tx ids present
      for (const t of b.transactions) if (!t.id) t.id = txIdFor(t);
      validateBlock(b);
      applyBlock(b);
      maybeRetarget();
      log(`[P2P] block #${b.index} accepted from peer`);
      p2pBroadcast({ type: 'block', block: b });
    } else if (msg.type === 'get_tip') {
      const tip = chain[chain.length - 1];
      p2pBroadcast({ type: 'tip', tip });
    } else if (msg.type === 'tip') {
      // could implement fork-choice here (highest cumulative work) – omitted for brevity in this step
    }
  } catch (e) {
    warn('[P2P msg error]', e.message);
  }
});
