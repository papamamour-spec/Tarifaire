'use strict';
/* Modules M4 (dossiers d'importation) et M5 (moteur de coût de revient). */
const express = require('express');
const { query } = require('../db');
const { exiger, auditer } = require('../auth');
const { parseCsv, toCsv, num, round } = require('../util');
const { liquiderDeclaration } = require('../services/liquidation');
const { calculerDossier } = require('../services/cout');

const r = express.Router();

const STATUTS = ['ouvert', 'titres_obtenus', 'embarque', 'declare', 'receptionne', 'cloture', 'revise'];

/* ---------------- Dossiers ---------------- */
r.get('/', async (req, res) => {
  const { statut } = req.query;
  const params = [];
  let sql = `SELECT d.*, f.nom AS fournisseur_nom,
      (SELECT COUNT(*) FROM dossier_lignes l WHERE l.dossier_id=d.id) AS nb_lignes,
      (SELECT COALESCE(SUM(montant_devise),0) FROM dossier_lignes l WHERE l.dossier_id=d.id) AS total_devise
    FROM dossiers d LEFT JOIN fournisseurs f ON f.code=d.fournisseur_code WHERE 1=1`;
  if (statut) { params.push(statut); sql += ` AND d.statut=$${params.length}`; }
  sql += ' ORDER BY d.id DESC LIMIT 200';
  const { rows } = await query(sql, params);
  res.json(rows);
});

r.post('/', exiger('import'), async (req, res) => {
  const d = req.body || {};
  if (!d.reference) return res.status(400).json({ erreur: 'Référence du dossier requise' });
  const { rows } = await query(
    `INSERT INTO dossiers (reference, libelle, fournisseur_code, devise, taux_change, incoterm, conteneur, poids_total, volume_total, commentaire)
     VALUES ($1,$2,$3,COALESCE($4,'XOF'),COALESCE($5,1),$6,$7,$8,$9,$10)
     ON CONFLICT (reference) DO UPDATE SET libelle=$2, fournisseur_code=$3, devise=COALESCE($4,'XOF'),
       taux_change=COALESCE($5,1), incoterm=$6, conteneur=$7, poids_total=$8, volume_total=$9, commentaire=$10
     RETURNING id`,
    [d.reference, d.libelle || null, d.fournisseur_code || null, d.devise, num(d.taux_change),
      d.incoterm || null, d.conteneur || null, num(d.poids_total), num(d.volume_total), d.commentaire || null]);
  await auditer(req, 'enregistrement', 'dossier', d.reference);
  res.json({ ok: true, id: rows[0].id });
});

r.get('/:id', async (req, res) => {
  const id = req.params.id;
  const { rows: dRows } = await query(
    `SELECT d.*, f.nom AS fournisseur_nom FROM dossiers d
     LEFT JOIN fournisseurs f ON f.code=d.fournisseur_code WHERE d.id=$1`, [id]);
  if (!dRows.length) return res.status(404).json({ erreur: 'Dossier introuvable' });
  const [lignes, pieces, couts, declArts, resultats] = await Promise.all([
    query(`SELECT l.*, a.libelle AS article_libelle FROM dossier_lignes l
           LEFT JOIN articles a ON a.code_interne=l.article_code
           WHERE l.dossier_id=$1 ORDER BY l.rang`, [id]),
    query('SELECT * FROM dossier_pieces WHERE dossier_id=$1 ORDER BY id', [id]),
    query('SELECT * FROM dossier_couts WHERE dossier_id=$1 ORDER BY id', [id]),
    query(`SELECT da.*,
             (SELECT json_agg(t ORDER BY t.id) FROM declaration_taxes t WHERE t.declaration_article_id=da.id) AS taxes
           FROM declaration_articles da WHERE da.dossier_id=$1 ORDER BY da.rang`, [id]),
    query('SELECT * FROM resultats_couts WHERE dossier_id=$1 ORDER BY ligne_id', [id])
  ]);
  res.json({
    ...dRows[0], lignes: lignes.rows, pieces: pieces.rows, couts: couts.rows,
    declaration: declArts.rows, resultats: resultats.rows
  });
});

