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
  const { rows: fRows } = await query('SELECT code FROM fournisseurs WHERE code=$1', [fournisseur_code]);
  if (!fRows.length) return res.status(404).json({ erreur: `Fournisseur ${fournisseur_code} inconnu : créez-le d'abord` });
  await query(
    `INSERT INTO conditions_achat (fournisseur_code, article_code, prix_achat, devise, remise_pct, incoterm, date_effet, date_fin)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date,CURRENT_DATE),$8)`,
    [fournisseur_code, article_code, num(prix_achat), devise || 'XOF', num(remise_pct) || 0,
      incoterm || null, date_effet || null, date_fin || null]);
  // Premier fournisseur rattaché à l'article : il devient le principal par défaut (F-M1-08)
  await query(
    `UPDATE articles SET fournisseur_code=$1, modifie_le=now()
      WHERE code_interne=$2 AND fournisseur_code IS NULL`, [fournisseur_code, article_code]);
  await auditer(req, 'enregistrement', 'condition_achat', article_code, fournisseur_code);
  res.json({ ok: true });
});

r.delete('/conditions-achat/:id', exiger('acheteur'), async (req, res) => {
  await query('DELETE FROM conditions_achat WHERE id=$1', [req.params.id]);
  await auditer(req, 'suppression', 'condition_achat', req.params.id);
  res.json({ ok: true });
});

/* Fournisseur principal de l'article (F-M1-08) : doit avoir une condition d'achat active */
r.post('/articles/:code/fournisseur-principal', exiger('acheteur'), async (req, res) => {
  const { fournisseur_code } = req.body || {};
  if (!fournisseur_code) return res.status(400).json({ erreur: 'Code fournisseur requis' });
  const { rows } = await query(
    'SELECT 1 FROM conditions_achat WHERE article_code=$1 AND fournisseur_code=$2',
    [req.params.code, fournisseur_code]);
  if (!rows.length) {
    return res.status(400).json({ erreur: 'Ce fournisseur n’a aucune condition d’achat sur cet article : ajoutez-en une d’abord' });
  }
  await query('UPDATE articles SET fournisseur_code=$1, modifie_le=now() WHERE code_interne=$2',
    [fournisseur_code, req.params.code]);
  await query(
    `INSERT INTO historique_articles (article_code, champ, nouvelle_valeur, source, auteur)
     VALUES ($1,'fournisseur_principal',$2,'saisie',$3)`,
    [req.params.code, fournisseur_code, req.utilisateur.email]);
  await auditer(req, 'fournisseur_principal', 'article', req.params.code, fournisseur_code);
  res.json({ ok: true });
});

/* Codes barres secondaires (F-M1-12) : lot, unité consommateur, appariements de veille */
r.post('/articles/:code/codes-barres', exiger('acheteur'), async (req, res) => {
  const { code_barres, description } = req.body || {};
  if (!code_barres) return res.status(400).json({ erreur: 'Code barres requis' });
  if (!validerEan(code_barres)) return res.status(400).json({ erreur: 'Code barres invalide (clé EAN/UPC incorrecte)' });
  const { rows: conflit } = await query(
    `SELECT code_interne AS porteur FROM articles WHERE code_barres=$1
     UNION SELECT article_code FROM codes_barres_secondaires WHERE code_barres=$1`, [code_barres]);
  if (conflit.length) return res.status(409).json({ erreur: `Code barres déjà porté par ${conflit[0].porteur}` });
  await query(
    `INSERT INTO codes_barres_secondaires (code_barres, article_code, description) VALUES ($1,$2,$3)`,
    [code_barres, req.params.code, description || null]);
  await auditer(req, 'ajout_code_barres', 'article', req.params.code, code_barres);
  res.json({ ok: true });
});

r.delete('/articles/:code/codes-barres/:cb', exiger('acheteur'), async (req, res) => {
  await query('DELETE FROM codes_barres_secondaires WHERE code_barres=$1 AND article_code=$2',
    [req.params.cb, req.params.code]);
  await auditer(req, 'suppression_code_barres', 'article', req.params.code, req.params.cb);
  res.json({ ok: true });
});

/*
 * Comparaison des fournisseurs d'un article (F-M3-07) : dernières conditions par fournisseur,
 * converties en devise de référence avec le dernier cours connu.
 */
