'use strict';
/* Module M7 : veille concurrentielle — relevés terrain, imports, indices de prix. */
const express = require('express');
const { query } = require('../db');
const { exiger, auditer } = require('../auth');
const { parseCsv, toCsv, num, round } = require('../util');

const r = express.Router();

/* ---------------- Enseignes concurrentes ---------------- */
r.get('/enseignes', async (req, res) => {
  const { rows } = await query('SELECT * FROM enseignes_concurrentes ORDER BY code');
  res.json(rows);
});

r.post('/enseignes', exiger('acheteur'), async (req, res) => {
  const { code, nom, type, site_web } = req.body || {};
  if (!code || !nom) return res.status(400).json({ erreur: 'Code et nom requis' });
  await query(
    `INSERT INTO enseignes_concurrentes (code, nom, type, site_web) VALUES ($1,$2,$3,$4)
     ON CONFLICT (code) DO UPDATE SET nom=$2, type=$3, site_web=$4`,
    [code.toUpperCase(), nom, type || null, site_web || null]);
  res.json({ ok: true });
});

/* ---------------- Relevés ---------------- */
async function apparier(codeBarres) {
  const { rows } = await query(
    `SELECT code_interne FROM articles WHERE code_barres=$1
     UNION SELECT article_code FROM codes_barres_secondaires WHERE code_barres=$1 LIMIT 1`, [codeBarres]);
  return rows.length ? rows[0].code_interne : null;
}

r.get('/releves', async (req, res) => {
  const { article, enseigne, non_apparies } = req.query;
  const params = [];
  let sql = `SELECT rc.*, a.libelle AS article_libelle, e.nom AS enseigne_nom
             FROM releves_concurrents rc
             LEFT JOIN articles a ON a.code_interne=rc.article_code
             LEFT JOIN enseignes_concurrentes e ON e.code=rc.enseigne_code WHERE 1=1`;
  if (article) { params.push(article); sql += ` AND rc.article_code=$${params.length}`; }
  if (enseigne) { params.push(enseigne); sql += ` AND rc.enseigne_code=$${params.length}`; }
  if (non_apparies === '1') sql += ' AND rc.article_code IS NULL';
  sql += ' ORDER BY rc.date_releve DESC, rc.id DESC LIMIT 500';
  const { rows } = await query(sql, params);
  res.json(rows);
});