r.post('/:id/statut', exiger('import'), async (req, res) => {
  const { statut } = req.body || {};
  if (!STATUTS.includes(statut)) return res.status(400).json({ erreur: `Statut invalide. Attendu : ${STATUTS.join(', ')}` });
  const dates = {
    embarque: 'date_embarquement', declare: 'date_declaration',
    receptionne: 'date_reception', cloture: 'date_cloture'
  };
  let sql = 'UPDATE dossiers SET statut=$1';
  if (dates[statut]) sql += `, ${dates[statut]}=COALESCE(${dates[statut]}, CURRENT_DATE)`;
  sql += ' WHERE id=$2';
  await query(sql, [statut, req.params.id]);
  await auditer(req, 'changement_statut', 'dossier', req.params.id, statut);
  res.json({ ok: true });
});

/* ---------------- Lignes de facture ---------------- */
r.post('/:id/lignes', exiger('import'), async (req, res) => {
  const id = req.params.id;
  const l = req.body || {};
  let articleCode = l.article_code || null;
  if (!articleCode && l.code_barres) {
    const { rows } = await query(
      `SELECT code_interne FROM articles WHERE code_barres=$1
       UNION SELECT article_code FROM codes_barres_secondaires WHERE code_barres=$1 LIMIT 1`, [l.code_barres]);
    if (rows.length) articleCode = rows[0].code_interne;
  }
  if (l.id) {
    await query(
      `UPDATE dossier_lignes SET article_code=$1, code_barres=$2, libelle=$3, quantite=$4, nb_cartons=$5,
         prix_unitaire_devise=$6, montant_devise=$7, poids_brut=$8, volume=$9, declaration_rang=$10
       WHERE id=$11 AND dossier_id=$12`,
      [articleCode, l.code_barres || null, l.libelle || null, num(l.quantite) || 0, num(l.nb_cartons),
        num(l.prix_unitaire_devise) || 0,
        num(l.montant_devise) ?? round((num(l.quantite) || 0) * (num(l.prix_unitaire_devise) || 0), 2),
        num(l.poids_brut), num(l.volume), num(l.declaration_rang), l.id, id]);
  } else {
    const { rows: maxR } = await query('SELECT COALESCE(MAX(rang),0)+1 AS r FROM dossier_lignes WHERE dossier_id=$1', [id]);
    await query(
      `INSERT INTO dossier_lignes (dossier_id, rang, article_code, code_barres, libelle, quantite, nb_cartons,
         prix_unitaire_devise, montant_devise, poids_brut, volume, declaration_rang)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, maxR[0].r, articleCode, l.code_barres || null, l.libelle || null, num(l.quantite) || 0,
        num(l.nb_cartons), num(l.prix_unitaire_devise) || 0,
        num(l.montant_devise) ?? round((num(l.quantite) || 0) * (num(l.prix_unitaire_devise) || 0), 2),
        num(l.poids_brut), num(l.volume), num(l.declaration_rang)]);
  }
  res.json({ ok: true, article_code: articleCode });
});

r.delete('/:id/lignes/:ligneId', exiger('import'), async (req, res) => {
  await query('DELETE FROM dossier_lignes WHERE id=$1 AND dossier_id=$2', [req.params.ligneId, req.params.id]);
  res.json({ ok: true });
});

/* Import de facture fournisseur au format tableur, appariement par code barres (F-M4-03).
   Colonnes : code_barres (ou code_interne);libelle;quantite;prix_unitaire;nb_cartons;poids_brut;volume;declaration_rang */
r.post('/:id/lignes-import/csv', exiger('import'), async (req, res) => {
  const id = req.params.id;
  const { contenu, remplacer } = req.body || {};
  if (!contenu) return res.status(400).json({ erreur: 'Contenu CSV requis' });
  if (remplacer) await query('DELETE FROM dossier_lignes WHERE dossier_id=$1', [id]);
  const { records } = parseCsv(contenu);
  let rang = Number((await query('SELECT COALESCE(MAX(rang),0) AS r FROM dossier_lignes WHERE dossier_id=$1', [id])).rows[0].r);
  let importees = 0, appariees = 0; const rejets = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const qte = num(rec.quantite);
    const pu = num(rec.prix_unitaire ?? rec.prix_unitaire_devise);
    if (qte === null || pu === null) { rejets.push({ ligne: i + 2, motif: 'quantité ou prix unitaire manquant' }); continue; }
    let articleCode = null;
    if (rec.code_interne) {
      const { rows } = await query('SELECT code_interne FROM articles WHERE code_interne=$1', [rec.code_interne]);
      if (rows.length) articleCode = rows[0].code_interne;
    }
    if (!articleCode && rec.code_barres) {
      const { rows } = await query(
        `SELECT code_interne FROM articles WHERE code_barres=$1
         UNION SELECT article_code FROM codes_barres_secondaires WHERE code_barres=$1 LIMIT 1`, [rec.code_barres]);
      if (rows.length) articleCode = rows[0].code_interne;
    }
    if (articleCode) appariees++;
    rang++;
    await query(
      `INSERT INTO dossier_lignes (dossier_id, rang, article_code, code_barres, libelle, quantite, nb_cartons,
         prix_unitaire_devise, montant_devise, poids_brut, volume, declaration_rang)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, rang, articleCode, rec.code_barres || null, rec.libelle || null, qte, num(rec.nb_cartons),
        pu, num(rec.montant) ?? round(qte * pu, 2), num(rec.poids_brut), num(rec.volume), num(rec.declaration_rang)]);
    importees++;
  }
  await auditer(req, 'import', 'dossier_lignes', id, `${importees} lignes, ${appariees} appariées`);
  res.json({ importees, appariees, non_appariees: importees - appariees, rejets });
});

