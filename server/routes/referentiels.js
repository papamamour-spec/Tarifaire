'use strict';
/* Module M1 (référentiel article), familles, fournisseurs et conditions d'achat (M3). */
const express = require('express');
const { query } = require('../db');
const { exiger, auditer } = require('../auth');
const { parseCsv, toCsv, num, round, validerEan } = require('../util');

const r = express.Router();

/* ------------------------- Familles ------------------------- */
r.get('/familles', async (req, res) => {
  const { rows } = await query('SELECT * FROM familles ORDER BY code');
  res.json(rows);
});

r.post('/familles', exiger('controle'), async (req, res) => {
  const { code, libelle, parent_code, niveau, marge_cible, demarque_taux } = req.body;
  if (!code || !libelle) return res.status(400).json({ erreur: 'Code et libellé requis' });
  await query(
    `INSERT INTO familles (code, libelle, parent_code, niveau, marge_cible, demarque_taux)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO UPDATE SET libelle=$2, parent_code=$3, niveau=$4, marge_cible=$5, demarque_taux=$6`,
    [code.toUpperCase(), libelle, parent_code || null, num(niveau) || 1, num(marge_cible), num(demarque_taux)]);
  await auditer(req, 'enregistrement', 'famille', code);
  res.json({ ok: true });
});

/* ------------------------- Fournisseurs ------------------------- */
r.get('/fournisseurs', async (req, res) => {
  const { rows } = await query('SELECT * FROM fournisseurs ORDER BY code');
  res.json(rows);
});

r.post('/fournisseurs', exiger('acheteur'), async (req, res) => {
  const { code, nom, pays, devise, incoterm_defaut, contact, actif } = req.body;
  if (!code || !nom) return res.status(400).json({ erreur: 'Code et nom requis' });
  await query(
    `INSERT INTO fournisseurs (code, nom, pays, devise, incoterm_defaut, contact, actif)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,TRUE))
     ON CONFLICT (code) DO UPDATE SET nom=$2, pays=$3, devise=$4, incoterm_defaut=$5, contact=$6, actif=COALESCE($7,TRUE)`,
    [code.toUpperCase(), nom, pays || null, devise || 'XOF', incoterm_defaut || null, contact || null, actif]);
  await auditer(req, 'enregistrement', 'fournisseur', code);
  res.json({ ok: true });
});

/* ------------------------- Conditions d'achat ------------------------- */
r.get('/conditions-achat', async (req, res) => {
  const { article } = req.query;
  const { rows } = await query(
    `SELECT ca.*, f.nom AS fournisseur_nom FROM conditions_achat ca
       JOIN fournisseurs f ON f.code = ca.fournisseur_code
      WHERE ($1::text IS NULL OR ca.article_code=$1)
      ORDER BY ca.article_code, ca.date_effet DESC`, [article || null]);
  res.json(rows);
});

r.post('/conditions-achat', exiger('acheteur'), async (req, res) => {
  const { fournisseur_code, article_code, prix_achat, devise, remise_pct, incoterm, date_effet, date_fin } = req.body;
  if (!fournisseur_code || !article_code || num(prix_achat) === null) {
    return res.status(400).json({ erreur: 'Fournisseur, article et prix requis' });
  }
  await query(
    `INSERT INTO conditions_achat (fournisseur_code, article_code, prix_achat, devise, remise_pct, incoterm, date_effet, date_fin)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date,CURRENT_DATE),$8)`,
    [fournisseur_code, article_code, num(prix_achat), devise || 'XOF', num(remise_pct) || 0,
      incoterm || null, date_effet || null, date_fin || null]);
  await auditer(req, 'enregistrement', 'condition_achat', article_code);
  res.json({ ok: true });
});

