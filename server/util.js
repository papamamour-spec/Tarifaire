'use strict';
/* Utilitaires : CSV, nombres, arrondis. */

// Analyse CSV tolérante : détecte le séparateur (; , ou tabulation), gère les guillemets.
function parseCsv(text) {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const seps = [';', ',', '\t'];
  let sep = ';';
  let best = -1;
  for (const s of seps) {
    const n = firstLine.split(s).length;
    if (n > best) { best = n; sep = s; }
  }
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === sep) {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/^﻿/, ''));
  const records = rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] !== undefined ? r[i] : '').trim(); });
    return o;
  });
  return { header, records };
}

function toCsv(rows, columns) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const cols = columns || (rows.length ? Object.keys(rows[0]) : []);
  const lines = [cols.join(';')];
  for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(';'));
  return lines.join('\n');
}

// Nombre décimal tolérant (virgule française, espaces).
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : null;
}

function round(v, dec = 2) {
  const f = Math.pow(10, dec);
  return Math.round((Number(v) + Number.EPSILON) * f) / f;
}

// Arrondi commercial d'un prix TTC en franc CFA (sans décimale).
// regle : plus_proche | superieur | inferieur | aucun ; pas : 1, 5, 25, 50, 100...
// terminaison : ex. '90' ou '95' impose les derniers chiffres (prix psychologique).
function arrondirPrix(prix, regle, pas, terminaison) {
  let p = Number(prix);
  if (!isFinite(p) || p <= 0) return 0;
  const step = Number(pas) > 0 ? Number(pas) : 1;
  if (regle === 'aucun') p = Math.round(p);
  else if (regle === 'superieur') p = Math.ceil(p / step) * step;
  else if (regle === 'inferieur') p = Math.floor(p / step) * step;
  else p = Math.round(p / step) * step;
  if (terminaison) {
    const t = String(terminaison).replace(/\D/g, '');
    if (t) {
      const mod = Math.pow(10, t.length);
      const base = Math.floor(p / mod) * mod;
      let cand = base + Number(t);
      if (cand < p - mod / 2) cand += mod;
      p = cand;
    }
  }
  return Math.max(0, Math.round(p));
}

function validerEan(code) {
  const c = String(code || '').replace(/\D/g, '');
  if (![8, 12, 13].includes(c.length)) return false;
  const digits = c.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

module.exports = { parseCsv, toCsv, num, round, arrondirPrix, validerEan };
