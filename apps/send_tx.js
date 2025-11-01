// send_tx.js
// Example usage:
//   node send_tx.js --from 1 --to 2 --amount 5 [--fee 1] [--node http://localhost:3000]

const axios = require('axios');
const EC = require('elliptic').ec;
const crypto = require('crypto');
const argv = require('minimist')(process.argv.slice(2));

const ec = new EC('secp256k1');
const NODE = argv.node || 'http://localhost:3000';

const addressBook = {
  1: {
    privateKey: "478a542382de4171e718b581e555edab64e1434c1573968e66a9b0fffd1ea7eb",
    pubKey: "03f3ef726d1db5516307daf5dea92d69e52264e9ad7d3817767181c1acedd8a650",
    address: "0a0cf279ea90a30a5cfc8593376146b5bcde7564"
  },
  2: {
    privateKey: "bdeb98d7f08016e1697170347e00077bca74e64817d00824e25474e79e1e93f3",
    pubKey: "02bbf0e463eb396ee2992aef7f92377eecdb2173e1cc920860971340af0c32ccd6",
    address: "7001ea00801b23e345e997467c1abde0cf6b5207"
  },
  3: {
    privateKey: "dfec6f1c0a48e88b182390d352fd815e3850fe0dc83950c6003bd0d974e7e9b6",
    pubKey: "025540a6d748de052ad27281344fabd03595b6010f36295eca3906abe2f27e1ef5",
    address: "6578fd7739a4d86eda4cf7460db17a439f6af982"
  },
  4: {
    privateKey: "b5688304751d0e01e57f2eaa3ba704a04db49164137a8478db43ea37ac47a8b6",
    pubKey: "03453c76456438b9517f37ec2cd61e085275a8c085b57e9d3a539caf65d234ca0f",
    address: "7eab62390df6ce4fd2afcde38b184d29fd0cb136"
  },
};

const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

(async () => {
  const sender = addressBook[argv.from];
  const recipient = addressBook[argv.to];

  if (!sender || !recipient) {
    console.error("❌ Invalid or missing --from / --to (must be 1 or 2).");
    process.exit(1);
  }

  const fromPriv = sender.privateKey;
  const fromPub = sender.pubKey;
  const fromAddress = sender.address;
  const toAddress = recipient.address;

  const amount = Number(argv.amount);
  const fee = Number(argv.fee || 0);

  if (!amount || amount <= 0) {
    console.error("❌ Invalid or missing --amount.");
    process.exit(1);
  }

  console.log(`\n🚀 Preparing transaction:
From: ${fromAddress}
To:   ${toAddress}
Amount: ${amount}
Fee: ${fee}
`);

  // Fetch UTXOs
  let utxos;
  try {
    const res = await axios.get(`${NODE}/utxos/${fromAddress}`);
    utxos = res.data.utxos || [];
    // Get blockchain tip height
    let chainTip;
    try {
      const tipRes = await axios.get(`${NODE}/tip`);
      chainTip = tipRes.data.index;
    } catch {
      chainTip = 0;
    }

    // Filter out immature coinbase UTXOs
    const coinbaseMaturity = 2;
    utxos = utxos.filter(u => {
      if (!u.isCoinbase) return true;
      return (chainTip - u.blockHeight) >= coinbaseMaturity;
    });

    if (utxos.length === 0) {
      console.error("❌ No spendable (mature) UTXOs found for sender.");
      process.exit(1);
    }

  } catch (err) {
    console.error("❌ Error fetching UTXOs:", err.message);
    process.exit(1);
  }

  if (utxos.length === 0) {
    console.error("❌ No UTXOs found for sender.");
    process.exit(1);
  }

  // Select inputs
  let picked = [], sum = 0;
  for (const u of utxos) {
    picked.push(u);
    sum += u.amount;
    if (sum >= amount + fee) break;
  }
  if (sum < amount + fee) {
    console.error("❌ Insufficient funds.");
    process.exit(1);
  }

  const change = sum - amount - fee;
  const inputs = picked.map(u => ({ txid: u.txid, index: u.index, pubKey: fromPub }));
  const outputs = [{ address: toAddress, amount }];
  if (change > 0) outputs.push({ address: fromAddress, amount: change });

  // Create unsigned payload
  const unsignedPayload = {
    inputs: inputs.map(i => ({ txid: i.txid, index: i.index })),
    outputs: outputs.map(o => ({ address: o.address, amount: o.amount })),
  };

  // Sign
  const msgHash = sha256Hex(Buffer.from(JSON.stringify(unsignedPayload)));
  const key = ec.keyFromPrivate(fromPriv);
  const sigDER = Buffer.from(key.sign(msgHash).toDER()).toString('hex');

  // Build final tx
  const tx = { inputs: inputs.map(i => ({ ...i, sig: sigDER })), outputs };
  tx.id = msgHash;

  console.log("🧾 Transaction created:\n", JSON.stringify(tx, null, 2));

  // Submit
  try {
    const r = await axios.post(`${NODE}/transactions`, tx);
    console.log("\n✅ Transaction submitted successfully!");
    console.log("Response:", r.data);
  } catch (e) {
    console.error("❌ Error submitting tx:", e.response ? e.response.data : e.message);
  }
})();
