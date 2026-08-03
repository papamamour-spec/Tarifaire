'use strict';
/* Module M9 : pilotage et restitution — tableau de bord, indicateurs, marge réalisée. */
const express = require('express');
const { query, transaction } = require('../db');
const { exiger, auditer } = require('../auth');
const { parseCsv, num } = require('../util');

const r = express.Router();

/*
 * Lot 2 — Import des ventes remontées de l'ERP (flux FE07 du CDC).
 * Colonnes : code_barres (ou code_interne);point_de_vente;date_vente;quantite;ca_ttc
 */
r.post('/ventes-import/csv', exiger('comptable'), async (req, res) => {
  const { contenu } = req.body || {};
  if (!contenu) return res.status(400).json({ erreur: 'Contenu CSV requis' });
  const { records } = parseCsv(contenu);

  const codesBarres = [...new Set(records.map(x => x.code_barres).filter(Boolean))];
  const parCodeBarres = new Map(
    codesBarres.length
      ? (await query(
          `SELECT code_barres, code_interne FROM articles WHERE code_barres = ANY($1)
           UNION SELECT code_barres, article_code FROM codes_barres_secondaires WHERE code_barres = ANY($1)`,
          [codesBarres])).rows.map(x => [x.code_barres, x.code_interne])
      : []);
  const codesInternes = new Set(
    (await query('SELECT code_interne FROM articles')).rows.map(x => x.code_interne));

  const rejets = [];
  const valides = [];
  records.forEach((rec, i) => {
    const qte = num(rec.quantite);
    const ca = num(rec.ca_ttc);
    const date = rec.date_vente || rec.date;
    if (qte === null || ca === null || !date) { rejets.push({ ligne: i + 2, motif: 'quantite, ca_ttc ou date_vente manquant' }); return; }
    let article = null;
    if (rec.code_interne && codesInternes.has(rec.code_interne)) article = rec.code_interne;
    if (!article && rec.code_barres) article = parCodeBarres.get(rec.code_barres) || null;
    if (!article) { rejets.push({ ligne: i + 2, motif: `article inconnu (${rec.code_barres || rec.code_interne || '?'})` }); return; }
    valides.push({ article_code: article, point_de_vente_code: rec.point_de_vente || null, date_vente: date, quantite: qte, ca_ttc: ca });
  });

  await transaction(async q => {
    await q(
      `INSERT INTO ventes (article_code, point_de_vente_code, date_vente, quantite, ca_ttc)
       SELECT x.article_code, x.point_de_vente_code, x.date_vente::date, x.quantite, x.ca_ttc
         FROM jsonb_to_recordset($1::jsonb) AS x(article_code text, point_de_vente_code text,
              date_vente text, quantite numeric, ca_ttc numeric)`,
      [JSON.stringify(valides)]);
  });
  await auditer(req, 'import', 'ventes', null, `${valides.length} lignes de vente`);
  res.json({ importees: valides.length, rejets });
});

/*
 * Lot 2 — Marge réalisée vs marge théorique (UC09, F-M9-05).
 * Réalisée : CA HT constaté moins CUMP x quantités vendues.
 * Théorique : celle du tarif publié appliqué aux mêmes quantités.
 */
r.get('/marge-realisee', async (req, res) => {
  const { depuis, famille } = req.query;
  const params = [depuis || '1900-01-01'];
  let filtreFamille = '';
  if (famille) { params.push(famille); filtreFamille = ` AND a.famille_code=$${params.length}`; }
  const { rows } = await query(
    `WITH cump AS (
       SELECT article_code, SUM(cout_total)/NULLIF(SUM(quantite),0) AS cout_unitaire
         FROM resultats_couts WHERE article_code IS NOT NULL GROUP BY article_code
     ), tarif_actuel AS (
       SELECT DISTINCT ON (article_code) article_code, prix_ttc
         FROM tarifs WHERE statut='publie' ORDER BY article_code, date_effet DESC
     )
     SELECT a.code_interne, a.libelle, a.famille_code, a.taux_tva_vente,
            SUM(v.quantite) AS quantite_vendue,
            SUM(v.ca_ttc) AS ca_ttc,
            SUM(v.ca_ttc) / (1 + a.taux_tva_vente/100) AS ca_ht,
            c.cout_unitaire,
            t.prix_ttc AS prix_publie
       FROM ventes v
       JOIN articles a ON a.code_interne = v.article_code
       LEFT JOIN cump c ON c.article_code = v.article_code
       LEFT JOIN tarif_actuel t ON t.article_code = v.article_code
      WHERE v.date_vente >= $1::date${filtreFamille}
      GROUP BY a.code_interne, a.libelle, a.famille_code, a.taux_tva_vente, c.cout_unitaire, t.prix_ttc
      ORDER BY SUM(v.ca_ttc) DESC LIMIT 500`, params);

  const lignes = rows.map(x => {
    const caHt = Number(x.ca_ht);
    const qte = Number(x.quantite_vendue);
    const cump = x.cout_unitaire !== null ? Number(x.cout_unitaire) : null;
    const tva = Number(x.taux_tva_vente);
    const margeRealisee = cump !== null ? caHt - cump * qte : null;
    const tauxRealise = cump !== null && caHt > 0 ? Math.round(margeRealisee / caHt * 10000) / 100 : null;
    let tauxTheorique = null;
    if (cump !== null && x.prix_publie !== null) {
      const htPublie = Number(x.prix_publie) / (1 + tva / 100);
      tauxTheorique = htPublie > 0 ? Math.round((htPublie - cump) / htPublie * 10000) / 100 : null;
    }
    return {
      article_code: x.code_interne, libelle: x.libelle, famille: x.famille_code,
      quantite_vendue: qte, ca_ttc: Math.round(Number(x.ca_ttc)), ca_ht: Math.round(caHt),
      cout_unitaire: cump, marge_realisee: margeRealisee !== null ? Math.round(margeRealisee) : null,
      taux_marque_realise: tauxRealise, taux_marque_theorique: tauxTheorique,
      ecart_taux: tauxRealise !== null && tauxTheorique !== null
        ? Math.round((tauxRealise - tauxTheorique) * 100) / 100 : null
    };
  });
  const total = {
    ca_ttc: lignes.reduce((s, l) => s + l.ca_ttc, 0),
    marge_realisee: lignes.reduce((s, l) => s + (l.marge_realisee || 0), 0),
    nb_references: lignes.length,
    sans_cout: lignes.filter(l => l.cout_unitaire === null).length
  };
  res.json({ lignes, total });
});