/* ---------------- Pièces du dossier (§7.3) ---------------- */
r.post('/:id/pieces', exiger('import'), async (req, res) => {
  const p = req.body || {};
  if (!p.type_piece) return res.status(400).json({ erreur: 'Type de pièce requis' });
  await query(
    `INSERT INTO dossier_pieces (dossier_id, type_piece, reference, date_piece, montant, devise, commentaire)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.params.id, p.type_piece, p.reference || null, p.date_piece || null, num(p.montant), p.devise || null, p.commentaire || null]);
  res.json({ ok: true });
});

r.delete('/:id/pieces/:pieceId', exiger('import'), async (req, res) => {
  await query('DELETE FROM dossier_pieces WHERE id=$1 AND dossier_id=$2', [req.params.pieceId, req.params.id]);
  res.json({ ok: true });
});

/* ---------------- Coûts accessoires ---------------- */
const CLES = ['valeur', 'poids', 'volume', 'unite_payante', 'colis', 'quantite'];
r.post('/:id/couts', exiger('import'), async (req, res) => {
  const c = req.body || {};
  if (num(c.montant) === null) return res.status(400).json({ erreur: 'Montant requis' });
  if (c.cle_repartition && !CLES.includes(c.cle_repartition)) {
    return res.status(400).json({ erreur: `Clé de répartition invalide. Attendu : ${CLES.join(', ')}` });
  }
  if (c.id) {
    await query(
      `UPDATE dossier_couts SET nature=$1, libelle=$2, montant=$3, devise=$4, taux_change=$5,
         cle_repartition=$6, capitalisable=$7, provision=$8 WHERE id=$9 AND dossier_id=$10`,
      [c.nature || 'autre', c.libelle || null, num(c.montant), c.devise || 'XOF', num(c.taux_change) || 1,
        c.cle_repartition || 'valeur', c.capitalisable !== false, !!c.provision, c.id, req.params.id]);
  } else {
    await query(
      `INSERT INTO dossier_couts (dossier_id, nature, libelle, montant, devise, taux_change, cle_repartition, capitalisable, provision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [req.params.id, c.nature || 'autre', c.libelle || null, num(c.montant), c.devise || 'XOF',
        num(c.taux_change) || 1, c.cle_repartition || 'valeur', c.capitalisable !== false, !!c.provision]);
  }
  res.json({ ok: true });
});

r.delete('/:id/couts/:coutId', exiger('import'), async (req, res) => {
  await query('DELETE FROM dossier_couts WHERE id=$1 AND dossier_id=$2', [req.params.coutId, req.params.id]);
  res.json({ ok: true });
});

