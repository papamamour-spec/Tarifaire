'use strict';
/* Module M9 : pilotage et restitution — tableau de bord, indicateurs, alertes. */
const express = require('express');
const { query } = require('../db');

const r = express.Router();

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
