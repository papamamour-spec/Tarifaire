'use strict';
/* Modules M4 (dossiers d'importation) et M5 (moteur de coût de revient). */
const express = require('express');
const { query, transaction } = require('../db');
const { exiger, auditer } = require('../auth');
const { parseCsv, toCsv, num, round } = require('../util');
const { liquiderDeclaration } = require('../services/liquidation');
const { calculerDossier } = require('../services/cout');
const { apprendreBaremes, proposerProvisions } = require('../services/baremes');
const { notifier } = require('../services/notifications');

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
    query(`SELECT p.*, EXISTS (SELECT 1 FROM pieces_fichiers pf WHERE pf.piece_id=p.id) AS a_fichier
           FROM dossier_pieces p WHERE p.dossier_id=$1 ORDER BY p.id`, [id]),
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
  // À la clôture, les coûts constatés alimentent les barèmes de provision (F-M5-07)
  let baremesAppris = 0;
  if (statut === 'cloture') baremesAppris = await apprendreBaremes(req.params.id);
  res.json({ ok: true, baremes_appris: baremesAppris });
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
  const { records } = parseCsv(contenu);

  // Appariement en deux requêtes globales plutôt qu'une par ligne
  const codesInternes = [...new Set(records.map(x => x.code_interne).filter(Boolean))];
  const codesBarres = [...new Set(records.map(x => x.code_barres).filter(Boolean))];
  const parCodeInterne = new Set(
    codesInternes.length
      ? (await query('SELECT code_interne FROM articles WHERE code_interne = ANY($1)', [codesInternes])).rows.map(x => x.code_interne)
      : []);
  const parCodeBarres = new Map(
    codesBarres.length
      ? (await query(
          `SELECT code_barres, code_interne FROM articles WHERE code_barres = ANY($1)
           UNION SELECT code_barres, article_code FROM codes_barres_secondaires WHERE code_barres = ANY($1)`,
          [codesBarres])).rows.map(x => [x.code_barres, x.code_interne])
      : []);

  const rejets = [];
  const valides = [];
  records.forEach((rec, i) => {
    const qte = num(rec.quantite);
    const pu = num(rec.prix_unitaire ?? rec.prix_unitaire_devise);
    if (qte === null || pu === null) { rejets.push({ ligne: i + 2, motif: 'quantité ou prix unitaire manquant' }); return; }
    let articleCode = null;
    if (rec.code_interne && parCodeInterne.has(rec.code_interne)) articleCode = rec.code_interne;
    if (!articleCode && rec.code_barres) articleCode = parCodeBarres.get(rec.code_barres) || null;
    valides.push({
      article_code: articleCode, code_barres: rec.code_barres || null, libelle: rec.libelle || null,
      quantite: qte, nb_cartons: num(rec.nb_cartons), prix_unitaire_devise: pu,
      montant_devise: num(rec.montant) ?? round(qte * pu, 2),
      poids_brut: num(rec.poids_brut), volume: num(rec.volume), declaration_rang: num(rec.declaration_rang)
    });
  });

  // Écriture atomique par lot : un import interrompu ne laisse aucun état partiel
  await transaction(async q => {
    if (remplacer) await q('DELETE FROM dossier_lignes WHERE dossier_id=$1', [id]);
    const { rows: maxR } = await q('SELECT COALESCE(MAX(rang),0) AS r FROM dossier_lignes WHERE dossier_id=$1', [id]);
    const base = Number(maxR[0].r);
    const avecRang = valides.map((v, i) => ({ ...v, rang: base + i + 1 }));
    await q(
      `INSERT INTO dossier_lignes (dossier_id, rang, article_code, code_barres, libelle, quantite, nb_cartons,
         prix_unitaire_devise, montant_devise, poids_brut, volume, declaration_rang)
       SELECT $1, x.rang, x.article_code, x.code_barres, x.libelle, x.quantite, x.nb_cartons,
              x.prix_unitaire_devise, x.montant_devise, x.poids_brut, x.volume, x.declaration_rang
         FROM jsonb_to_recordset($2::jsonb) AS x(rang int, article_code text, code_barres text,
              libelle text, quantite numeric, nb_cartons numeric, prix_unitaire_devise numeric,
              montant_devise numeric, poids_brut numeric, volume numeric, declaration_rang int)`,
      [id, JSON.stringify(avecRang)]);
  });

  const appariees = valides.filter(v => v.article_code).length;
  await auditer(req, 'import', 'dossier_lignes', id, `${valides.length} lignes, ${appariees} appariées`);
  res.json({ importees: valides.length, appariees, non_appariees: valides.length - appariees, rejets });
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

