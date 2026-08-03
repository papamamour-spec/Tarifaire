'use strict';
/*
 * Moteur de prix (module M8) : confronte coût à couvrir, marge visée et prix du marché.
 * La proposition est toujours explicable : la contrainte déterminante est restituée (§11.1).
 * Modes d'arbitrage (§11.2) : marge | marche | encadre | alignement | manuel.
 */
const { query } = require('../db');
const { round, arrondirPrix } = require('../util');
const { cumpArticle, coutMiseEnRayon } = require('./cout');

/*
 * Résolution de la politique applicable : le niveau le plus fin l'emporte (§9.1).
 * article > politique(famille, format) > politique(famille, tous formats)
 * > politique(tous, format) > famille > défaut.
 */
async function resoudrePolitique(article, formatCode) {
  const res = {
    taux_marque_cible: 20, taux_marque_plancher: 5,
    mode_arbitrage: 'marge', indice_cible: 100, encadrement_pct: 5,
    source: 'défaut'
  };
  const { rows: pols } = await query(
    `SELECT * FROM politiques_tarifaires
      WHERE (famille_code IS NULL OR famille_code=$1)
        AND (format_code IS NULL OR format_code=$2)`,
    [article.famille_code, formatCode]);
  const score = p => (p.famille_code ? 2 : 0) + (p.format_code ? 1 : 0);
  pols.sort((a, b) => score(a) - score(b));
  for (const p of pols) {
    res.taux_marque_cible = Number(p.taux_marque_cible);
    res.taux_marque_plancher = Number(p.taux_marque_plancher);
    res.mode_arbitrage = p.mode_arbitrage || res.mode_arbitrage;
    if (p.indice_cible !== null) res.indice_cible = Number(p.indice_cible);
    if (p.encadrement_pct !== null) res.encadrement_pct = Number(p.encadrement_pct);
    res.source = `politique ${p.famille_code || 'toutes familles'} / ${p.format_code || 'tous formats'}`;
  }
  if (!pols.length && article.famille_code) {
    const { rows: fam } = await query('SELECT marge_cible FROM familles WHERE code=$1', [article.famille_code]);
    if (fam.length && fam[0].marge_cible !== null) {
      res.taux_marque_cible = Number(fam[0].marge_cible);
      res.source = `famille ${article.famille_code}`;
    }
  }
  if (article.marge_cible !== null && article.marge_cible !== undefined) {
    res.taux_marque_cible = Number(article.marge_cible);
    res.source = 'article';
  }
  if (article.mode_arbitrage) res.mode_arbitrage = article.mode_arbitrage;
  return res;
}

/* Dernier prix concurrent connu (fond de rayon en priorité), avec fraîcheur. */
async function prixMarche(article) {
  const { rows } = await query(
    `SELECT prix_ttc, date_releve, enseigne_code, type_prix,
            (CURRENT_DATE - date_releve) AS age_jours
       FROM releves_concurrents
      WHERE (article_code=$1 OR code_barres=$2)
      ORDER BY (type_prix='fond_de_rayon') DESC, date_releve DESC
      LIMIT 1`,
    [article.code_interne, article.code_barres || '']);
  return rows[0] || null;
}

/*
 * Proposition de prix pour un article et un format.
 * Étapes §11.1 : CMR → HT théorique → TTC → arrondi → confrontation marché → contrôles.
 */
