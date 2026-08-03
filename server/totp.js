'use strict';
/* Lot 4 : TOTP (RFC 6238) sans dépendance externe — HMAC-SHA1, pas de 30 s, fenêtre ±1. */
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function genererSecret(octets = 20) {
  const buf = crypto.randomBytes(octets);
  let bits = 0, valeur = 0, sortie = '';
  for (const octet of buf) {
    valeur = (valeur << 8) | octet;
    bits += 8;
    while (bits >= 5) {
      sortie += ALPHABET[(valeur >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) sortie += ALPHABET[(valeur << (5 - bits)) & 31];
  return sortie;
}

function decoderBase32(secret) {
  const propre = String(secret).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, valeur = 0;
  const octets = [];
  for (const c of propre) {
    valeur = (valeur << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      octets.push((valeur >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(octets);
}

function codeTotp(secret, compteur) {
  const cle = decoderBase32(secret);
  const tampon = Buffer.alloc(8);
  tampon.writeBigUInt64BE(BigInt(compteur));
  const hmac = crypto.createHmac('sha1', cle).update(tampon).digest();
  const decalage = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[decalage] & 0x7f) << 24 | hmac[decalage + 1] << 16 | hmac[decalage + 2] << 8 | hmac[decalage + 3]) % 1000000;
  return String(code).padStart(6, '0');
}

function verifierCode(secret, code, maintenant = Date.now()) {
  const saisi = String(code || '').replace(/\D/g, '');
  if (saisi.length !== 6) return false;
  const compteur = Math.floor(maintenant / 1000 / 30);
  for (const delta of [0, -1, 1]) {
    const attendu = codeTotp(secret, compteur + delta);
    if (crypto.timingSafeEqual(Buffer.from(attendu), Buffer.from(saisi))) return true;
  }
  return false;
}

function urlOtpauth(secret, email, emetteur = 'Tarifaire') {
  return `otpauth://totp/${encodeURIComponent(emetteur)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(emetteur)}&digits=6&period=30`;
}

module.exports = { genererSecret, verifierCode, urlOtpauth, codeTotp };