r.get('/articles/:code/comparaison-fournisseurs', async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT ON (ca.fournisseur_code) ca.*, f.nom AS fournisseur_nom, f.pays,
            tc.cours AS dernier_cours
       FROM conditions_achat ca
       JOIN fournisseurs f ON f.code = ca.fournisseur_code
       LEFT JOIN LATERAL (
         SELECT cours FROM taux_change t WHERE t.devise = ca.devise ORDER BY date_cours DESC LIMIT 1
       ) tc ON TRUE
      WHERE ca.article_code=$1 AND (ca.date_fin IS NULL OR ca.date_fin >= CURRENT_DATE)
      ORDER BY ca.fournisseur_code, ca.date_effet DESC`, [req.params.code]);
  const { rows: aRows } = await query('SELECT fournisseur_code FROM articles WHERE code_interne=$1', [req.params.code]);
  const principal = aRows.length ? aRows[0].fournisseur_code : null;
  const comparaison = rows.map(c => {
    const cours = c.devise === 'XOF' ? 1 : (c.dernier_cours !== null ? Number(c.dernier_cours) : null);
    const net = Number(c.prix_achat) * (1 - Number(c.remise_pct) / 100);
    return {
      id: c.id, fournisseur_code: c.fournisseur_code, fournisseur_nom: c.fournisseur_nom, pays: c.pays,
      prix_achat: Number(c.prix_achat), remise_pct: Number(c.remise_pct), devise: c.devise,
      incoterm: c.incoterm, date_effet: c.date_effet,
      prix_net_devise: round(net, 4),
      prix_net_xof: cours !== null ? round(net * cours, 2) : null,
      cours_utilise: cours,
      principal: c.fournisseur_code === principal
    };
  }).sort((a, b) => (a.prix_net_xof ?? Infinity) - (b.prix_net_xof ?? Infinity));
  res.json({ principal, comparaison });
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
  const [cb, hist, cond, liens, photos] = await Promise.all([
    query('SELECT * FROM codes_barres_secondaires WHERE article_code=$1', [req.params.code]),
    query('SELECT * FROM historique_articles WHERE article_code=$1 ORDER BY date_modif DESC LIMIT 50', [req.params.code]),
    query(`SELECT ca.*, f.nom AS fournisseur_nom FROM conditions_achat ca
             JOIN fournisseurs f ON f.code=ca.fournisseur_code
            WHERE ca.article_code=$1 ORDER BY ca.date_effet DESC`, [req.params.code]),
    query(`SELECT l.*, a.libelle AS article_lie_libelle, 'sortant' AS sens
             FROM articles_lies l JOIN articles a ON a.code_interne=l.article_lie_code
            WHERE l.article_code=$1
           UNION ALL
           SELECT l.*, a.libelle, 'entrant'
             FROM articles_lies l JOIN articles a ON a.code_interne=l.article_code
            WHERE l.article_lie_code=$1`, [req.params.code]),
    query('SELECT id, nom_fichier, type_mime, taille FROM articles_photos WHERE article_code=$1 ORDER BY id', [req.params.code])
  ]);
  res.json({
    ...article, codes_barres_secondaires: cb.rows, historique: hist.rows,
    conditions_achat: cond.rows, liens: liens.rows, photos: photos.rows
  });
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

/* Détection de doublons de codes barres et de libellés proches (F-M1-11) */
r.get('/articles-doublons', async (req, res) => {
  const { rows: codesBarres } = await query(
    `SELECT code_barres, array_agg(code_interne) AS articles
       FROM articles WHERE code_barres IS NOT NULL
      GROUP BY code_barres HAVING COUNT(*) > 1`);
  let libellesProches = [];
  try {
    const { rows } = await query(
      `SELECT a.code_interne AS article_1, a.libelle AS libelle_1,
              b.code_interne AS article_2, b.libelle AS libelle_2,
              ROUND(similarity(a.libelle, b.libelle)::numeric, 2) AS similarite
         FROM articles a JOIN articles b ON a.code_interne < b.code_interne
        WHERE similarity(a.libelle, b.libelle) > 0.55
        ORDER BY similarity(a.libelle, b.libelle) DESC LIMIT 50`);
    libellesProches = rows;
  } catch { /* pg_trgm indisponible : détection limitée aux codes barres */ }
  res.json({ codes_barres: codesBarres, libelles_proches: libellesProches });
});

/* Assistance au classement tarifaire : positions proches du libellé (F-M1-14) */
r.get('/suggestion-position', async (req, res) => {
  const libelle = (req.query.libelle || '').trim();
  if (!libelle) return res.status(400).json({ erreur: 'Paramètre libelle requis' });
  try {
    const { rows } = await query(
      `SELECT DISTINCT ON (code) code, libelle, categorie, taux_dd,
              ROUND(similarity(libelle, $1)::numeric, 2) AS pertinence
         FROM positions_tarifaires
        WHERE similarity(libelle, $1) > 0.1
        ORDER BY code, date_effet DESC`, [libelle]);
    rows.sort((a, b) => Number(b.pertinence) - Number(a.pertinence));
    return res.json(rows.slice(0, 5));
  } catch {
    // Repli sans pg_trgm : recherche par mots
    const mots = libelle.toLowerCase().split(/\s+/).filter(m => m.length > 3);
    if (!mots.length) return res.json([]);
    const { rows } = await query(
      `SELECT DISTINCT ON (code) code, libelle, categorie, taux_dd, NULL AS pertinence
         FROM positions_tarifaires
        WHERE ${mots.map((_, i) => `lower(libelle) LIKE $${i + 1}`).join(' OR ')}
        ORDER BY code, date_effet DESC LIMIT 5`,
      mots.map(m => '%' + m + '%'));
    return res.json(rows);
  }
});

/* Photos et fiches techniques de l'article (F-M1-13) */
r.get('/articles/:code/photos', async (req, res) => {
  const { rows } = await query(
    `SELECT id, nom_fichier, type_mime, taille, televerse_le
       FROM articles_photos WHERE article_code=$1 ORDER BY id`, [req.params.code]);
  res.json(rows);
});

r.put('/articles/:code/photos', exiger('acheteur'), express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ erreur: 'Fichier vide' });
  const { rows: aRows } = await query('SELECT 1 FROM articles WHERE code_interne=$1', [req.params.code]);
  if (!aRows.length) return res.status(404).json({ erreur: 'Article introuvable' });
  const nom = decodeURIComponent(req.headers['x-nom-fichier'] || 'photo');
  const type = req.headers['content-type'] || 'application/octet-stream';
  const { rows } = await query(
    `INSERT INTO articles_photos (article_code, nom_fichier, type_mime, taille, contenu)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.params.code, nom, type, req.body.length, req.body]);
  await auditer(req, 'ajout_photo', 'article', req.params.code, nom);
  res.json({ ok: true, id: rows[0].id });
});