/* ------------------------- Articles ------------------------- */
const CHAMPS_ARTICLE = ['code_barres', 'libelle', 'libelle_court', 'famille_code', 'marque', 'type_marque', 'statut',
  'fournisseur_code', 'reference_fournisseur', 'unites_par_carton', 'poids_net_unitaire', 'poids_brut_carton',
  'longueur_carton', 'largeur_carton', 'hauteur_carton', 'volume_carton', 'position_tarifaire', 'origine',
  'taux_tva_vente', 'marge_cible', 'role_assortiment', 'sensibilite_prix', 'mode_arbitrage'];
const CHAMPS_NUM = new Set(['unites_par_carton', 'poids_net_unitaire', 'poids_brut_carton', 'longueur_carton',
  'largeur_carton', 'hauteur_carton', 'volume_carton', 'taux_tva_vente', 'marge_cible']);

function calculerVolume(a) {
  // Volume calculé depuis les dimensions si absent (F-M1-02)
  if ((a.volume_carton === null || a.volume_carton === undefined) &&
      a.longueur_carton && a.largeur_carton && a.hauteur_carton) {
    a.volume_carton = round(Number(a.longueur_carton) * Number(a.largeur_carton) * Number(a.hauteur_carton) / 1e6, 5);
  }
}

function enrichir(a) {
  // Densité et unité payante par carton (F-M1-03)
  const densite = a.poids_brut_carton && a.volume_carton && Number(a.volume_carton) > 0
    ? round(Number(a.poids_brut_carton) / Number(a.volume_carton), 1) : null;
  let indicateur = null;
  if (densite !== null) indicateur = densite >= 1000 ? 'poids' : 'volume';
  const manquants = [];
  if (!a.code_barres) manquants.push('code_barres');
  if (!a.unites_par_carton) manquants.push('unites_par_carton');
  if (!a.poids_brut_carton) manquants.push('poids_brut_carton');
  if (!a.volume_carton) manquants.push('volume_carton');
  if (!a.position_tarifaire) manquants.push('position_tarifaire');
  if (!a.origine) manquants.push('origine');
  return { ...a, densite, indicateur_up: indicateur, donnees_manquantes: manquants, complet: manquants.length === 0 };
}

r.get('/articles', async (req, res) => {
  const { q, famille, statut, incomplets, page, taille } = req.query;
  const params = [];
  let filtre = ' WHERE 1=1';
  if (q) {
    params.push('%' + q.toLowerCase() + '%');
    filtre += ` AND (lower(a.code_interne) LIKE $${params.length} OR lower(a.libelle) LIKE $${params.length}
             OR a.code_barres LIKE $${params.length} OR lower(a.reference_fournisseur) LIKE $${params.length}
             OR a.position_tarifaire LIKE $${params.length})`;
  }
  if (famille) { params.push(famille); filtre += ` AND a.famille_code=$${params.length}`; }
  if (statut) { params.push(statut); filtre += ` AND a.statut=$${params.length}`; }
  if (incomplets === '1') {
    filtre += ` AND (a.code_barres IS NULL OR a.unites_par_carton IS NULL OR a.poids_brut_carton IS NULL
                OR a.volume_carton IS NULL OR a.position_tarifaire IS NULL OR a.origine IS NULL)`;
  }
  const base = `FROM articles a LEFT JOIN familles f ON f.code = a.famille_code${filtre}`;

  // Mode paginé (F-M9 volumétrie) : ?page=1&taille=50 retourne { total, page, articles }
  if (page) {
    const t = Math.min(Math.max(parseInt(taille, 10) || 50, 10), 200);
    const p = Math.max(parseInt(page, 10) || 1, 1);
    const { rows: cRows } = await query(`SELECT COUNT(*)::int AS n ${base}`, params);
    const { rows } = await query(
      `SELECT a.*, f.libelle AS famille_libelle ${base} ORDER BY a.code_interne LIMIT ${t} OFFSET ${(p - 1) * t}`, params);
    return res.json({ total: cRows[0].n, page: p, taille: t, articles: rows.map(enrichir) });
  }

  const { rows } = await query(`SELECT a.*, f.libelle AS famille_libelle ${base} ORDER BY a.code_interne LIMIT 500`, params);
  res.json(rows.map(enrichir));
});

