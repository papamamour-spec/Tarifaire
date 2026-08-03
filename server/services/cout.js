'use strict';
/*
 * Moteur de coût de revient (module M5).
 * - Coût de revient débarqué : une clé de répartition par nature de coût (F-M5-01),
 *   droits et taxes repris au montant réel par ligne tarifaire sans répartition globale (F-M5-02),
 *   fret réparti à l'unité payante = max(poids taxable en tonnes, volume en m³) (F-M5-03).
 * - Les poids/volumes manquants sont estimés (au prorata) et marqués comme tels,
 *   le total restant égal aux totaux du connaissement (point de vigilance §5.3).
 * - Coût de mise en rayon : coût débarqué + logistique aval + démarque + portage (§8.4).
 */
const { query } = require('../db');
const { round } = require('../util');

async function parametre(cle, defaut) {
  const { rows } = await query('SELECT valeur FROM parametres WHERE cle=$1', [cle]);
  return rows.length ? rows[0].valeur : defaut;
}

/*
 * Prépare les lignes du dossier : montants en devise de référence, poids et volume
 * réels ou estimés, unité payante par ligne.
 */
async function preparerLignes(dossier) {
  const { rows: lignes } = await query(
    `SELECT l.*, a.poids_brut_carton, a.unites_par_carton, a.volume_carton,
            a.poids_net_unitaire, a.libelle AS article_libelle
       FROM dossier_lignes l
       LEFT JOIN articles a ON a.code_interne = l.article_code
      WHERE l.dossier_id=$1 ORDER BY l.rang`, [dossier.id]);

  const tc = Number(dossier.taux_change) || 1;
  for (const l of lignes) {
    l.montant_ref = round((Number(l.montant_devise) || 0) * tc, 2);
    // Poids : saisi sur la ligne > déduit de la fiche article > estimé ensuite
    l.poids_calc = l.poids_brut !== null ? Number(l.poids_brut) : null;
    l.poids_est = !!l.poids_estime;
    if (l.poids_calc === null && l.poids_brut_carton && l.unites_par_carton) {
      l.poids_calc = round(Number(l.poids_brut_carton) / Number(l.unites_par_carton) * Number(l.quantite), 3);
    }
    // Volume : saisi > fiche article > estimé ensuite au prorata du poids
    l.volume_calc = l.volume !== null ? Number(l.volume) : null;
    l.volume_est = !!l.volume_estime;
    if (l.volume_calc === null && l.volume_carton && l.unites_par_carton) {
      l.volume_calc = round(Number(l.volume_carton) / Number(l.unites_par_carton) * Number(l.quantite), 4);
    }
  }

  const totalValeur = lignes.reduce((s, l) => s + l.montant_ref, 0);

  // Estimation des poids manquants : le solde du poids total du connaissement est
  // réparti au prorata de la valeur entre les lignes sans poids.
  const sansPoids = lignes.filter(l => l.poids_calc === null);
  if (sansPoids.length) {
    const poidsConnu = lignes.filter(l => l.poids_calc !== null).reduce((s, l) => s + l.poids_calc, 0);
    const poidsTotal = Number(dossier.poids_total) || 0;
    const solde = Math.max(0, poidsTotal - poidsConnu);
    const valeurSans = sansPoids.reduce((s, l) => s + l.montant_ref, 0);
    for (const l of sansPoids) {
      l.poids_calc = valeurSans > 0 ? round(solde * l.montant_ref / valeurSans, 3) : 0;
      l.poids_est = true;
    }
  }

  // Estimation des volumes manquants : solde du volume du connaissement au prorata du poids.
  const sansVolume = lignes.filter(l => l.volume_calc === null);
  if (sansVolume.length) {
    const volumeConnu = lignes.filter(l => l.volume_calc !== null).reduce((s, l) => s + l.volume_calc, 0);
    const volumeTotal = Number(dossier.volume_total) || 0;
    const solde = Math.max(0, volumeTotal - volumeConnu);
    const poidsSans = sansVolume.reduce((s, l) => s + (l.poids_calc || 0), 0);
    for (const l of sansVolume) {
      l.volume_calc = poidsSans > 0 ? round(solde * (l.poids_calc || 0) / poidsSans, 4)
        : (sansVolume.length ? round(solde / sansVolume.length, 4) : 0);
      l.volume_est = true;
    }
  }

  // Unité payante : max(poids en tonnes / ratio, volume en m³)
  const ratio = Number(await parametre('ratio_unite_payante', '1')) || 1;
  for (const l of lignes) {
    const tonnes = (l.poids_calc || 0) / 1000 / ratio;
    const m3 = l.volume_calc || 0;
    l.unite_payante = round(Math.max(tonnes, m3), 4);
    l.indicateur_up = tonnes >= m3 ? 'poids' : 'volume';
  }
  return { lignes, totalValeur };
}