async function proposerPrix(article, format, demarqueFamille) {
  const cump = await cumpArticle(article.code_interne);
  if (!cump) {
    return { article_code: article.code_interne, format_code: format.code, erreur: 'Aucun coût de revient calculé pour cet article' };
  }
  const cmr = coutMiseEnRayon(cump.cout_unitaire, article, format, demarqueFamille);
  const pol = await resoudrePolitique(article, format.code);
  const tva = Number(article.taux_tva_vente) || 0;

  const htTheorique = pol.taux_marque_cible < 100 ? cmr.total / (1 - pol.taux_marque_cible / 100) : cmr.total;
  const ttcTheorique = arrondirPrix(htTheorique * (1 + tva / 100), format.arrondi_regle, format.arrondi_pas, format.terminaison);

  const htPlancher = pol.taux_marque_plancher < 100 ? cmr.total / (1 - pol.taux_marque_plancher / 100) : cmr.total;
  const ttcPlancher = htPlancher * (1 + tva / 100);

  const marche = await prixMarche(article);
  let ttcRetenu = ttcTheorique;
  let contrainte = 'marge';
  const alertes = [];

  const appliquerMarche = cible => {
    const arrondi = arrondirPrix(cible, format.arrondi_regle, format.arrondi_pas, format.terminaison);
    if (arrondi < ttcPlancher) {
      ttcRetenu = arrondirPrix(ttcPlancher, 'superieur', format.arrondi_pas, format.terminaison);
      contrainte = 'plancher';
      alertes.push('Prix marché sous le plancher de marge : plancher appliqué');
    } else {
      ttcRetenu = arrondi;
      contrainte = 'marche';
    }
  };

  switch (pol.mode_arbitrage) {
    case 'marche':
      if (marche) appliquerMarche(Number(marche.prix_ttc) * pol.indice_cible / 100);
      else alertes.push('Aucun relevé concurrent : prix théorique appliqué');
      break;
    case 'encadre':
      if (marche) {
        const cible = Number(marche.prix_ttc) * pol.indice_cible / 100;
        const borneBasse = ttcTheorique * (1 - pol.encadrement_pct / 100);
        const borneHaute = ttcTheorique * (1 + pol.encadrement_pct / 100);
        appliquerMarche(Math.min(Math.max(cible, borneBasse), borneHaute));
      }
      break;
    case 'alignement':
      if (marche) {
        ttcRetenu = arrondirPrix(Number(marche.prix_ttc), format.arrondi_regle, format.arrondi_pas, format.terminaison);
        contrainte = 'marche';
        if (ttcRetenu < ttcPlancher) alertes.push('Alignement strict sous le plancher de marge');
      } else alertes.push('Alignement demandé mais aucun relevé concurrent');
      break;
    case 'manuel':
      alertes.push('Mode manuel : proposition indicative, prix à saisir');
      break;
    case 'marge':
    default:
      break;
  }

  const htRetenu = ttcRetenu / (1 + tva / 100);
  const margeUnitaire = htRetenu - cmr.total;
  const tauxMarque = htRetenu > 0 ? round(margeUnitaire / htRetenu * 100, 2) : null;
  if (margeUnitaire < 0) alertes.push('MARGE DE CONTRIBUTION NÉGATIVE');
  else if (tauxMarque !== null && tauxMarque < pol.taux_marque_plancher) alertes.push('Taux de marque sous le plancher');
  if (marche && Number(marche.age_jours) > 45) alertes.push(`Relevé concurrent ancien (${marche.age_jours} jours)`);

  return {
    article_code: article.code_interne,
    code_barres: article.code_barres,
    libelle: article.libelle,
    format_code: format.code,
    cout_debarque: cmr.cout_debarque,
    cout_mise_en_rayon: cmr.total,
    detail_cmr: cmr,
    politique: pol,
    taux_tva: tva,
    prix_ht_theorique: round(htTheorique, 2),
    prix_ttc_theorique: ttcTheorique,
    prix_marche: marche ? Number(marche.prix_ttc) : null,
    marche_info: marche || null,
    prix_ttc_propose: ttcRetenu,
    prix_ht_propose: round(htRetenu, 2),
    marge_unitaire: round(margeUnitaire, 2),
    taux_marque: tauxMarque,
    indice_vs_marche: marche && Number(marche.prix_ttc) > 0 ? round(ttcRetenu / Number(marche.prix_ttc) * 100, 1) : null,
    contrainte,
    alertes
  };
}

module.exports = { proposerPrix, resoudrePolitique, prixMarche };
