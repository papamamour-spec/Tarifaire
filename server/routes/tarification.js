'use strict';
/* Modules M6 (politique tarifaire multi-formats) et M8 (moteur de prix). */
const express = require('express');
const { query } = require('../db');
const { exiger, auditer } = require('../auth');
const { num, toCsv, round } = require('../util');
const { proposerPrix } = require('../services/prix');

const r = express.Router();

/* ---------------- Formats de magasin ---------------- */
r.get('/formats', async (req, res) => {
  const { rows } = await query('SELECT * FROM formats_magasin ORDER BY code');
  res.json(rows);
});

r.post('/formats', exiger('controle'), async (req, res) => {
  const f = req.body || {};
  if (!f.code || !f.libelle) return res.status(400).json({ erreur: 'Code et libellé requis' });
  await query(
    `INSERT INTO formats_magasin (code, libelle, logistique_aval_mode, logistique_aval_valeur, demarque_taux,
       taux_financement, rotation_jours, arrondi_regle, arrondi_pas, terminaison)
     VALUES ($1,$2,COALESCE($3,'pct_valeur'),COALESCE($4,0),COALESCE($5,0),COALESCE($6,0),COALESCE($7,30),
       COALESCE($8,'plus_proche'),COALESCE($9,5),$10)
     ON CONFLICT (code) DO UPDATE SET libelle=$2, logistique_aval_mode=COALESCE($3,'pct_valeur'),
       logistique_aval_valeur=COALESCE($4,0), demarque_taux=COALESCE($5,0), taux_financement=COALESCE($6,0),
       rotation_jours=COALESCE($7,30), arrondi_regle=COALESCE($8,'plus_proche'), arrondi_pas=COALESCE($9,5), terminaison=$10`,
    [f.code.toUpperCase(), f.libelle, f.logistique_aval_mode, num(f.logistique_aval_valeur), num(f.demarque_taux),
      num(f.taux_financement), num(f.rotation_jours), f.arrondi_regle, num(f.arrondi_pas), f.terminaison || null]);
  await auditer(req, 'enregistrement', 'format_magasin', f.code);
  res.json({ ok: true });
});

/* ---------------- Points de vente ---------------- */
r.get('/points-de-vente', async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, f.libelle AS format_libelle FROM points_de_vente p
     LEFT JOIN formats_magasin f ON f.code=p.format_code ORDER BY p.code`);
  res.json(rows);
});

r.post('/points-de-vente', exiger('controle'), async (req, res) => {
  const p = req.body || {};
  if (!p.code || !p.nom) return res.status(400).json({ erreur: 'Code et nom requis' });
  await query(
    `INSERT INTO points_de_vente (code, nom, format_code, zone_prix, ville)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (code) DO UPDATE SET nom=$2, format_code=$3, zone_prix=$4, ville=$5`,
    [p.code.toUpperCase(), p.nom, p.format_code || null, p.zone_prix || null, p.ville || null]);
  res.json({ ok: true });
});

/* ---------------- Politiques tarifaires (§9.2) ---------------- */
r.get('/politiques', async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, fa.libelle AS famille_libelle, fo.libelle AS format_libelle
       FROM politiques_tarifaires p
       LEFT JOIN familles fa ON fa.code=p.famille_code
       LEFT JOIN formats_magasin fo ON fo.code=p.format_code
      ORDER BY COALESCE(p.famille_code,''), COALESCE(p.format_code,'')`);
  res.json(rows);
});

