// miner.js (continuous PoW loop)
const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');

const NODE_HTTP = 'http://localhost:3000';
const NODE_WS = 'ws://localhost:3000';
const MINER_ADDRESS = process.env.MINER_ADDRESS || 'your_miner_address_here';

const sha256hex = d => crypto.createHash('sha256').update(d).digest('hex');
function blockHash(b){return sha256hex(b.index + b.previousHash + b.timestamp + JSON.stringify(b.transactions) + b.nonce + b.difficulty);}

let abortFlag = false;
let currentDiff = 1;

async function buildTemplate() {
  const [{data:chainData},{data:memData},{data:conf}] = await Promise.all([
    axios.get(`${NODE_HTTP}/chain`),
    axios.get(`${NODE_HTTP}/mempool`),
    axios.get(`${NODE_HTTP}/config`)
  ]);
  const chain = chainData.chain;
  const mempool = memData.mempool || [];
  currentDiff = conf.difficulty;
  const reward = conf.blockReward;
  const fees = mempool.reduce((a,t)=>a+(t.fee||0),0);
  const last = chain[chain.length-1];
  const index = chain.length;
  const previousHash = last.hash;
  const timestamp = new Date().toISOString();
  const coinbase = {
    id: sha256hex('coinbase'+Date.now()),
    inputs: [],
    outputs: [{ address: MINER_ADDRESS, amount: reward + fees }]
  };
  return {index, previousHash, timestamp, txs:[coinbase,...mempool], diff:conf.difficulty};
}

async function mineLoop(){
  while(true){
    try{
      const tpl = await buildTemplate();
      const {index,previousHash,timestamp,txs,diff} = tpl;
      abortFlag = false;
      console.log(`⛏ Mining block #${index} | diff=${diff} | txs=${txs.length}`);
      let nonce=0;
      let hash;
      const start = Date.now();
      while(true){
        if(abortFlag) break;
        const block = {index,previousHash,timestamp,transactions:txs,nonce,difficulty:diff};
        hash = blockHash(block);
        if(hash.startsWith('0'.repeat(diff))){
          block.hash = hash;
          const took=((Date.now()-start)/1000).toFixed(2);
          console.log(`✅ Block mined #${index} | time=${took}s | hash=${hash}`);
          try{
            const res = await axios.post(`${NODE_HTTP}/blocks`,block);
            console.log('📦 Submitted:',res.data);
          }catch(e){
            console.error('❌ Submit error:',e.response?.data||e.message);
          }
          break;
        }
        nonce++;
        if(nonce%100000===0) process.stdout.write(`\rnonce=${nonce}`);
      }
    }catch(e){
      console.error('Miner error:', e.message);
    }
  }
}

// WebSocket listening (abort+restart)
function startWS(){
  const ws = new WebSocket(NODE_WS);
  ws.on('open',()=>console.log('🔌 Connected to node'));
  ws.on('message',buf=>{
    try{
      const msg=JSON.parse(buf.toString());
      if(['mempool_tx','new_block','config_update'].includes(msg.type)){
        console.log(`⚡ Event ${msg.type} received → rebuilding template`);
        abortFlag=true;
      }
    }catch(e){}
  });
  ws.on('close',()=>{console.log('WS closed → reconnecting...');setTimeout(startWS,3000);});
}
console.log('🚀 Continuous miner started (PoW simulation)');
startWS();
mineLoop();
