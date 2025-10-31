// server.js (difficulty adjusts every N blocks to keep avg ≈ targetBlockTimeSec)
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EC = require('elliptic').ec;
const ec = new EC('secp256k1');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
app.use(bodyParser.json());

const PORT = 3000;
const BLOCKS_DIR = path.join(__dirname, 'blocks');
if (!fs.existsSync(BLOCKS_DIR)) fs.mkdirSync(BLOCKS_DIR);

const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

let chain = [];
let mempool = [];
let UTXO = new Map();

const sha256hex = d => crypto.createHash('sha256').update(d).digest('hex');
const sha256 = d => crypto.createHash('sha256').update(d).digest();
const ripemd160hex = d => crypto.createHash('ripemd160').update(d).digest('hex');
function pubKeyToAddress(pubKeyHex){return ripemd160hex(sha256(Buffer.from(pubKeyHex,'hex')));}
function blockHash(b){return sha256hex(b.index + b.previousHash + b.timestamp + JSON.stringify(b.transactions) + b.nonce + b.difficulty);}
function txHashForSigning(tx){
  const slim = {
    inputs: tx.inputs.map(i => ({ txid: i.txid, index: i.index })),
    outputs: tx.outputs.map(o => ({ address: o.address, amount: o.amount }))
  };
  return sha256hex(JSON.stringify(slim));
}

function createGenesisBlock(){
  const g={index:0,timestamp:new Date().toISOString(),transactions:[],previousHash:'0',nonce:0,difficulty:config.difficulty};
  g.hash=blockHash(g);
  return g;
}
function applyTxToUTXO(tx){
  for(const inp of (tx.inputs||[])) UTXO.delete(`${inp.txid}:${inp.index}`);
  tx.outputs.forEach((o,i)=>UTXO.set(`${tx.id}:${i}`,{address:o.address,amount:o.amount}));
}
function rebuildUTXO(){
  UTXO.clear();
  for(const b of chain) for(const tx of b.transactions) applyTxToUTXO(tx);
}
function loadChain(){
  const files=fs.readdirSync(BLOCKS_DIR).filter(f=>f.endsWith('.txt')).sort();
  if(files.length===0){
    const g=createGenesisBlock();
    chain.push(g);
    fs.writeFileSync(path.join(BLOCKS_DIR,'block_0.txt'),JSON.stringify(g,null,2));
    console.log('🧱 Genesis block created');
  }else{
    for(const f of files) chain.push(JSON.parse(fs.readFileSync(path.join(BLOCKS_DIR,f),'utf8')));
    console.log(`📦 Loaded ${chain.length} blocks`);
  }
  rebuildUTXO();
}
loadChain();

// validation
function validateTx(tx, utxoSet=UTXO){
  const isCoinbase=!tx.inputs||tx.inputs.length===0;
  if(isCoinbase)return{ok:true,fee:0};
  let inSum=0,outSum=0;
  const msgHash=txHashForSigning(tx);
  for(const inp of tx.inputs){
    const key=`${inp.txid}:${inp.index}`;
    const u=utxoSet.get(key);
    if(!u)return{ok:false,error:`missing utxo ${key}`};
    const addr=pubKeyToAddress(inp.pubKey);
    if(addr!==u.address)return{ok:false,error:'pubKey mismatch'};
    const pub=ec.keyFromPublic(inp.pubKey,'hex');
    if(!pub.verify(msgHash,inp.sig))return{ok:false,error:'bad signature'};
    inSum+=u.amount;
  }
  for(const o of tx.outputs){
    if(typeof o.amount!=='number'||o.amount<=0)return{ok:false,error:'invalid output'};
    outSum+=o.amount;
  }
  const fee=inSum-outSum;
  if(fee<0)return{ok:false,error:'negative fee'};
  return{ok:true,fee};
}

function validateBlock(block){
  const last=chain[chain.length-1];
  if(block.previousHash!==last.hash)return{ok:false,error:'prev hash mismatch'};
  if(block.hash!==blockHash(block))return{ok:false,error:'bad block hash'};
  if(!block.hash.startsWith('0'.repeat(block.difficulty)))return{ok:false,error:'not meeting difficulty'};
  const temp=new Map(UTXO);
  for(const tx of block.transactions){
    const v=validateTx(tx,temp);
    if(!v.ok)return v;
    for(const i of(tx.inputs||[]))temp.delete(`${i.txid}:${i.index}`);
    tx.outputs.forEach((o,i)=>temp.set(`${tx.id}:${i}`,{address:o.address,amount:o.amount}));
  }
  return{ok:true};
}

// difficulty adjustment (real)
function adjustDifficulty() {
  const n = config.adjustEvery;
  if (chain.length <= n) return;

  const lastN = chain.slice(-n);
  const times = lastN.map(b => new Date(b.timestamp).getTime());
  const duration = (times[times.length - 1] - times[0]) / 1000; // seconds
  const avgTime = duration / (n - 1);
  const target = config.targetBlockTimeSec;
  const ratio = avgTime / target;

  // log previous difficulty
  const oldDiff = config.difficulty;

  if (ratio < 0.9) config.difficulty++;        // blocks too fast
  else if (ratio > 1.1) config.difficulty = Math.max(1, config.difficulty - 1);

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`⚙️ Difficulty adjust: old=${oldDiff}, new=${config.difficulty}, avgTime=${avgTime.toFixed(2)}s`);
  wsBroadcast({ type:'config_update', config });
}

// API
app.get('/chain',(req,res)=>res.json({length:chain.length,chain}));
app.get('/mempool',(req,res)=>res.json({mempool}));
app.get('/config',(req,res)=>res.json(config));

app.post('/transactions',(req,res)=>{
  const tx=req.body;
  tx.id=tx.id||sha256hex(JSON.stringify(tx)+Date.now());
  const v=validateTx(tx);
  if(!v.ok)return res.status(400).json({error:v.error});
  tx.fee=v.fee;
  mempool.push(tx);
  console.log(`💰 TX added: ${tx.id} | fee=${v.fee}`);
  wsBroadcast({type:'mempool_tx',tx});
  res.json({status:'added',id:tx.id});
});

app.post('/blocks',(req,res)=>{
  const block=req.body;
  const v=validateBlock(block);
  if(!v.ok)return res.status(400).json({error:v.error});

  chain.push(block);
  fs.writeFileSync(path.join(BLOCKS_DIR,`block_${block.index}.txt`),JSON.stringify(block,null,2));
  for(const tx of block.transactions)applyTxToUTXO(tx);
  const ids=new Set(block.transactions.map(t=>t.id));
  mempool=mempool.filter(t=>!ids.has(t.id));
  console.log(`🧱 Block #${block.index} accepted (diff=${block.difficulty})`);
  wsBroadcast({type:'new_block',header:{index:block.index,hash:block.hash,difficulty:block.difficulty,txs:block.transactions.length}});
  adjustDifficulty();
  res.json({status:'block accepted',index:block.index});
});

// WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
function wsBroadcast(obj){
  const msg=JSON.stringify(obj);
  wss.clients.forEach(c=>{if(c.readyState===1)c.send(msg);});
}
wss.on('connection',(ws)=>{
  console.log('🔌 Miner connected');
  ws.send(JSON.stringify({type:'hello',height:chain.length,diff:config.difficulty}));
});
server.listen(PORT,()=>console.log(`🚀 Node running on http://localhost:${PORT}`));
