// apps/generate-address.js
// Generate secp256k1 keypair and address = RIPEMD160(SHA256(pub))
// Run: node apps/generate-address.js

const EC = require('elliptic').ec;
const ec = new EC('secp256k1');
const crypto = require('crypto');

const key = ec.genKeyPair();
const priv = key.getPrivate('hex');
const pub = key.getPublic(true, 'hex');

const sha = crypto.createHash('sha256').update(Buffer.from(pub,'hex')).digest();
const addr = crypto.createHash('ripemd160').update(sha).digest('hex');

console.log('privateKey:', priv);
console.log('pubKey    :', pub, '(compressed)');
console.log('address   :', addr);
