// apps/p2p.js
// Simple WS-based P2P layer (both server and outbound dials) with basic retry & logging.

const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const peersSet = new Set();
let messageHandlers = [];
const log = (...a)=>console.log('[P2P]',...a);
const err = (...a)=>console.error('[P2P]',...a);

function connectToPeer(url) {
  if ([...peersSet].some(s => s.url === url)) return;
  const ws = new WebSocket(url);
  ws.url = url;

  ws.on('open', () => {
    log('connected ->', url);
  });
  ws.on('message', (d) => {
    try {
      const msg = JSON.parse(d.toString());
      for (const h of messageHandlers) h(msg, ws);
    } catch(e) {
      err('bad message from', url, e.message);
    }
  });
  ws.on('close', () => {
    log('disconnected <-', url);
    peersSet.delete(ws);
    setTimeout(() => connectToPeer(url), 2000);
  });
  ws.on('error', (e) => {
    // ignore, reconnect handled by 'close'
  });
  peersSet.add(ws);
}

function initP2P({ p2pPort, peers = [], onOpen }) {
  const wss = new WebSocketServer({ port: p2pPort });
  wss.on('connection', (ws) => {
    log('inbound connection');
    peersSet.add(ws);
    ws.on('message', (d) => {
      try {
        const msg = JSON.parse(d.toString());
        for (const h of messageHandlers) h(msg, ws);
      } catch(e) {
        err('bad inbound msg', e.message);
      }
    });
    ws.on('close', () => { peersSet.delete(ws); });
    ws.on('error', () => {});
  });
  wss.on('listening', () => { if (onOpen) onOpen(); });

  // dial out
  for (const p of peers) connectToPeer(p);
}

function p2pBroadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of [...peersSet]) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(s); } catch {}
    }
  }
}
function p2pOnMessage(fn) { messageHandlers.push(fn); }

module.exports = { initP2P, p2pBroadcast, p2pOnMessage };