/* ---------------- Déclaration en douane ---------------- */
r.post('/:id/declaration', exiger('import'), async (req, res) => {
  const a = req.body || {};
  const pos = String(a.position_tarifaire || '').replace(/\D/g, '');
  if (pos.length !== 10) return res.status(400).json({ erreur: 'Position tarifaire à dix chiffres requise' });
  if (a.id) {
    await query(
      `UPDATE declaration_articles SET position_tarifaire=$1, designation=$2, origine=$3, valeur_caf=$4, poids_brut=$5
       WHERE id=$6 AND dossier_id=$7`,
      [pos, a.designation || null, (a.origine || '').toUpperCase() || null, num(a.valeur_caf) || 0, num(a.poids_brut), a.id, req.params.id]);
  } else {
    const { rows: maxR } = await query('SELECT COALESCE(MAX(rang),0)+1 AS r FROM declaration_articles WHERE dossier_id=$1', [req.params.id]);
    await query(
      `INSERT INTO declaration_articles (dossier_id, rang, position_tarifaire, designation, origine, valeur_caf, poids_brut)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.params.id, num(a.rang) || maxR[0].r, pos, a.designation || null,
        (a.origine || '').toUpperCase() || null, num(a.valeur_caf) || 0, num(a.poids_brut)]);
  }
  res.json({ ok: true });
});

r.delete('/:id/declaration/:daId', exiger('import'), async (req, res) => {
  await query('UPDATE dossier_lignes SET declaration_rang=NULL WHERE dossier_id=$1 AND declaration_rang=(SELECT rang FROM declaration_articles WHERE id=$2)', [req.params.id, req.params.daId]);
  await query('DELETE FROM declaration_articles WHERE id=$1 AND dossier_id=$2', [req.params.daId, req.params.id]);
  res.json({ ok: true });
});

/* Import de la déclaration : colonnes rang;position_tarifaire;designation;origine;valeur_caf;poids_brut (F-M4-04) */
r.post('/:id/declaration-import/csv', exiger('import'), async (req, res) => {
  const { contenu, remplacer } = req.body || {};
  if (!contenu) return res.status(400).json({ erreur: 'Contenu CSV requis' });
  if (remplacer) await query('DELETE FROM declaration_articles WHERE dossier_id=$1', [req.params.id]);
  const { records } = parseCsv(contenu);
  let ok = 0; const rejets = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const pos = String(rec.position_tarifaire || rec.position || '').replace(/\D/g, '');
    if (pos.length !== 10) { rejets.push({ ligne: i + 2, motif: 'position tarifaire invalide' }); continue; }
    await query(
      `INSERT INTO declaration_articles (dossier_id, rang, position_tarifaire, designation, origine, valeur_caf, poids_brut)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (dossier_id, rang) DO UPDATE SET position_tarifaire=$3, designation=$4, origine=$5, valeur_caf=$6, poids_brut=$7`,
      [req.params.id, num(rec.rang) || (i + 1), pos, rec.designation || null,
        (rec.origine || '').toUpperCase() || null, num(rec.valeur_caf) || 0, num(rec.poids_brut)]);
    ok++;
  }
  await auditer(req, 'import', 'declaration', req.params.id, `${ok} articles`);
  res.json({ importes: ok, rejets });
});

/* Saisie des montants réellement liquidés — ils priment sur la simulation (F-M2-04) */
r.post('/:id/declaration/:daId/taxes-reelles', exiger('import'), async (req, res) => {
  const { taxes } = req.body || {};
  if (!Array.isArray(taxes)) return res.status(400).json({ erreur: 'Tableau de taxes requis : [{code_taxe, montant}]' });
  for (const t of taxes) {
    if (!t.code_taxe || num(t.montant) === null) continue;
    await query('DELETE FROM declaration_taxes WHERE declaration_article_id=$1 AND code_taxe=$2', [req.params.daId, t.code_taxe]);
    await query(
      `INSERT INTO declaration_taxes (declaration_article_id, code_taxe, base, taux, montant, origine_montant)
       VALUES ($1,$2,$3,$4,$5,'reel')`,
      [req.params.daId, t.code_taxe, num(t.base) || 0, num(t.taux) || 0, num(t.montant)]);
  }
  await auditer(req, 'saisie_liquidation_reelle', 'declaration_article', req.params.daId);
  res.json({ ok: true });
});

/* Liquidation simulée de toute la déclaration (F-M2-03) */
r.post('/:id/liquider', exiger('import'), async (req, res) => {
  const n = await liquiderDeclaration(req.params.id);
  await auditer(req, 'liquidation_simulee', 'dossier', req.params.id, `${n} articles`);
  res.json({ ok: true, articles_liquides: n });
});

/* Rattachement automatique des lignes aux articles de déclaration
   par la position tarifaire de la fiche article (aide au F-M4-04). */
r.post('/:id/rattacher-auto', exiger('import'), async (req, res) => {
  const id = req.params.id;
  const { rows: declArts } = await query('SELECT rang, position_tarifaire FROM declaration_articles WHERE dossier_id=$1', [id]);
  const parPosition = new Map(declArts.map(d => [d.position_tarifaire, d.rang]));
  const { rows: lignes } = await query(
    `SELECT l.id, a.position_tarifaire FROM dossier_lignes l
     JOIN articles a ON a.code_interne=l.article_code
     WHERE l.dossier_id=$1 AND l.declaration_rang IS NULL AND a.position_tarifaire IS NOT NULL`, [id]);
  let rattachees = 0;
  for (const l of lignes) {
    const rang = parPosition.get(l.position_tarifaire);
    if (rang !== undefined) {
      await query('UPDATE dossier_lignes SET declaration_rang=$1 WHERE id=$2', [rang, l.id]);
      rattachees++;
    }
  }
  res.json({ rattachees });
});

/* ---------------- Calcul du coût de revient ---------------- */
r.post('/:id/calculer', exiger('import'), async (req, res) => {
  try {
    const resultat = await calculerDossier(req.params.id);
    // Enrichissement automatique du référentiel article (F-M1-04, FS01)
    const { rows: lignes } = await query(
      `SELECT l.*, a.unites_par_carton AS a_upc, a.poids_brut_carton AS a_pbc, a.volume_carton AS a_vc,
              a.position_tarifaire AS a_pos
         FROM dossier_lignes l JOIN articles a ON a.code_interne=l.article_code
        WHERE l.dossier_id=$1`, [req.params.id]);
    const { rows: declArts } = await query('SELECT rang, position_tarifaire FROM declaration_articles WHERE dossier_id=$1', [req.params.id]);
    const posParRang = new Map(declArts.map(d => [Number(d.rang), d.position_tarifaire]));
    let enrichis = 0;
    for (const l of lignes) {
      const maj = [];
      const params = [];
      if (!l.a_upc && l.nb_cartons && Number(l.nb_cartons) > 0 && Number(l.quantite) > 0) {
        params.push(round(Number(l.quantite) / Number(l.nb_cartons), 0));
        maj.push(`unites_par_carton=$${params.length}`);
      }
      if (!l.a_pbc && l.poids_brut && l.nb_cartons && Number(l.nb_cartons) > 0) {
        params.push(round(Number(l.poids_brut) / Number(l.nb_cartons), 3));
        maj.push(`poids_brut_carton=$${params.length}`);
      }
      if (!l.a_vc && l.volume && l.nb_cartons && Number(l.nb_cartons) > 0) {
        params.push(round(Number(l.volume) / Number(l.nb_cartons), 5));
        maj.push(`volume_carton=$${params.length}`);
      }
      const pos = posParRang.get(Number(l.declaration_rang));
      if (!l.a_pos && pos) {
        params.push(pos);
        maj.push(`position_tarifaire=$${params.length}`);
      }
      if (maj.length) {
        params.push(l.article_code);
        await query(`UPDATE articles SET ${maj.join(', ')}, modifie_le=now() WHERE code_interne=$${params.length}`, params);
        await query(
          `INSERT INTO historique_articles (article_code, champ, nouvelle_valeur, source, auteur)
           VALUES ($1,'enrichissement','depuis dossier ${req.params.id}','dossier',$2)`,
          [l.article_code, req.utilisateur.email]);
        enrichis++;
      }
    }
    await auditer(req, 'calcul_cout', 'dossier', req.params.id,
      `coefficient moyen ${resultat.totaux.coefficient_moyen}`);
    res.json({ ...resultat, articles_enrichis: enrichis });
  } catch (e) {
    res.status(400).json({ erreur: e.message });
  }
});

/* Export des résultats de coût (F-M9-03) */
r.get('/:id/resultats-export/csv', async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, l.rang, l.libelle, l.code_barres FROM resultats_couts r
     JOIN dossier_lignes l ON l.id=r.ligne_id WHERE r.dossier_id=$1 ORDER BY l.rang`, [req.params.id]);
  const data = rows.map(x => ({
    rang: x.rang, article: x.article_code, code_barres: x.code_barres, libelle: x.libelle,
    quantite: x.quantite, prix_achat_total: x.prix_achat_total, cout_total: x.cout_total,
    cout_unitaire: x.cout_unitaire, coefficient: x.coefficient, taux_effectif_pct: x.taux_effectif,
    unite_payante: x.unite_payante, indicateur: x.indicateur_up, tva_creance: x.detail && x.detail.taxes_creance
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cout_revient_dossier_${req.params.id}.csv"`);
  res.send('﻿' + toCsv(data));
});

/* Export des écritures comptables du dossier, esprit SYSCOHADA (UC12, FS04, FS05) */
r.get('/:id/ecritures', async (req, res) => {
  const id = req.params.id;
  const { rows: resultats } = await query('SELECT * FROM resultats_couts WHERE dossier_id=$1', [id]);
  if (!resultats.length) return res.status(400).json({ erreur: 'Calculer le coût de revient avant d’exporter les écritures' });
  const { rows: dRows } = await query('SELECT * FROM dossiers WHERE id=$1', [id]);
  const dossier = dRows[0];
  const { rows: taxes } = await query(
    `SELECT t.code_taxe, ct.libelle, ct.traitement, SUM(t.montant) AS montant
       FROM declaration_taxes t
       JOIN declaration_articles da ON da.id=t.declaration_article_id
       LEFT JOIN codes_taxes ct ON ct.code=t.code_taxe
      WHERE da.dossier_id=$1 GROUP BY t.code_taxe, ct.libelle, ct.traitement ORDER BY t.code_taxe`, [id]);
  const { rows: couts } = await query('SELECT * FROM dossier_couts WHERE dossier_id=$1', [id]);

  const valeurAchat = round(resultats.reduce((s, x) => s + Number(x.prix_achat_total), 0), 0);
  const coutTotal = round(resultats.reduce((s, x) => s + Number(x.cout_total), 0), 0);
  const taxesCout = taxes.filter(t => t.traitement === 'cout');
  const taxesCreance = taxes.filter(t => t.traitement === 'creance');
  const accessoiresCap = couts.filter(c => c.capitalisable)
    .reduce((s, c) => s + Number(c.montant) * Number(c.taux_change || 1), 0);
  const chargesPeriode = couts.filter(c => !c.capitalisable)
    .reduce((s, c) => s + Number(c.montant) * Number(c.taux_change || 1), 0);

  const ecritures = [];
  const push = (compte, libelle, debit, credit) => {
    if (round(debit, 0) === 0 && round(credit, 0) === 0) return;
    ecritures.push({ dossier: dossier.reference, compte, libelle, debit: round(debit, 0), credit: round(credit, 0) });
  };
  push('31', `Stock marchandises — dossier ${dossier.reference}`, coutTotal, 0);
  for (const t of taxesCreance) {
    const compte = t.code_taxe === 'TVA' ? '4452' : '449';
    push(compte, `${t.libelle || t.code_taxe} — créance sur l'État`, Number(t.montant), 0);
  }
  push('6', `Charges de période non capitalisables — dossier ${dossier.reference}`, chargesPeriode, 0);
  push('401', `Fournisseur ${dossier.fournisseur_code || ''} — facture marchandises`, 0, valeurAchat);
  push('401T', 'Transitaire et prestataires — frais accessoires', 0, accessoiresCap + chargesPeriode);
  const totalTaxes = taxes.reduce((s, t) => s + Number(t.montant), 0);
  push('447', 'État — droits et taxes liquidés', 0, totalTaxes);

  // Équilibrage : les taxes d'articles de déclaration sans ligne rattachée ne sont pas
  // capitalisées dans le stock ; elles passent en compte d'attente, à régulariser.
  let totalDebit = ecritures.reduce((s, e) => s + e.debit, 0);
  let totalCredit = ecritures.reduce((s, e) => s + e.credit, 0);
  const ecart = round(totalDebit - totalCredit, 0);
  if (ecart !== 0) push('4718', 'Compte d’attente — écart à régulariser (arrondis, lignes non rattachées)', ecart < 0 ? -ecart : 0, ecart > 0 ? ecart : 0);
  totalDebit = ecritures.reduce((s, e) => s + e.debit, 0);
  totalCredit = ecritures.reduce((s, e) => s + e.credit, 0);

  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ecritures_dossier_${id}.csv"`);
    return res.send('﻿' + toCsv(ecritures));
  }
  res.json({ dossier: dossier.reference, ecritures, total_debit: totalDebit, total_credit: totalCredit });
});

module.exports = r;
