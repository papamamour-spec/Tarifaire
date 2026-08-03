'use strict';
/* Tests unitaires des fonctions pures : arrondis, EAN, CSV, TOTP. Aucune base requise. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { arrondirPrix, validerEan, parseCsv, toCsv, num, round } = require('../server/util');
const { genererSecret, codeTotp, verifierCode } = require('../server/totp');

test('arrondirPrix : au plus proche avec pas de 25', () => {
  assert.equal(arrondirPrix(4112, 'plus_proche', 25), 4100);
  assert.equal(arrondirPrix(4113, 'plus_proche', 25), 4125);
});

test('arrondirPrix : supérieur et inférieur', () => {
  assert.equal(arrondirPrix(4101, 'superieur', 50), 4150);
  assert.equal(arrondirPrix(4199, 'inferieur', 50), 4150);
});

test('arrondirPrix : terminaison psychologique', () => {
  const p = arrondirPrix(4100, 'plus_proche', 5, '95');
  assert.equal(String(p).endsWith('95'), true);
  assert.ok(Math.abs(p - 4100) <= 100);
});

test('arrondirPrix : jamais négatif ni décimal (franc CFA)', () => {
  assert.equal(arrondirPrix(-50, 'plus_proche', 5), 0);
  assert.equal(Number.isInteger(arrondirPrix(1234.56, 'aucun', 1)), true);
});

test('validerEan : clés valides et invalides', () => {
  assert.equal(validerEan('6111242100992'), true);   // EAN-13 valide
  assert.equal(validerEan('6111242100991'), false);  // mauvaise clé
  assert.equal(validerEan('12345678'), false);       // EAN-8 mauvaise clé
  assert.equal(validerEan('96385074'), true);        // EAN-8 valide
  assert.equal(validerEan('abc'), false);
});

test('parseCsv : séparateur point-virgule, guillemets, virgule décimale', () => {
  const { header, records } = parseCsv('code;libelle;prix\nA1;"Riz; parfumé";1 234,5');
  assert.deepEqual(header, ['code', 'libelle', 'prix']);
  assert.equal(records[0].libelle, 'Riz; parfumé');
  assert.equal(num(records[0].prix), 1234.5);
});

test('parseCsv : détection du séparateur virgule et tabulation', () => {
  assert.equal(parseCsv('a,b\n1,2').records[0].b, '2');
  assert.equal(parseCsv('a\tb\n1\t2').records[0].b, '2');
});

test('toCsv : échappement des valeurs', () => {
  const csv = toCsv([{ a: 'x;y', b: 'l1\nl2' }]);
  assert.ok(csv.includes('"x;y"'));
  assert.ok(csv.includes('"l1\nl2"'));
});

test('round : arrondi stable à 2 décimales', () => {
  assert.equal(round(1.005, 2), 1.01);
  assert.equal(round(2.675, 2), 2.68);
});

test('TOTP : le code généré est accepté, un code faux est rejeté', () => {
  const secret = genererSecret();
  const maintenant = Date.now();
  const code = codeTotp(secret, Math.floor(maintenant / 1000 / 30));
  assert.equal(verifierCode(secret, code, maintenant), true);
  const faux = String((Number(code) + 1) % 1000000).padStart(6, '0');
  assert.equal(verifierCode(secret, faux, maintenant), false);
});

test('TOTP : fenêtre de tolérance ±1 pas', () => {
  const secret = genererSecret();
  const maintenant = Date.now();
  const codePrecedent = codeTotp(secret, Math.floor(maintenant / 1000 / 30) - 1);
  assert.equal(verifierCode(secret, codePrecedent, maintenant), true);
});
