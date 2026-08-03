'use strict';
/*
 * Lot 2 : barèmes de provision appris (F-M5-07).
 * À chaque clôture de dossier, le coût constaté par nature est mémorisé sous forme de
 * barème (pourcentage de la valeur, montant par unité payante, par colis ou par kg).
 * Ces barèmes servent à provisionner les frais non encore facturés des dossiers suivants,
 * ce qui permet de tarifer sans attendre la dernière facture ; la provision est marquée
 * comme telle et remplacée par le montant réel à réception.
 */
const { query } = require('../db');
const { round } = require('../util');
const { preparerLignes } = require('./cout');

const MODES_PAR_CLE = {
  valeur: 'pct_valeur',
  unite_payante: 'par_up',
  colis: 'par_colis',
  poids: 'par_kg',
  volume: 'par_m3',
  quantite: 'par_unite'
};

async function assiettesDossier(dossierId) {
  const { rows: dRows } = await query('SELECT * FROM dossiers WHERE id=$1', [dossierId]);
  if (!dRows.length) return null;
  const { lignes } = await preparerLignes(dRows[0]);
  return {
    dossier: dRows[0],
    valeur: lignes.reduce((s, l) => s + (l.montant_ref || 0), 0),
    unite_payante: lignes.reduce((s, l) => s + (l.unite_payante || 0), 0),
    colis: lignes.reduce((s, l) => s + (Number(l.nb_cartons) || 0), 0),
    poids: lignes.reduce((s, l) => s + (l.poids_calc || 0), 0),
    volume: lignes.reduce((s, l) => s + (l.volume_calc || 0), 0),
    quantite: lignes.reduce((s, l) => s + (Number(l.quantite) || 0), 0)
  };
}

/* Apprentissage à la clôture : moyenne glissante entre le barème existant et le constaté. */
async function apprendreBaremes(dossierId) {
  const assiettes = await assiettesDossier(dossierId);
  if (!assiettes) return 0;
  const { rows: couts } = await query(
    `SELECT nature, cle_repartition, SUM(montant * taux_change) AS montant
       FROM dossier_couts WHERE dossier_id=$1 AND capitalisable AND NOT provision
      GROUP BY nature, cle_repartition`, [dossierId]);
  let appris = 0;
  for (const c of couts) {
    const cle = c.cle_repartition || 'valeur';
    const assiette = assiettes[cle] || 0;
    if (assiette <= 0) continue;
    const mode = MODES_PAR_CLE[cle] || 'pct_valeur';
    const constate = mode === 'pct_valeur'
      ? Number(c.montant) / assiettes.valeur * 100
      : Number(c.montant) / assiette;
    const { rows: existant } = await query('SELECT * FROM baremes_provision WHERE nature=$1', [c.nature]);
    if (existant.length) {
      const n = existant[0].nb_dossiers;
      const lisse = (Number(existant[0].valeur) * n + constate) / (n + 1);
      await query(
        `UPDATE baremes_provision SET valeur=$1, cle_repartition=$2, mode=$3, nb_dossiers=$4,
           dernier_dossier=$5, date_maj=now() WHERE nature=$6`,
        [round(lisse, 4), cle, mode, n + 1, assiettes.dossier.reference, c.nature]);
    } else {
      await query(
        `INSERT INTO baremes_provision (nature, cle_repartition, mode, valeur, nb_dossiers, dernier_dossier)
         VALUES ($1,$2,$3,$4,1,$5)`,
        [c.nature, cle, mode, round(constate, 4), assiettes.dossier.reference]);
    }
    appris++;
  }
  return appris;
}

/* Propose des provisions pour les natures habituelles absentes du dossier. */
async function proposerProvisions(dossierId) {
  const assiettes = await assiettesDossier(dossierId);
  if (!assiettes) return [];
  const { rows: baremes } = await query('SELECT * FROM baremes_provision ORDER BY nature');
  const { rows: presentes } = await query(
    'SELECT DISTINCT nature FROM dossier_couts WHERE dossier_id=$1', [dossierId]);
  const naturesPresentes = new Set(presentes.map(x => x.nature));
  const propositions = [];
  for (const b of baremes) {
    if (naturesPresentes.has(b.nature)) continue;
    const assiette = assiettes[b.cle_repartition] || 0;
    const montant = b.mode === 'pct_valeur'
      ? assiettes.valeur * Number(b.valeur) / 100
      : assiette * Number(b.valeur);
    if (montant <= 0) continue;
    propositions.push({
      nature: b.nature,
      cle_repartition: b.cle_repartition,
      mode: b.mode,
      valeur_bareme: Number(b.valeur),
      assiette: round(assiette, 3),
      montant_propose: round(montant, 0),
      nb_dossiers_appris: b.nb_dossiers,
      dernier_dossier: b.dernier_dossier
    });
  }
  return propositions;
}

module.exports = { apprendreBaremes, proposerProvisions };
