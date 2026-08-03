'use strict';
/*
 * Moteur de liquidation douanière - configuration déclarative (F-M2-02).
 * Chaque taxe est définie par son ordre, son taux (ou le taux de la position pour le
 * droit de douane), sa base exprimée en composants (VD + codes de taxes déjà calculées)
 * et son traitement comptable : 'cout' (incorporé au stock) ou 'creance' (créance sur l'État).
 * Les taxes en cascade sont ainsi reproduites sans développement (exigence structurante §6.3).
 */
const { query } = require('../db');
const { round } = require('../util');

async function chargerTaxes() {
  const { rows } = await query('SELECT * FROM codes_taxes WHERE actif ORDER BY ordre');
  return rows;
}

/*
 * Position en vigueur à une date donnée (F-M2-07), avec résolution HIÉRARCHIQUE :
 * si le code exact est absent, on retombe sur la sous-position ou le chapitre le plus
 * précis dont le code est un préfixe (10 → 8 → 6 → 4 → 2 chiffres). Le résultat porte
 * `niveau` ('exact' ou 'approche') et `code_demande` pour que la restitution le signale.
 */
async function chargerPosition(code, date) {
  if (!code) return null;
  const demande = String(code).replace(/\D/g, '');
  if (!demande) return null;
  const { rows } = await query(
    `SELECT * FROM positions_tarifaires
      WHERE $1 LIKE code || '%' AND date_effet <= COALESCE($2::date, CURRENT_DATE)
      ORDER BY length(code) DESC, date_effet DESC LIMIT 1`, [demande, date || null]);
  let position = rows[0];
  if (!position) {
    // Aucune version en vigueur à cette date : plus ancienne connue du préfixe le plus long
    const { rows: toutes } = await query(
      `SELECT * FROM positions_tarifaires WHERE $1 LIKE code || '%'
        ORDER BY length(code) DESC, date_effet ASC LIMIT 1`, [demande]);
    position = toutes[0];
  }
  if (!position) return null;
  return {
    ...position,
    code_demande: demande,
    niveau: position.code === demande ? 'exact' : 'approche'
  };
}

async function chargerExonerations() {
  const { rows } = await query('SELECT * FROM exonerations');
  return rows;
}

/*
 * Taux applicable d'une taxe après règles par produit et origine (accises, TCI,
 * exonérations…). Parmi les règles qui correspondent, LA PLUS SPÉCIFIQUE l'emporte :
 * préfixe de position le plus long d'abord, et à préfixe égal, la règle qui précise
 * une origine prime sur la règle générale.
 */
function tauxApplicable(taxe, position, origine, regles) {
  const tauxBase = taxe.taux_depuis_position ? (position ? Number(position.taux_dd) : 0) : Number(taxe.taux || 0);
  const codeReference = position ? (position.code_demande || position.code) : '';
  const correspondantes = regles.filter(r => {
    if (r.code_taxe !== taxe.code) return false;
    const okPos = !r.position_prefixe || (codeReference && codeReference.startsWith(r.position_prefixe));
    const okOri = !r.origine || (origine && origine.toUpperCase() === r.origine.toUpperCase());
    return okPos && okOri;
  });
  if (!correspondantes.length) return { taux: tauxBase, regle: null };
  correspondantes.sort((a, b) =>
    ((b.position_prefixe || '').length - (a.position_prefixe || '').length) ||
    ((b.origine ? 1 : 0) - (a.origine ? 1 : 0)));
  const retenue = correspondantes[0];
  return { taux: Number(retenue.taux_applique), regle: retenue.commentaire || `règle ${retenue.position_prefixe || 'toutes positions'}${retenue.origine ? ' origine ' + retenue.origine : ''}` };
}

/*
 * Liquide une valeur en douane pour une position tarifaire donnée.
 * Retourne { lignes: [{code, libelle, base, taux, montant, traitement}], total, total_cout, total_creance, taux_effectif }
 */
async function liquider({ valeurEnDouane, positionCode, origine, date }) {
  const [taxes, position, exonerations] = await Promise.all([
    chargerTaxes(), chargerPosition(positionCode, date), chargerExonerations()
  ]);
  const vd = Number(valeurEnDouane) || 0;
  const montants = { VD: vd };
  const lignes = [];
  for (const taxe of taxes) {
    const composants = String(taxe.base_composants || 'VD').split('+').map(s => s.trim()).filter(Boolean);
    let base = 0;
    for (const c of composants) base += Number(montants[c] || 0);
    const { taux, regle } = tauxApplicable(taxe, position, origine, exonerations);
    const montant = round(base * taux / 100, 0);
    montants[taxe.code] = montant;
    lignes.push({
      code: taxe.code,
      libelle: taxe.libelle,
      base: round(base, 0),
      taux,
      montant,
      traitement: taxe.traitement,
      regle_appliquee: regle
    });
  }
  const total = lignes.reduce((s, l) => s + l.montant, 0);
  const totalCout = lignes.filter(l => l.traitement === 'cout').reduce((s, l) => s + l.montant, 0);
  const totalCreance = lignes.filter(l => l.traitement === 'creance').reduce((s, l) => s + l.montant, 0);
  return {
    position: position ? {
      code: position.code, libelle: position.libelle, taux_dd: Number(position.taux_dd),
      niveau: position.niveau, code_demande: position.code_demande
    } : null,
    valeur_en_douane: vd,
    lignes,
    total: round(total, 0),
    total_cout: round(totalCout, 0),
    total_creance: round(totalCreance, 0),
    taux_effectif: vd > 0 ? round(totalCout / vd * 100, 2) : null
  };
}

/*
 * (Re)calcule la liquidation simulée de tous les articles d'une déclaration.
 * Les montants saisis comme réels ('reel') sont conservés et priment (F-M2-04).
 */
async function liquiderDeclaration(dossierId) {
  const { rows: arts } = await query(
    'SELECT * FROM declaration_articles WHERE dossier_id=$1 ORDER BY rang', [dossierId]);
  for (const art of arts) {
    const sim = await liquider({
      valeurEnDouane: art.valeur_caf,
      positionCode: art.position_tarifaire,
      origine: art.origine
    });
    const { rows: existantes } = await query(
      'SELECT * FROM declaration_taxes WHERE declaration_article_id=$1', [art.id]);
    const reelles = new Map(existantes.filter(t => t.origine_montant === 'reel').map(t => [t.code_taxe, t]));
    await query(
      `DELETE FROM declaration_taxes WHERE declaration_article_id=$1 AND origine_montant='simule'`, [art.id]);
    for (const l of sim.lignes) {
      if (reelles.has(l.code)) continue;
      await query(
        `INSERT INTO declaration_taxes (declaration_article_id, code_taxe, base, taux, montant, origine_montant)
         VALUES ($1,$2,$3,$4,$5,'simule')`,
        [art.id, l.code, l.base, l.taux, l.montant]);
    }
  }
  return arts.length;
}

module.exports = { liquider, liquiderDeclaration, chargerTaxes };
