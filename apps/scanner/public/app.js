// apps/scanner/public/app.js

const { createApp, ref, reactive, onMounted } = Vue;

createApp({
  setup() {
    const stats = reactive({
      height: null,
      bits: null,
      avgBlockSec: null,
      estHashrate: '—',
    });
    const chainWindow = ref([]);
    const mempool = ref([]);
    const recentConfirmed = ref([]);
    const modals = reactive({ block: null, tx: null });

    const ws = ref(null);

    function short(s) { return !s ? '—' : (s.length > 20 ? s.slice(0,10)+'…'+s.slice(-8) : s); }
    function shortHash(h) { return h ? (h.slice(0,10)+'…') : '—'; }
    function formatTime(ts, full=false) {
      try {
        const d = new Date(ts);
        return full ? d.toLocaleString() : d.toLocaleTimeString();
      } catch { return '—'; }
    }
    function hashOf(b) {
      const header = `${b.index}|${b.previousHash}|${b.timestamp}|${b.merkleRoot}|${b.nonce}|${b.bits}`;
      const enc = new TextEncoder().encode(header);
      if (window.crypto && window.crypto.subtle) {
        return b.hash || b.previousHash?.slice(0,64) || b.merkleRoot || '';
      } else {
        return b.hash || b.merkleRoot || '';
      }
    }

    async function initialLoad() {
      try {
        const [tip, chain, mp] = await Promise.all([
          fetch('/api/tip').then(r=>r.json()),
          fetch('/api/chain').then(r=>r.json()),
          fetch('/api/mempool').then(r=>r.json()),
        ]);
        // chain window
        chainWindow.value = chain.slice(Math.max(0, chain.length - 50));
        mempool.value = mp || [];
        if (tip) {
          stats.height = tip.index ?? null;
          stats.bits = tip.bits ?? null;
        }
        // build recent confirmed txs
        const recent = [];
        for (let i = chain.length - 1; i >= 0 && recent.length < 50; i--) {
          const b = chain[i];
          for (const t of b.transactions) recent.push({ tx: t, blockHeight: b.index });
          if (recent.length >= 50) break;
        }
        recentConfirmed.value = recent;
      } catch (e) {
        console.error('initial load error', e);
      }
    }

    function openBlock(b) { modals.block = b; }
    function openTx(t) { modals.tx = t; }

    function reload() { initialLoad(); }

    function connectWS() {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${protocol}://${location.host}`;
      ws.value = new WebSocket(url);
      ws.value.onopen = () => console.log('[WS] connected');
      ws.value.onclose = () => { console.log('[WS] closed; retrying in 2s'); setTimeout(connectWS, 2000); };
      ws.value.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'new_block') {
            // update stats
            if (msg.stats) {
              stats.height = msg.stats.height ?? stats.height;
              stats.bits = msg.stats.bits ?? stats.bits;
              stats.avgBlockSec = msg.stats.avgBlockSec ?? stats.avgBlockSec;
              stats.estHashrate = msg.stats.estHashrate ?? stats.estHashrate;
            }
            // append block to recentConfirmed
            if (msg.block) {
              const b = msg.block;
              chainWindow.value = [...chainWindow.value.filter(x=>x.index !== b.index), b]
                                  .sort((a,b)=>a.index-b.index)
                                  .slice(Math.max(0, chainWindow.value.length - 49));
              // push txs to recent list (limit 200)
              const toAdd = b.transactions.map(t => ({ tx: t, blockHeight: b.index }));
              recentConfirmed.value = [...toAdd, ...recentConfirmed.value].slice(0, 200);
            }
          } else if (msg.type === 'chain_window') {
            chainWindow.value = msg.blocks || [];
          } else if (msg.type === 'mempool') {
            mempool.value = msg.mempool || [];
          } else if (msg.type === 'error') {
            console.warn('[WS error]', msg.error);
          }
        } catch (e) { /* ignore */ }
      };
    }

    onMounted(() => {
      initialLoad();
      connectWS();
    });

    return { stats, chainWindow, mempool, recentConfirmed, modals, openBlock, openTx, short, shortHash, formatTime, hashOf, reload };
  }
}).mount('#app');
