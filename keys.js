// keys.js
const { randomBytes, createHash } = require('crypto');
const EC = require('elliptic').ec;
const ec = new EC('secp256k1');

function sha256(buf) { return createHash('sha256').update(buf).digest(); }
function ripemd160(buf) { return createHash('ripemd160').update(buf).digest(); }

function pubKeyToAddress(pubKeyHex) {
  const pub = Buffer.from(pubKeyHex, 'hex');
  return ripemd160(sha256(pub)).toString('hex');
}

const priv = randomBytes(32).toString('hex');
const key = ec.keyFromPrivate(priv);
const pub = key.getPublic(true, 'hex');
const address = pubKeyToAddress(pub);

console.log('=============================');
console.log('🔑  Private Key:', priv);
console.log('🔒  Public Key :', pub);
console.log('🏠  Address    :', address);
console.log('=============================');