r.post('/releves', exiger('enqueteur'), async (req, res) => {
  const d = req.body || {};
  if (!d.code_barres || num(d.prix_ttc) === null) return res.status(400).json({ erreur: 'Code barres et prix requis' });
  // Détection de saisie aberrante (F-M7-07) : écart de plus de 5x avec la médiane des relevés récents
  const { rows: recents } = await query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY prix_ttc) AS mediane
       FROM releves_concurrents WHERE code_barres=$1 AND date_releve > CURRENT_DATE - 180`, [d.code_barres]);
  const mediane = recents.length ? Number(recents[0].mediane) : null;
  const prix = num(d.prix_ttc);
  if (mediane && (prix > mediane * 5 || prix < mediane / 5) && !d.confirmer_aberrant) {
    return res.status(409).json({
      erreur: `Prix suspect : la médiane des relevés récents est de ${round(mediane, 0)}. Renvoyer avec confirmer_aberrant=true pour forcer.`,
      mediane: round(mediane, 0)
    });
  }
  const articleCode = await apparier(d.code_barres);
  await query(
    `INSERT INTO releves_concurrents (code_barres, article_code, enseigne_code, point_de_releve, date_releve,
       prix_ttc, type_prix, disponibilite, conditionnement, source, justificatif, auteur)
     VALUES ($1,$2,$3,$4,COALESCE($5::date,CURRENT_DATE),$6,COALESCE($7,'fond_de_rayon'),$8,$9,COALESCE($10,'terrain'),$11,$12)`,
    [d.code_barres, articleCode, d.enseigne_code || null, d.point_de_releve || null, d.date_releve || null,
      prix, d.type_prix, d.disponibilite || null, d.conditionnement || null, d.source, d.justificatif || null,
      req.utilisateur.email]);
  res.json({ ok: true, apparie: !!articleCode, article_code: articleCode });
});

/* Appariement manuel d'un relevé (file de validation, F-M7-12) */
r.post('/releves/:id/apparier', exiger('acheteur'), async (req, res) => {
  const { article_code } = req.body || {};
  if (!article_code) return res.status(400).json({ erreur: 'Code article requis' });
  const { rows } = await query('SELECT code_barres FROM releves_concurrents WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ erreur: 'Relevé introuvable' });
  await query('UPDATE releves_concurrents SET article_code=$1 WHERE id=$2', [article_code, req.params.id]);
  // L'appariement validé est conservé pour les collectes suivantes (F-M7-13)
  await query(
    `INSERT INTO codes_barres_secondaires (code_barres, article_code, description)
     VALUES ($1,$2,'appariement veille') ON CONFLICT (code_barres) DO NOTHING`,
    [rows[0].code_barres, article_code]);
  await query('UPDATE releves_concurrents SET article_code=$1 WHERE code_barres=$2 AND article_code IS NULL',
    [article_code, rows[0].code_barres]);
  await auditer(req, 'appariement', 'releve', req.params.id, article_code);
  res.json({ ok: true });
});

/* Import au format Annexe C (F-M7-15) :
   code_barres;enseigne;point_de_releve;date_releve;prix_ttc;type_prix;disponibilite;conditionnement;source;justificatif */
r.post('/releves-import/csv', exiger('acheteur'), async (req, res) => {
  const { contenu } = req.body || {};
  if (!contenu) return res.status(400).json({ erreur: 'Contenu CSV requis' });
  const { records } = parseCsv(contenu);
  let importes = 0, apparies = 0; const rejets = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const prix = num(rec.prix_ttc);
    if (!rec.code_barres || prix === null) { rejets.push({ ligne: i + 2, motif: 'code_barres ou prix_ttc manquant' }); continue; }
    if (rec.enseigne) {
      await query(`INSERT INTO enseignes_concurrentes (code, nom) VALUES ($1,$1) ON CONFLICT DO NOTHING`,
        [rec.enseigne.toUpperCase()]);
    }
    const articleCode = await apparier(rec.code_barres);
    if (articleCode) apparies++;
    await query(
      `INSERT INTO releves_concurrents (code_barres, article_code, enseigne_code, point_de_releve, date_releve,
         prix_ttc, type_prix, disponibilite, conditionnement, source, justificatif, auteur)
       VALUES ($1,$2,$3,$4,COALESCE($5::date,CURRENT_DATE),$6,COALESCE(NULLIF($7,''),'fond_de_rayon'),$8,$9,
         COALESCE(NULLIF($10,''),'panel'),$11,$12)`,
      [rec.code_barres, articleCode, rec.enseigne ? rec.enseigne.toUpperCase() : null, rec.point_de_releve || null,
        rec.date_releve || null, prix, rec.type_prix, rec.disponibilite || null, rec.conditionnement || null,
        rec.source, rec.justificatif || null, req.utilisateur.email]);
    importes++;
  }
  await auditer(req, 'import', 'releves', null, `${importes} relevés, ${apparies} appariés`);
  res.json({ importes, apparies, non_apparies: importes - apparies, rejets });
});

/* Indices de prix (F-M7-18/19/20) : notre prix publié vs dernier relevé concurrent. */
r.get('/indices', async (req, res) => {
  const { format } = req.query;
  const fmt = format || 'SUP';
  const { rows } = await query(
    `WITH derniers_releves AS (
       SELECT DISTINCT ON (article_code, enseigne_code) article_code, enseigne_code, prix_ttc, date_releve
         FROM releves_concurrents
        WHERE article_code IS NOT NULL AND type_prix='fond_de_rayon'
        ORDER BY article_code, enseigne_code, date_releve DESC
     ), nos_prix AS (
       SELECT DISTINCT ON (article_code) article_code, prix_ttc
         FROM tarifs WHERE statut='publie' AND format_code=$1
        ORDER BY article_code, date_effet DESC
     )
     SELECT a.code_interne, a.libelle, a.famille_code, np.prix_ttc AS notre_prix,
            dr.enseigne_code, e.nom AS enseigne_nom, dr.prix_ttc AS prix_concurrent, dr.date_releve,
            (CURRENT_DATE - dr.date_releve) AS age_jours,
            ROUND(np.prix_ttc / NULLIF(dr.prix_ttc,0) * 100, 1) AS indice
       FROM nos_prix np
       JOIN articles a ON a.code_interne=np.article_code
       JOIN derniers_releves dr ON dr.article_code=np.article_code
       LEFT JOIN enseignes_concurrentes e ON e.code=dr.enseigne_code
      ORDER BY a.code_interne, dr.enseigne_code`, [fmt]);
  // Pondération par le poids de chaque référence dans le chiffre d'affaires (F-M7-23)
  const { rows: ca } = await query(
    `SELECT article_code, SUM(ca_ttc) AS ca FROM ventes
      WHERE date_vente > CURRENT_DATE - 90 GROUP BY article_code`);
  const caParArticle = new Map(ca.map(x => [x.article_code, Number(x.ca)]));
  const parEnseigne = {};
  for (const x of rows) {
    const k = x.enseigne_code || '?';
    const e = parEnseigne[k] = parEnseigne[k] || { enseigne: x.enseigne_nom || k, indices: [], sommePonderee: 0, poids: 0 };
    e.indices.push(Number(x.indice));
    const p = caParArticle.get(x.code_interne) || 0;
    e.sommePonderee += Number(x.indice) * p;
    e.poids += p;
  }
  const syntheses = Object.entries(parEnseigne).map(([code, v]) => ({
    enseigne_code: code, enseigne: v.enseigne, nb_references: v.indices.length,
    indice_moyen: round(v.indices.reduce((s, i) => s + i, 0) / v.indices.length, 1),
    indice_pondere_ca: v.poids > 0 ? round(v.sommePonderee / v.poids, 1) : null
  }));
  res.json({ format: fmt, details: rows, syntheses });
});

/* Alertes d'écart concurrentiel (F-M7-21) */
r.get('/alertes', async (req, res) => {
  const seuil = num(req.query.seuil) || 10;
  const { rows } = await query(
    `WITH derniers AS (
       SELECT DISTINCT ON (article_code) article_code, prix_ttc, enseigne_code, date_releve
         FROM releves_concurrents WHERE article_code IS NOT NULL AND type_prix='fond_de_rayon'
        ORDER BY article_code, date_releve DESC
     ), nos_prix AS (
       SELECT DISTINCT ON (article_code, format_code) article_code, format_code, prix_ttc
         FROM tarifs WHERE statut='publie' ORDER BY article_code, format_code, date_effet DESC
     )
     SELECT np.article_code, a.libelle, a.sensibilite_prix, np.format_code, np.prix_ttc AS notre_prix,
            d.prix_ttc AS prix_concurrent, d.enseigne_code, d.date_releve,
            ROUND((np.prix_ttc - d.prix_ttc) / NULLIF(d.prix_ttc,0) * 100, 1) AS ecart_pct
       FROM nos_prix np
       JOIN derniers d ON d.article_code=np.article_code
       JOIN articles a ON a.code_interne=np.article_code
      WHERE ABS((np.prix_ttc - d.prix_ttc) / NULLIF(d.prix_ttc,0) * 100) > $1
      ORDER BY ABS((np.prix_ttc - d.prix_ttc) / NULLIF(d.prix_ttc,0)) DESC LIMIT 200`, [seuil]);
  res.json(rows);
});

r.get('/releves-export/csv', async (req, res) => {
  const { rows } = await query(
    `SELECT code_barres, enseigne_code AS enseigne, point_de_releve, date_releve, prix_ttc,
            type_prix, disponibilite, conditionnement, source, justificatif
       FROM releves_concurrents ORDER BY date_releve DESC LIMIT 5000`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="releves_concurrents.csv"');
  res.send('﻿' + toCsv(rows.map(x => ({
    ...x, date_releve: x.date_releve ? new Date(x.date_releve).toISOString().slice(0, 10) : ''
  }))));
});

module.exports = r;
