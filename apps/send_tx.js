// apps/send_tx.js
// Create & sign a transaction (ECDSA) and send to node
// Run: node apps/send_tx.js --fromPriv <priv> --fromPub <pub> --to <address> --amount 10 [--fee 1] [--node http://localhost:3000]

const axios = require('axios');
const EC = require('elliptic').ec;
const crypto = require('crypto');
const argv = require('minimist')(process.argv.slice(2));

const ec = new EC('secp256k1');
const NODE = argv.node || 'http://localhost:3000';

const sha256Hex = (b)=> crypto.createHash('sha256').update(b).digest('hex');

(async ()=>{
  const priv = argv.fromPriv;
  const pub = argv.fromPub;
  const to = argv.to;
  const amount = Number(argv.amount);
  const fee = Number(argv.fee || 0);
  if (!priv || !pub || !to || !amount) {
    console.error('Usage: node apps/send_tx.js --fromPriv <priv> --fromPub <pub> --to <address> --amount <num> [--fee <num>]');
    process.exit(1);
  }

  // Fetch UTXOs (address == RIPEMD160(SHA256(pub)))
  const sha = crypto.createHash('sha256').update(Buffer.from(pub,'hex')).digest();
  const fromAddress = crypto.createHash('ripemd160').update(sha).digest('hex');

  const ut = await axios.get(`${NODE}/utxos/${fromAddress}`);
  const utxos = ut.data.utxos;
  let picked = [], sum = 0;
  for (const u of utxos) {
    picked.push(u); sum += u.amount; if (sum >= amount + fee) break;
  }
  if (sum < amount + fee) { console.error('insufficient funds'); process.exit(1); }

  const change = sum - amount - fee;
  const inputs = picked.map(u => ({ txid: u.txid, index: u.index, pubKey: pub }));
  const outputs = [{ address: to, amount }];
  if (change > 0) outputs.push({ address: fromAddress, amount: change });

  const unsignedPayload = {
    inputs: inputs.map(i => ({ txid: i.txid, index: i.index })),
    outputs: outputs.map(o => ({ address: o.address, amount: o.amount }))
  };
  const msg = sha256Hex(Buffer.from(JSON.stringify(unsignedPayload)));

  const key = ec.keyFromPrivate(priv);
  const sigDER = Buffer.from(key.sign(msg).toDER()).toString('hex');

  const tx = { inputs: inputs.map(i => ({...i, sig: sigDER})), outputs };
  tx.id = sha256Hex(Buffer.from(JSON.stringify(unsignedPayload)));

  const r = await axios.post(`${NODE}/transactions`, tx);
  console.log('submitted tx:', r.data);
})();