function assiette(ligne, cle) {
  switch (cle) {
    case 'poids': return ligne.poids_calc || 0;
    case 'volume': return ligne.volume_calc || 0;
    case 'unite_payante': return ligne.unite_payante || 0;
    case 'colis': return Number(ligne.nb_cartons) || 0;
    case 'quantite': return Number(ligne.quantite) || 0;
    case 'valeur':
    default: return ligne.montant_ref || 0;
  }
}

/*
 * Calcule et enregistre le coût de revient débarqué du dossier.
 * Retourne le détail par ligne + contrôles + totaux.
 */
async function calculerDossier(dossierId) {
  const { rows: dRows } = await query('SELECT * FROM dossiers WHERE id=$1', [dossierId]);
  if (!dRows.length) throw new Error('Dossier introuvable');
  const dossier = dRows[0];

  const { lignes } = await preparerLignes(dossier);
  if (!lignes.length) throw new Error('Le dossier ne comporte aucune ligne');

  const { rows: couts } = await query('SELECT * FROM dossier_couts WHERE dossier_id=$1 ORDER BY id', [dossierId]);
  const { rows: declArts } = await query('SELECT * FROM declaration_articles WHERE dossier_id=$1 ORDER BY rang', [dossierId]);
  const { rows: declTaxes } = await query(
    `SELECT t.*, da.rang AS decl_rang FROM declaration_taxes t
      JOIN declaration_articles da ON da.id = t.declaration_article_id
     WHERE da.dossier_id=$1`, [dossierId]);
  const { rows: codesTaxes } = await query('SELECT * FROM codes_taxes');
  const traitementTaxe = new Map(codesTaxes.map(t => [t.code, t.traitement]));

  // Initialisation du résultat par ligne
  const res = lignes.map(l => ({
    ligne: l,
    composantes: [{ nature: 'achat', libelle: 'Prix d’achat net', montant: l.montant_ref, cle: null, estime: false }],
    taxes_cout: 0,
    taxes_creance: 0
  }));

  const alertes = [];

  // 1) Répartition des coûts accessoires capitalisables, clé par nature (F-M5-01)
  const chargesPeriode = [];
  for (const c of couts) {
    const montantRef = round((Number(c.montant) || 0) * (Number(c.taux_change) || 1), 2);
    if (!c.capitalisable) {
      chargesPeriode.push({ nature: c.nature, libelle: c.libelle, montant: montantRef });
      continue;
    }
    const total = lignes.reduce((s, l) => s + assiette(l, c.cle_repartition), 0);
    if (total <= 0) {
      alertes.push(`Coût « ${c.libelle || c.nature} » : assiette « ${c.cle_repartition} » nulle, réparti à la valeur`);
    }
    const cleEffective = total > 0 ? c.cle_repartition : 'valeur';
    const totalEff = lignes.reduce((s, l) => s + assiette(l, cleEffective), 0) || 1;
    let affecte = 0;
    res.forEach((r, i) => {
      let part;
      if (i === res.length - 1) part = round(montantRef - affecte, 2); // solde sur la dernière ligne
      else { part = round(montantRef * assiette(r.ligne, cleEffective) / totalEff, 2); affecte += part; }
      const estime = (cleEffective === 'poids' && r.ligne.poids_est) ||
        ((cleEffective === 'volume' || cleEffective === 'unite_payante') && (r.ligne.volume_est || r.ligne.poids_est));
      r.composantes.push({
        nature: c.nature, libelle: c.libelle || c.nature, montant: part,
        cle: cleEffective, provision: c.provision, estime
      });
    });
  }

  // 2) Droits et taxes : montant réel par article de déclaration, ventilé sur les seules
  //    lignes rattachées à cet article, au prorata de leur valeur (F-M5-02).
  for (const da of declArts) {
    const rattachees = res.filter(r => Number(r.ligne.declaration_rang) === Number(da.rang));
    const taxesArt = declTaxes.filter(t => t.declaration_article_id === da.id);
    const coutTaxes = taxesArt.filter(t => (traitementTaxe.get(t.code_taxe) || 'cout') === 'cout')
      .reduce((s, t) => s + Number(t.montant), 0);
    const creanceTaxes = taxesArt.filter(t => traitementTaxe.get(t.code_taxe) === 'creance')
      .reduce((s, t) => s + Number(t.montant), 0);
    if (!rattachees.length) {
      if (coutTaxes > 0) alertes.push(`Article de déclaration n°${da.rang} (${da.position_tarifaire}) : aucune ligne de facture rattachée, taxes non réparties`);
      continue;
    }
    const totalVal = rattachees.reduce((s, r) => s + r.ligne.montant_ref, 0) || 1;
    let affecte = 0;
    rattachees.forEach((r, i) => {
      let part;
      if (i === rattachees.length - 1) part = round(coutTaxes - affecte, 2);
      else { part = round(coutTaxes * r.ligne.montant_ref / totalVal, 2); affecte += part; }
      r.taxes_cout = round(r.taxes_cout + part, 2);
      r.taxes_creance = round(r.taxes_creance + creanceTaxes * r.ligne.montant_ref / totalVal, 2);
      r.composantes.push({
        nature: 'droits_taxes', libelle: `Droits et taxes (décl. n°${da.rang})`,
        montant: part, cle: 'ligne_tarifaire', estime: false
      });
    });
    // Contrôle de concordance valeur déclarée / lignes rattachées (F-M4-05)
    const ecart = round(Number(da.valeur_caf) - rattachees.reduce((s, r) => s + r.ligne.montant_ref, 0), 0);
    if (Math.abs(ecart) > Math.max(1, Number(da.valeur_caf) * 0.02)) {
      alertes.push(`Article de déclaration n°${da.rang} : écart de ${ecart.toLocaleString('fr-FR')} entre valeur déclarée et lignes rattachées`);
    }
  }

  // Lignes de facture non rattachées à la déclaration (F-M4-06)
  if (declArts.length) {
    for (const r of res) {
      if (!r.ligne.declaration_rang) {
        alertes.push(`Ligne ${r.ligne.rang} (${r.ligne.article_code || r.ligne.code_barres || r.ligne.libelle}) non rattachée à la déclaration`);
      }
    }
  }

  // 3) Enregistrement des résultats par ligne
  await query('DELETE FROM resultats_couts WHERE dossier_id=$1', [dossierId]);
  const sortie = [];
  for (const r of res) {
    const coutTotal = round(r.composantes.reduce((s, c) => s + c.montant, 0), 2);
    const q = Number(r.ligne.quantite) || 1;
    const unitaire = round(coutTotal / q, 2);
    const coefficient = r.ligne.montant_ref > 0 ? round(coutTotal / r.ligne.montant_ref, 4) : null;
    const tauxEffectif = r.ligne.montant_ref > 0 ? round(r.taxes_cout / r.ligne.montant_ref * 100, 2) : null;
    const detail = {
      composantes: r.composantes,
      taxes_creance: r.taxes_creance,
      poids: r.ligne.poids_calc, poids_estime: r.ligne.poids_est,
      volume: r.ligne.volume_calc, volume_estime: r.ligne.volume_est
    };
    await query(
      `INSERT INTO resultats_couts (dossier_id, ligne_id, article_code, quantite, prix_achat_total,
         cout_total, cout_unitaire, coefficient, taux_effectif, unite_payante, indicateur_up, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [dossierId, r.ligne.id, r.ligne.article_code, q, r.ligne.montant_ref,
        coutTotal, unitaire, coefficient, tauxEffectif, r.ligne.unite_payante, r.ligne.indicateur_up,
        JSON.stringify(detail)]);
    sortie.push({
      ligne_id: r.ligne.id, rang: r.ligne.rang, article_code: r.ligne.article_code,
      libelle: r.ligne.libelle || r.ligne.article_libelle, quantite: q,
      prix_achat_total: r.ligne.montant_ref, cout_total: coutTotal, cout_unitaire: unitaire,
      coefficient, taux_effectif: tauxEffectif,
      unite_payante: r.ligne.unite_payante, indicateur_up: r.ligne.indicateur_up,
      poids: r.ligne.poids_calc, poids_estime: r.ligne.poids_est,
      volume: r.ligne.volume_calc, volume_estime: r.ligne.volume_est,
      taxes_creance: r.taxes_creance,
      composantes: r.composantes
    });
  }

  // 4) Alimentation automatique du référentiel (F-M1-04) : taux effectif constaté
  for (const r of sortie) {
    if (r.article_code && r.taux_effectif !== null) {
      await query('UPDATE articles SET taux_effectif_constate=$1, modifie_le=now() WHERE code_interne=$2',
        [r.taux_effectif, r.article_code]);
    }
  }

  const totaux = {
    valeur_achat: round(sortie.reduce((s, r) => s + r.prix_achat_total, 0), 0),
    cout_total: round(sortie.reduce((s, r) => s + r.cout_total, 0), 0),
    taxes_creance: round(sortie.reduce((s, r) => s + r.taxes_creance, 0), 0),
    charges_periode: round(chargesPeriode.reduce((s, c) => s + c.montant, 0), 0)
  };
  totaux.coefficient_moyen = totaux.valeur_achat > 0 ? round(totaux.cout_total / totaux.valeur_achat, 4) : null;

  return { dossier_id: dossierId, lignes: sortie, charges_periode: chargesPeriode, alertes, totaux };
}

/* Coût unitaire moyen pondéré multi-dossiers par article (F-M5-09). */
async function cumpArticle(articleCode) {
  const { rows } = await query(
    `SELECT SUM(cout_total) AS ct, SUM(quantite) AS q, MAX(calcule_le) AS dernier
       FROM resultats_couts WHERE article_code=$1`, [articleCode]);
  if (!rows.length || !rows[0].q || Number(rows[0].q) === 0) return null;
  return { cout_unitaire: round(Number(rows[0].ct) / Number(rows[0].q), 2), dernier_calcul: rows[0].dernier };
}

/* Coût de mise en rayon d'un article pour un format (§8.4). */
function coutMiseEnRayon(coutDebarque, article, format, demarqueFamille) {
  const c = Number(coutDebarque) || 0;
  let logistique = 0;
  const val = Number(format.logistique_aval_valeur) || 0;
  switch (format.logistique_aval_mode) {
    case 'par_kg': logistique = val * (Number(article.poids_net_unitaire) || 0); break;
    case 'par_colis': logistique = article.unites_par_carton ? val / Number(article.unites_par_carton) : 0; break;
    case 'par_m3': logistique = (article.volume_carton && article.unites_par_carton)
      ? val * Number(article.volume_carton) / Number(article.unites_par_carton) : 0; break;
    case 'pct_valeur':
    default: logistique = c * val / 100;
  }
  const tauxDemarque = demarqueFamille !== null && demarqueFamille !== undefined
    ? Number(demarqueFamille) : Number(format.demarque_taux) || 0;
  const demarque = c * tauxDemarque / 100;
  const portage = c * (Number(format.taux_financement) || 0) / 100 * (Number(format.rotation_jours) || 0) / 365;
  return {
    cout_debarque: round(c, 2),
    logistique_aval: round(logistique, 2),
    demarque: round(demarque, 2),
    portage: round(portage, 2),
    total: round(c + logistique + demarque + portage, 2)
  };
}

module.exports = { calculerDossier, cumpArticle, coutMiseEnRayon, preparerLignes };