r.get('/articles/:code', async (req, res) => {
  const { rows } = await query('SELECT * FROM articles WHERE code_interne=$1', [req.params.code]);
  if (!rows.length) return res.status(404).json({ erreur: 'Article introuvable' });
  const article = enrichir(rows[0]);
  const [cb, hist, cond] = await Promise.all([
    query('SELECT * FROM codes_barres_secondaires WHERE article_code=$1', [req.params.code]),
    query('SELECT * FROM historique_articles WHERE article_code=$1 ORDER BY date_modif DESC LIMIT 50', [req.params.code]),
    query(`SELECT ca.*, f.nom AS fournisseur_nom FROM conditions_achat ca
             JOIN fournisseurs f ON f.code=ca.fournisseur_code
            WHERE ca.article_code=$1 ORDER BY ca.date_effet DESC`, [req.params.code])
  ]);
  res.json({ ...article, codes_barres_secondaires: cb.rows, historique: hist.rows, conditions_achat: cond.rows });
});

async function upsertArticle(req, code, donnees, source) {
  const { rows: avant } = await query('SELECT * FROM articles WHERE code_interne=$1', [code]);
  calculerVolume(donnees);
  if (avant.length) {
    const sets = [], params = [];
    for (const c of CHAMPS_ARTICLE) {
      if (donnees[c] === undefined) continue;
      params.push(donnees[c] === '' ? null : donnees[c]);
      sets.push(`${c}=$${params.length}`);
      const ancienne = avant[0][c], nouvelle = donnees[c] === '' ? null : donnees[c];
      if (String(ancienne ?? '') !== String(nouvelle ?? '')) {
        await query(
          `INSERT INTO historique_articles (article_code, champ, ancienne_valeur, nouvelle_valeur, source, auteur)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [code, c, ancienne === null ? null : String(ancienne), nouvelle === null ? null : String(nouvelle),
            source, req.utilisateur ? req.utilisateur.email : 'système']);
      }
    }
    if (sets.length) {
      params.push(code);
      await query(`UPDATE articles SET ${sets.join(', ')}, modifie_le=now() WHERE code_interne=$${params.length}`, params);
    }
    return 'modifie';
  }
  const cols = ['code_interne'], vals = [code];
  for (const c of CHAMPS_ARTICLE) {
    if (donnees[c] !== undefined && donnees[c] !== '') { cols.push(c); vals.push(donnees[c]); }
  }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  await query(`INSERT INTO articles (${cols.join(',')}) VALUES (${ph})`, vals);
  return 'cree';
}

r.post('/articles', exiger('acheteur'), async (req, res) => {
  const d = { ...req.body };
  const code = (d.code_interne || '').trim();
  if (!code || !d.libelle) return res.status(400).json({ erreur: 'Code interne et libellé requis' });
  for (const c of CHAMPS_NUM) if (d[c] !== undefined && d[c] !== '' && d[c] !== null) d[c] = num(d[c]);
  if (d.code_barres && !validerEan(d.code_barres)) {
    if (req.query.forcer !== '1') return res.status(400).json({ erreur: 'Code barres invalide (clé EAN/UPC incorrecte). Ajouter ?forcer=1 pour passer outre.' });
  }
  if (d.code_barres) {
    const { rows: doublons } = await query(
      'SELECT code_interne FROM articles WHERE code_barres=$1 AND code_interne<>$2', [d.code_barres, code]);
    if (doublons.length) return res.status(409).json({ erreur: `Code barres déjà porté par ${doublons[0].code_interne}` });
  }
  const action = await upsertArticle(req, code, d, 'saisie');
  await auditer(req, action, 'article', code);
  res.json({ ok: true, action });
});

/* Export du référentiel au format Annexe B (F-M1-10) */
r.get('/articles-export/csv', async (req, res) => {
  const { rows } = await query('SELECT * FROM articles ORDER BY code_interne');
  const data = rows.map(a => ({
    code_interne: a.code_interne, code_barres: a.code_barres, libelle: a.libelle,
    famille: a.famille_code, fournisseur: a.fournisseur_code, reference_fournisseur: a.reference_fournisseur,
    unites_par_carton: a.unites_par_carton, poids_net_unitaire: a.poids_net_unitaire,
    poids_brut_carton: a.poids_brut_carton, longueur_carton: a.longueur_carton,
    largeur_carton: a.largeur_carton, hauteur_carton: a.hauteur_carton, volume_carton: a.volume_carton,
    position_tarifaire: a.position_tarifaire, origine: a.origine, taux_tva_vente: a.taux_tva_vente, statut: a.statut
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="referentiel_articles.csv"');
  res.send('﻿' + toCsv(data));
});

/* Import du référentiel au format Annexe B, avec prévisualisation (F-M10-05) */
r.post('/articles-import/csv', exiger('acheteur'), async (req, res) => {
  const { contenu, confirmer } = req.body || {};
  if (!contenu) return res.status(400).json({ erreur: 'Contenu CSV requis' });
  const { records } = parseCsv(contenu);
  const rapport = { total: records.length, crees: 0, modifies: 0, rejets: [] };
  const valides = [];
  records.forEach((rec, i) => {
    const ligne = i + 2;
    const code = (rec.code_interne || '').trim();
    if (!code) { rapport.rejets.push({ ligne, motif: 'code_interne manquant' }); return; }
    if (!rec.libelle) { rapport.rejets.push({ ligne, motif: 'libelle manquant' }); return; }
    if (rec.code_barres && !validerEan(rec.code_barres)) {
      rapport.rejets.push({ ligne, motif: `code_barres invalide : ${rec.code_barres}` }); return;
    }
    const d = {
      code_barres: rec.code_barres || undefined, libelle: rec.libelle,
      famille_code: rec.famille ? rec.famille.toUpperCase() : undefined,
      fournisseur_code: rec.fournisseur ? rec.fournisseur.toUpperCase() : undefined,
      reference_fournisseur: rec.reference_fournisseur || undefined,
      unites_par_carton: num(rec.unites_par_carton), poids_net_unitaire: num(rec.poids_net_unitaire),
      poids_brut_carton: num(rec.poids_brut_carton), longueur_carton: num(rec.longueur_carton),
      largeur_carton: num(rec.largeur_carton), hauteur_carton: num(rec.hauteur_carton),
      volume_carton: num(rec.volume_carton), position_tarifaire: rec.position_tarifaire || undefined,
      origine: rec.origine ? rec.origine.toUpperCase() : undefined,
      taux_tva_vente: num(rec.taux_tva_vente) ?? undefined, statut: rec.statut || undefined
    };
    valides.push({ code, d });
  });
  if (!confirmer) return res.json({ previsualisation: true, ...rapport, importables: valides.length });
  for (const { code, d } of valides) {
    // Les familles et fournisseurs inconnus sont créés à la volée pour ne pas bloquer l'import
    if (d.famille_code) {
      await query(`INSERT INTO familles (code, libelle) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [d.famille_code]);
    }
    if (d.fournisseur_code) {
      await query(`INSERT INTO fournisseurs (code, nom) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [d.fournisseur_code]);
    }
    const action = await upsertArticle(req, code, d, 'import');
    if (action === 'cree') rapport.crees++; else rapport.modifies++;
  }
  await auditer(req, 'import', 'articles', null, `${rapport.crees} créés, ${rapport.modifies} modifiés, ${rapport.rejets.length} rejets`);
  res.json({ previsualisation: false, ...rapport });
});

/* Détection de doublons de codes barres (F-M1-11) */
r.get('/articles-doublons', async (req, res) => {
  const { rows } = await query(
    `SELECT code_barres, array_agg(code_interne) AS articles
       FROM articles WHERE code_barres IS NOT NULL
      GROUP BY code_barres HAVING COUNT(*) > 1`);
  res.json(rows);
});

module.exports = r;