/*
 * Lot 2 — Révision après facture tardive (UC10, F-M5-08).
 * À appeler après avoir ajouté le coût tardif : recalcule le dossier, compare aux coûts
 * précédents, ventile l'ajustement entre stock restant (ajustement de stock) et quantités
 * vendues (charge), et alerte sur les tarifs publiés passés sous le plancher de marge.
 * Corps : { stocks: [{article_code, stock_restant}] } ; défaut : tout le stock restant.
 */
r.post('/:id/reviser', exiger('import'), async (req, res) => {
  const id = req.params.id;
  const stocksSaisis = new Map(((req.body || {}).stocks || []).map(s => [s.article_code, num(s.stock_restant)]));

  const { rows: avant } = await query('SELECT * FROM resultats_couts WHERE dossier_id=$1', [id]);
  if (!avant.length) return res.status(400).json({ erreur: 'Aucun calcul précédent : utilisez « Calculer » pour un premier calcul' });
  const anciens = new Map(avant.map(x => [x.ligne_id, x]));

  let resultat;
  try { resultat = await calculerDossier(id); }
  catch (e) { return res.status(400).json({ erreur: e.message }); }

  const revisions = [];
  await transaction(async q => {
    for (const ligne of resultat.lignes) {
      const ancien = anciens.get(ligne.ligne_id);
      if (!ancien) continue;
      const ancienUnitaire = Number(ancien.cout_unitaire);
      const delta = round(ligne.cout_unitaire - ancienUnitaire, 4);
      if (Math.abs(delta) < 0.005) continue;
      const stockRestant = stocksSaisis.has(ligne.article_code)
        ? Math.min(stocksSaisis.get(ligne.article_code) || 0, ligne.quantite)
        : ligne.quantite;
      const ajustementStock = round(delta * stockRestant, 0);
      const ajustementCharge = round(delta * (ligne.quantite - stockRestant), 0);
      await q(
        `INSERT INTO revisions_cout (dossier_id, article_code, quantite, stock_restant,
           cout_unitaire_avant, cout_unitaire_apres, ajustement_stock, ajustement_charge)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, ligne.article_code, ligne.quantite, stockRestant, ancienUnitaire, ligne.cout_unitaire,
          ajustementStock, ajustementCharge]);
      revisions.push({
        article_code: ligne.article_code, quantite: ligne.quantite, stock_restant: stockRestant,
        cout_unitaire_avant: ancienUnitaire, cout_unitaire_apres: ligne.cout_unitaire,
        delta_unitaire: delta, ajustement_stock: ajustementStock, ajustement_charge: ajustementCharge
      });
    }
    await q(`UPDATE dossiers SET statut='revise' WHERE id=$1`, [id]);
  });

  // Alerte sur les tarifs publiés dont la marge passe sous le plancher avec le nouveau coût
  const alertesPrix = [];
  for (const rev of revisions.filter(x => x.delta_unitaire > 0 && x.article_code)) {
    const { rows: tarifs } = await query(
      `SELECT t.*, a.taux_tva_vente FROM tarifs t JOIN articles a ON a.code_interne=t.article_code
        WHERE t.article_code=$1 AND t.statut='publie'`, [rev.article_code]);
    for (const t of tarifs) {
      const ht = Number(t.prix_ttc) / (1 + Number(t.taux_tva_vente) / 100);
      const nouvelleMarge = ht > 0 ? round((ht - rev.cout_unitaire_apres) / ht * 100, 2) : null;
      if (nouvelleMarge !== null && nouvelleMarge < 5) {
        alertesPrix.push({
          article_code: rev.article_code, format_code: t.format_code, prix_ttc: Number(t.prix_ttc),
          taux_marque_apres_revision: nouvelleMarge
        });
      }
    }
  }
  if (alertesPrix.length) {
    await notifier({
      role: 'direction',
      titre: `Révision du dossier ${id} : ${alertesPrix.length} tarif(s) sous le plancher de marge`,
      corps: alertesPrix.map(a => `${a.article_code} (${a.format_code}) : taux de marque ${a.taux_marque_apres_revision} % au prix actuel de ${a.prix_ttc} F`).join('\n'),
      lien: '#/tarification'
    });
  }
  await auditer(req, 'revision_cout', 'dossier', id, `${revisions.length} référence(s) révisée(s), ${alertesPrix.length} alerte(s) prix`);
  res.json({ revisions, alertes_prix: alertesPrix, totaux: resultat.totaux });
});

/* Lot 2 — Provisions proposées depuis les barèmes appris (F-M5-07) */
r.get('/:id/provisions-proposees', async (req, res) => {
  res.json(await proposerProvisions(req.params.id));
});

r.post('/:id/provisions-appliquer', exiger('import'), async (req, res) => {
  const propositions = await proposerProvisions(req.params.id);
  let creees = 0;
  for (const p of propositions) {
    await query(
      `INSERT INTO dossier_couts (dossier_id, nature, libelle, montant, devise, taux_change, cle_repartition, capitalisable, provision)
       VALUES ($1,$2,$3,$4,'XOF',1,$5,TRUE,TRUE)`,
      [req.params.id, p.nature, `Provision ${p.nature} (barème sur ${p.nb_dossiers_appris} dossier(s))`,
        p.montant_propose, p.cle_repartition]);
    creees++;
  }
  await auditer(req, 'provisions_appliquees', 'dossier', req.params.id, `${creees} provision(s)`);
  res.json({ ok: true, creees });
});

/* Lot 2 — Historique des révisions */
r.get('/:id/revisions', async (req, res) => {
  const { rows } = await query('SELECT * FROM revisions_cout WHERE dossier_id=$1 ORDER BY id DESC', [req.params.id]);
  res.json(rows);
});

/* Lot 3 — Fichier numérisé d'une pièce (F-M4-02) : téléversement et téléchargement */
r.put('/:id/pieces/:pieceId/fichier', exiger('import'), express.raw({ type: '*/*', limit: '8mb' }), async (req, res) => {
  const { rows: piece } = await query(
    'SELECT id FROM dossier_pieces WHERE id=$1 AND dossier_id=$2', [req.params.pieceId, req.params.id]);
  if (!piece.length) return res.status(404).json({ erreur: 'Pièce introuvable' });
  if (!req.body || !req.body.length) return res.status(400).json({ erreur: 'Fichier vide' });
  const nom = decodeURIComponent(req.headers['x-nom-fichier'] || 'document');
  const type = req.headers['content-type'] || 'application/octet-stream';
  await query('DELETE FROM pieces_fichiers WHERE piece_id=$1', [req.params.pieceId]);
  await query(
    `INSERT INTO pieces_fichiers (piece_id, nom_fichier, type_mime, taille, contenu) VALUES ($1,$2,$3,$4,$5)`,
    [req.params.pieceId, nom, type, req.body.length, req.body]);
  await auditer(req, 'televersement', 'piece', req.params.pieceId, `${nom} (${req.body.length} octets)`);
  res.json({ ok: true, nom, taille: req.body.length });
});

r.get('/:id/pieces/:pieceId/fichier', async (req, res) => {
  const { rows } = await query(
    `SELECT pf.* FROM pieces_fichiers pf JOIN dossier_pieces p ON p.id=pf.piece_id
      WHERE pf.piece_id=$1 AND p.dossier_id=$2`, [req.params.pieceId, req.params.id]);
  if (!rows.length) return res.status(404).json({ erreur: 'Aucun fichier pour cette pièce' });
  res.setHeader('Content-Type', rows[0].type_mime);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(rows[0].nom_fichier)}"`);
  res.send(rows[0].contenu);
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