r.get('/photos/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM articles_photos WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ erreur: 'Photo introuvable' });
  res.setHeader('Content-Type', rows[0].type_mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(rows[0].nom_fichier)}"`);
  res.send(rows[0].contenu);
});

r.delete('/photos/:id', exiger('acheteur'), async (req, res) => {
  await query('DELETE FROM articles_photos WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

/* Articles liés : lot, unité de vente consommateur, remplacement, variante (F-M1-12, F-M1-15) */
const TYPES_LIENS = ['lot', 'uvc', 'remplacement', 'variante'];
r.post('/articles/:code/liens', exiger('acheteur'), async (req, res) => {
  const { article_lie_code, type_lien, description } = req.body || {};
  if (!article_lie_code || !TYPES_LIENS.includes(type_lien)) {
    return res.status(400).json({ erreur: `Article lié et type requis (${TYPES_LIENS.join(', ')})` });
  }
  if (article_lie_code === req.params.code) return res.status(400).json({ erreur: 'Un article ne peut pas être lié à lui-même' });
  const { rows } = await query('SELECT 1 FROM articles WHERE code_interne=$1', [article_lie_code]);
  if (!rows.length) return res.status(404).json({ erreur: `Article ${article_lie_code} introuvable` });
  await query(
    `INSERT INTO articles_lies (article_code, article_lie_code, type_lien, description)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [req.params.code, article_lie_code, type_lien, description || null]);
  await auditer(req, 'ajout_lien', 'article', req.params.code, `${type_lien} → ${article_lie_code}`);
  res.json({ ok: true });
});

r.delete('/liens/:id', exiger('acheteur'), async (req, res) => {
  await query('DELETE FROM articles_lies WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = r;
