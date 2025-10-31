// send_tx.js
const axios = require('axios');
const { createHash } = require('crypto');
const EC = require('elliptic').ec;
const ec = new EC('secp256k1');
const argv = require('minimist')(process.argv.slice(2));

const NODE = 'http://localhost:3000';
const PRIV = process.env.PRIVATE_KEY;
if (!PRIV) {
  console.error('❌ PRIVATE_KEY not set!');
  process.exit(1);
}

const fromPub = argv.from;
const toPub = argv.to;
const amount = Number(argv.amount);
const fee = Number(argv.fee || 1);
if (!fromPub || !toPub || !amount) {
  console.log('Usage: node send_tx.js --from <pub> --to <pub> --amount 5 [--fee 1]');
  process.exit(1);
}

function sha256hex(d){ return createHash('sha256').update(d).digest('hex'); }
function ripemd160hex(d){ return createHash('ripemd160').update(d).digest('hex'); }
function pubKeyToAddress(pubHex){
  const pub = Buffer.from(pubHex,'hex');
  const h = createHash('sha256').update(pub).digest();
  return ripemd160hex(h);
}
function txHashForSigning(tx){
  const slim = {
    inputs: tx.inputs.map(i => ({ txid: i.txid, index: i.index })),
    outputs: tx.outputs.map(o => ({ address: o.address, amount: o.amount }))
  };
  return sha256hex(JSON.stringify(slim));
}

(async () => {
  const key = ec.keyFromPrivate(PRIV);
  const pub = key.getPublic(true, 'hex');
  const fromAddr = pubKeyToAddress(fromPub);
  const toAddr = pubKeyToAddress(toPub);

  const { data: utx } = await axios.get(`${NODE}/utxos/${fromAddr}`);
  const utxos = utx.utxos.sort((a,b)=>a.amount-b.amount);
  let sum = 0; let selected = [];
  for (const u of utxos) {
    selected.push(u); sum += u.amount;
    if (sum >= amount + fee) break;
  }
  if (sum < amount + fee) { console.error('❌ Not enough funds'); return; }

  const change = sum - amount - fee;
  const outputs = [{ address: toAddr, amount }];
  if (change > 0) outputs.push({ address: fromAddr, amount: change });

  const tx = { inputs: selected.map(u => ({ txid: u.txid, index: u.index })), outputs };
  const msgHash = txHashForSigning(tx);
  tx.inputs = tx.inputs.map(i => {
    const sig = key.sign(msgHash, { canonical: true });
    return { ...i, pubKey: fromPub, sig: sig.toDER('hex') };
  });
  tx.id = sha256hex(JSON.stringify(tx) + Date.now());
  tx.fee = fee;

  const res = await axios.post(`${NODE}/transactions`, tx);
  console.log('✅ TX sent:', res.data);
})();
