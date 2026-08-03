'use strict';
/*
 * Lot 3 : contrôleur de cohérence tarifaire (F-M6-07, F-M6-08).
 * Trois familles de contrôles sur les tarifs publiés ou proposés d'un format :
 *  1. prix au kilo décroissant avec la taille du conditionnement (même famille et marque) ;
 *  2. ordre de gamme : premier prix <= marque propre <= marque nationale (prix au kilo moyen) ;
 *  3. écart de prix d'une même référence entre formats, borné par un seuil.
 */
const { query } = require('../db');
const { round } = require('../util');

async function controlerFormat(formatCode, ecartMaxFormats = 15) {
  const anomalies = [];

  const { rows: tarifs } = await query(
    `SELECT DISTINCT ON (t.article_code) t.article_code, t.prix_ttc, a.libelle, a.famille_code,
            a.marque, a.type_marque, a.poids_net_unitaire
       FROM tarifs t JOIN articles a ON a.code_interne=t.article_code
      WHERE t.format_code=$1 AND t.statut IN ('publie','valide','propose','a_valider')
      ORDER BY t.article_code, t.date_effet DESC`, [formatCode]);

  // 1. Prix au kilo décroissant avec la taille (même famille + marque, poids connus)
  const groupes = new Map();
  for (const t of tarifs) {
    if (!t.poids_net_unitaire || Number(t.poids_net_unitaire) <= 0) continue;
    const cle = `${t.famille_code}|${(t.marque || '').toLowerCase()}`;
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push({
      ...t,
      poids: Number(t.poids_net_unitaire),
      prix_kg: Number(t.prix_ttc) / Number(t.poids_net_unitaire)
    });
  }
  for (const [cle, articles] of groupes) {
    if (articles.length < 2) continue;
    const tries = [...articles].sort((a, b) => a.poids - b.poids);
    for (let i = 1; i < tries.length; i++) {
      if (tries[i].prix_kg > tries[i - 1].prix_kg * 1.02) {
        anomalies.push({
          type: 'prix_au_kilo',
          gravite: 'alerte',
          message: `${tries[i].article_code} (${tries[i].libelle}) : le grand conditionnement (${tries[i].poids} kg à ${round(tries[i].prix_kg, 0)} F/kg) est plus cher au kilo que ${tries[i - 1].article_code} (${tries[i - 1].poids} kg à ${round(tries[i - 1].prix_kg, 0)} F/kg)`,
          articles: [tries[i - 1].article_code, tries[i].article_code],
          groupe: cle
        });
      }
    }
  }

  // 2. Ordre de gamme par famille : premier prix <= marque propre <= marque nationale
  const ORDRE = { premier_prix: 0, propre: 1, nationale: 2 };
  const parFamille = new Map();
  for (const t of tarifs) {
    if (!t.type_marque || !t.poids_net_unitaire || Number(t.poids_net_unitaire) <= 0) continue;
    if (!parFamille.has(t.famille_code)) parFamille.set(t.famille_code, {});
    const f = parFamille.get(t.famille_code);
    (f[t.type_marque] = f[t.type_marque] || []).push(Number(t.prix_ttc) / Number(t.poids_net_unitaire));
  }
  for (const [famille, types] of parFamille) {
    const moyennes = Object.entries(types)
      .filter(([type]) => type in ORDRE)
      .map(([type, prix]) => ({ type, moyenne: prix.reduce((s, p) => s + p, 0) / prix.length }))
      .sort((a, b) => ORDRE[a.type] - ORDRE[b.type]);
    for (let i = 1; i < moyennes.length; i++) {
      if (moyennes[i - 1].moyenne > moyennes[i].moyenne * 1.02) {
        anomalies.push({
          type: 'ordre_de_gamme',
          gravite: 'alerte',
          message: `Famille ${famille} : le prix au kilo moyen « ${moyennes[i - 1].type} » (${round(moyennes[i - 1].moyenne, 0)} F/kg) dépasse celui de « ${moyennes[i].type} » (${round(moyennes[i].moyenne, 0)} F/kg)`,
          famille
        });
      }
    }
  }

  // 3. Écart entre formats pour une même référence
  const { rows: multi } = await query(
    `WITH publies AS (
       SELECT DISTINCT ON (article_code, format_code) article_code, format_code, prix_ttc
         FROM tarifs WHERE statut='publie' ORDER BY article_code, format_code, date_effet DESC
     )
     SELECT article_code, MIN(prix_ttc) AS mini, MAX(prix_ttc) AS maxi, COUNT(*) AS nb
       FROM publies GROUP BY article_code HAVING COUNT(*) > 1`);
  for (const m of multi) {
    const ecart = (Number(m.maxi) - Number(m.mini)) / Number(m.mini) * 100;
    if (ecart > ecartMaxFormats) {
      anomalies.push({
        type: 'ecart_formats',
        gravite: 'alerte',
        message: `${m.article_code} : écart de ${round(ecart, 1)} % entre formats (${round(Number(m.mini), 0)} F à ${round(Number(m.maxi), 0)} F), seuil ${ecartMaxFormats} %`,
        articles: [m.article_code]
      });
    }
  }

  return { format: formatCode, nb_tarifs_controles: tarifs.length, anomalies };
}

module.exports = { controlerFormat };