r.post('/politiques', exiger('controle'), async (req, res) => {
  const p = req.body || {};
  if (num(p.taux_marque_cible) === null) return res.status(400).json({ erreur: 'Taux de marque cible requis' });
  const modes = ['marge', 'marche', 'encadre', 'alignement', 'manuel'];
  if (p.mode_arbitrage && !modes.includes(p.mode_arbitrage)) {
    return res.status(400).json({ erreur: `Mode d'arbitrage invalide. Attendu : ${modes.join(', ')}` });
  }
  await query(
    `INSERT INTO politiques_tarifaires (famille_code, format_code, taux_marque_cible, taux_marque_plancher,
       mode_arbitrage, indice_cible, encadrement_pct)
     VALUES ($1,$2,$3,COALESCE($4,0),COALESCE($5,'marge'),$6,$7)
     ON CONFLICT (famille_code, format_code) DO UPDATE SET taux_marque_cible=$3,
       taux_marque_plancher=COALESCE($4,0), mode_arbitrage=COALESCE($5,'marge'), indice_cible=$6, encadrement_pct=$7`,
    [p.famille_code || null, p.format_code || null, num(p.taux_marque_cible), num(p.taux_marque_plancher),
      p.mode_arbitrage, num(p.indice_cible), num(p.encadrement_pct)]);
  await auditer(req, 'enregistrement', 'politique_tarifaire', `${p.famille_code || '*'}/${p.format_code || '*'}`);
  res.json({ ok: true });
});