r.get('/tableau-de-bord', async (req, res) => {
  const [articles, completude, dossiers, creances, tarifs, margesNeg, releves, doublons] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE statut='actif')::int AS actifs FROM articles`),
    query(`SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE poids_brut_carton IS NOT NULL AND volume_carton IS NOT NULL
               AND position_tarifaire IS NOT NULL AND unites_par_carton IS NOT NULL)::int AS complets
           FROM articles`),
    query(`SELECT statut, COUNT(*)::int AS n FROM dossiers GROUP BY statut`),
    query(`SELECT COALESCE(SUM(t.montant),0) AS creance
             FROM declaration_taxes t
             JOIN codes_taxes ct ON ct.code=t.code_taxe
            WHERE ct.traitement='creance'`),
    query(`SELECT statut, COUNT(*)::int AS n FROM tarifs GROUP BY statut`),
    query(`SELECT COUNT(*)::int AS n FROM tarifs WHERE statut IN ('propose','valide','publie') AND taux_marque < 0`),
    query(`SELECT COUNT(*)::int AS mois,
             COUNT(*) FILTER (WHERE article_code IS NULL)::int AS non_apparies
           FROM releves_concurrents WHERE date_releve > CURRENT_DATE - 30`),
    query(`SELECT COUNT(*)::int AS n FROM (
             SELECT code_barres FROM articles WHERE code_barres IS NOT NULL
             GROUP BY code_barres HAVING COUNT(*)>1) d`)
  ]);
  const [coefMoyen, tauxEffectifs] = await Promise.all([
    query(`SELECT ROUND(AVG(coefficient),4) AS coef, ROUND(AVG(taux_effectif),2) AS te FROM resultats_couts`),
    query(`SELECT MIN(taux_effectif) AS mini, MAX(taux_effectif) AS maxi FROM resultats_couts WHERE taux_effectif IS NOT NULL`)
  ]);
  res.json({
    articles: articles.rows[0],
    completude: {
      ...completude.rows[0],
      taux: completude.rows[0].total ? Math.round(completude.rows[0].complets / completude.rows[0].total * 1000) / 10 : 0
    },
    dossiers_par_statut: dossiers.rows,
    creance_tva: Number(creances.rows[0].creance),
    tarifs_par_statut: tarifs.rows,
    references_marge_negative: margesNeg.rows[0].n,
    releves_30j: releves.rows[0],
    doublons_codes_barres: doublons.rows[0].n,
    coefficient_moyen: coefMoyen.rows[0].coef ? Number(coefMoyen.rows[0].coef) : null,
    taux_effectif_moyen: coefMoyen.rows[0].te ? Number(coefMoyen.rows[0].te) : null,
    taux_effectif_bornes: tauxEffectifs.rows[0]
  });
});

/* Analyse des coûts par dossier (écart prévisionnel/définitif au fil des révisions) */
r.get('/analyse-dossiers', async (req, res) => {
  const { rows } = await query(
    `SELECT d.id, d.reference, d.statut, d.date_creation,
            COUNT(rc.id)::int AS nb_lignes,
            ROUND(SUM(rc.prix_achat_total),0) AS valeur_achat,
            ROUND(SUM(rc.cout_total),0) AS cout_total,
            ROUND(SUM(rc.cout_total)/NULLIF(SUM(rc.prix_achat_total),0),4) AS coefficient,
            ROUND(MIN(rc.taux_effectif),2) AS te_min, ROUND(MAX(rc.taux_effectif),2) AS te_max
       FROM dossiers d
       LEFT JOIN resultats_couts rc ON rc.dossier_id=d.id
      GROUP BY d.id ORDER BY d.id DESC LIMIT 100`);
  res.json(rows);
});

/* Marges par famille sur les tarifs publiés */
r.get('/marges-par-famille', async (req, res) => {
  const { rows } = await query(
    `SELECT COALESCE(a.famille_code,'(sans famille)') AS famille, t.format_code,
            COUNT(*)::int AS nb, ROUND(AVG(t.taux_marque),2) AS taux_marque_moyen,
            COUNT(*) FILTER (WHERE t.taux_marque < 0)::int AS negatifs
       FROM tarifs t JOIN articles a ON a.code_interne=t.article_code
      WHERE t.statut='publie'
      GROUP BY a.famille_code, t.format_code ORDER BY famille, t.format_code`);
  res.json(rows);
});

module.exports = r;