r.delete('/politiques/:id', exiger('controle'), async (req, res) => {
  await query('DELETE FROM politiques_tarifaires WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

/* ---------------- Propositions de prix (F-M8-01) ---------------- */
async function chargerFormat(code) {
  const { rows } = await query('SELECT * FROM formats_magasin WHERE code=$1', [code]);
  return rows[0] || null;
}

r.post('/proposer', exiger('acheteur'), async (req, res) => {
  const { article_code, famille_code, format_codes } = req.body || {};
  let formats;
  if (Array.isArray(format_codes) && format_codes.length) {
    formats = [];
    for (const fc of format_codes) {
      const f = await chargerFormat(fc);
      if (f) formats.push(f);
    }
  } else {
    formats = (await query('SELECT * FROM formats_magasin ORDER BY code')).rows;
  }
  if (!formats.length) return res.status(400).json({ erreur: 'Aucun format de magasin défini' });

  const params = [];
  let sql = `SELECT a.*, f.demarque_taux AS famille_demarque FROM articles a
             LEFT JOIN familles f ON f.code=a.famille_code
             WHERE a.statut='actif'`;
  if (article_code) { params.push(article_code); sql += ` AND a.code_interne=$${params.length}`; }
  if (famille_code) { params.push(famille_code); sql += ` AND a.famille_code=$${params.length}`; }
  sql += ' ORDER BY a.code_interne LIMIT 1000';
  const { rows: articles } = await query(sql, params);
  if (!articles.length) return res.status(404).json({ erreur: 'Aucun article actif dans le périmètre choisi' });

  const propositions = [];
  for (const a of articles) {
    for (const f of formats) {
      propositions.push(await proposerPrix(a, f, a.famille_demarque));
    }
  }
  const exploitables = propositions.filter(p => !p.erreur);
  const sansCout = propositions.length - exploitables.length;
  res.json({ propositions: exploitables, ignores_sans_cout: sansCout });
});

/* Enregistrement des propositions retenues comme tarifs proposés (F-M8-03/04) */
r.post('/tarifs', exiger('acheteur'), async (req, res) => {
  const { tarifs } = req.body || {};
  if (!Array.isArray(tarifs) || !tarifs.length) return res.status(400).json({ erreur: 'Tableau de tarifs requis' });
  let crees = 0;
  for (const t of tarifs) {
    if (!t.article_code || !t.format_code || num(t.prix_ttc) === null) continue;
    const { rows: aRows } = await query('SELECT taux_tva_vente FROM articles WHERE code_interne=$1', [t.article_code]);
    if (!aRows.length) continue;
    const tva = Number(aRows[0].taux_tva_vente) || 0;
    const ht = round(num(t.prix_ttc) / (1 + tva / 100), 2);
    await query(
      `INSERT INTO tarifs (article_code, format_code, prix_ttc, prix_ht, cout_mise_en_rayon, taux_marque,
         contrainte, statut, justification, auteur, date_effet, alerte)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'propose',$8,$9,COALESCE($10::date,CURRENT_DATE),$11)`,
      [t.article_code, t.format_code, num(t.prix_ttc), ht, num(t.cout_mise_en_rayon), num(t.taux_marque),
        t.contrainte || null, t.justification || null, req.utilisateur.email, t.date_effet || null,
        Array.isArray(t.alertes) && t.alertes.length ? t.alertes.join(' ; ') : null]);
    crees++;
  }
  await auditer(req, 'proposition_tarifs', 'tarifs', null, `${crees} propositions`);
  res.json({ ok: true, crees });
});

r.get('/tarifs', async (req, res) => {
  const { statut, format, article } = req.query;
  const params = [];
  let sql = `SELECT t.*, a.libelle AS article_libelle, a.code_barres FROM tarifs t
             JOIN articles a ON a.code_interne=t.article_code WHERE 1=1`;
  if (statut) { params.push(statut); sql += ` AND t.statut=$${params.length}`; }
  if (format) { params.push(format); sql += ` AND t.format_code=$${params.length}`; }
  if (article) { params.push(article); sql += ` AND t.article_code=$${params.length}`; }
  sql += ' ORDER BY t.cree_le DESC LIMIT 500';
  const { rows } = await query(sql, params);
  res.json(rows);
});

/* Validation / refus / publication (F-M8-04 à F-M8-07) */
r.post('/tarifs/:id/statut', exiger('direction'), async (req, res) => {
  const { statut, justification } = req.body || {};
  const valides = ['propose', 'valide', 'refuse', 'publie', 'annule'];
  if (!valides.includes(statut)) return res.status(400).json({ erreur: `Statut invalide. Attendu : ${valides.join(', ')}` });
  const { rows } = await query('SELECT * FROM tarifs WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ erreur: 'Tarif introuvable' });
  if (statut === 'publie') {
    // La publication clôt le tarif publié précédent du même article et format (F-M8-07)
    await query(
      `UPDATE tarifs SET date_fin=CURRENT_DATE, statut='remplace'
        WHERE article_code=$1 AND format_code=$2 AND statut='publie' AND id<>$3`,
      [rows[0].article_code, rows[0].format_code, req.params.id]);
  }
  await query('UPDATE tarifs SET statut=$1, justification=COALESCE($2, justification) WHERE id=$3',
    [statut, justification || null, req.params.id]);
  await auditer(req, `tarif_${statut}`, 'tarif', req.params.id, justification);
  res.json({ ok: true });
});

r.post('/tarifs-publier-lot', exiger('direction'), async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ erreur: 'Liste d’identifiants requise' });
  let publies = 0;
  for (const id of ids) {
    const { rows } = await query(`SELECT * FROM tarifs WHERE id=$1 AND statut IN ('propose','valide')`, [id]);
    if (!rows.length) continue;
    await query(
      `UPDATE tarifs SET date_fin=CURRENT_DATE, statut='remplace'
        WHERE article_code=$1 AND format_code=$2 AND statut='publie' AND id<>$3`,
      [rows[0].article_code, rows[0].format_code, id]);
    await query(`UPDATE tarifs SET statut='publie' WHERE id=$1`, [id]);
    publies++;
  }
  await auditer(req, 'publication_lot', 'tarifs', null, `${publies} tarifs publiés`);
  res.json({ ok: true, publies });
});

/* Export des tarifs publiés vers l'ERP ou la caisse (FS03, UC08) */
r.get('/tarifs-export/csv', async (req, res) => {
  const { rows } = await query(
    `SELECT t.article_code, a.code_barres, a.libelle, t.format_code, t.prix_ttc, t.prix_ht,
            a.taux_tva_vente, t.date_effet, t.date_fin
       FROM tarifs t JOIN articles a ON a.code_interne=t.article_code
      WHERE t.statut='publie' ORDER BY t.article_code, t.format_code`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tarifs_publies.csv"');
  res.send('﻿' + toCsv(rows.map(x => ({
    code_interne: x.article_code, code_barres: x.code_barres, libelle: x.libelle, format: x.format_code,
    prix_ttc: x.prix_ttc, prix_ht: x.prix_ht, taux_tva: x.taux_tva_vente,
    date_effet: x.date_effet ? new Date(x.date_effet).toISOString().slice(0, 10) : '',
    date_fin: x.date_fin ? new Date(x.date_fin).toISOString().slice(0, 10) : ''
  }))));
});

module.exports = r;
