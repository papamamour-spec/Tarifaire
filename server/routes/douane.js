'use strict';
/* Module M2 : référentiel douanier et fiscal, moteur de liquidation, simulateur. */
const express = require('express');
const { query } = require('../db');
const { exiger, auditer } = require('../auth');
const { parseCsv, num } = require('../util');
const { liquider } = require('../services/liquidation');

const r = express.Router();

/* ---------------- Positions tarifaires (nomenclature TEC UEMOA) ---------------- */
r.get('/positions', async (req, res) => {
  const { q } = req.query;
  const params = [];
  let sql = `SELECT DISTINCT ON (code) * FROM positions_tarifaires`;
  if (q) { params.push('%' + q.toLowerCase() + '%'); sql += ` WHERE code LIKE $1 OR lower(libelle) LIKE $1`; }
  sql += ' ORDER BY code, date_effet DESC LIMIT 300';
  const { rows } = await query(sql, params);
  res.json(rows);
});

r.post('/positions', exiger('import'), async (req, res) => {
  const { code, libelle, categorie, taux_dd, date_effet } = req.body;
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 10) return res.status(400).json({ erreur: 'La position tarifaire doit comporter dix chiffres' });
  if (!libelle) return res.status(400).json({ erreur: 'Libellé requis' });
  await query(
    `INSERT INTO positions_tarifaires (code, date_effet, libelle, categorie, taux_dd)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5)
     ON CONFLICT (code, date_effet) DO UPDATE SET libelle=$3, categorie=$4, taux_dd=$5`,
    [c, date_effet || null, libelle, categorie || null, num(taux_dd) || 0]);
  await auditer(req, 'enregistrement', 'position_tarifaire', c);
  res.json({ ok: true });
});

/* Import de la nomenclature (F-M2-08) : colonnes code;libelle;categorie;taux_dd */
r.post('/positions-import/csv', exiger('import'), async (req, res) => {
  const { contenu } = req.body || {};
  if (!contenu) return res.status(400).json({ erreur: 'Contenu CSV requis' });
  const { records } = parseCsv(contenu);
  let ok = 0; const rejets = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const code = String(rec.code || rec.position || '').replace(/\D/g, '');
    if (code.length !== 10 || !rec.libelle) { rejets.push({ ligne: i + 2, motif: 'code (10 chiffres) ou libellé invalide' }); continue; }
    await query(
      `INSERT INTO positions_tarifaires (code, libelle, categorie, taux_dd)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (code, date_effet) DO UPDATE SET libelle=$2, categorie=$3, taux_dd=$4`,
      [code, rec.libelle, rec.categorie || null, num(rec.taux_dd) || 0]);
    ok++;
  }
  await auditer(req, 'import', 'positions_tarifaires', null, `${ok} lignes`);
  res.json({ importes: ok, rejets });
});

/* ---------------- Codes taxes paramétrables (F-M2-02) ---------------- */
r.get('/taxes', async (req, res) => {
  const { rows } = await query('SELECT * FROM codes_taxes ORDER BY ordre');
  res.json(rows);
});

r.post('/taxes', exiger('admin'), async (req, res) => {
  const { code, libelle, ordre, taux, taux_depuis_position, base_composants, traitement, actif } = req.body;
  if (!code || !libelle) return res.status(400).json({ erreur: 'Code et libellé requis' });
  if (!['cout', 'creance'].includes(traitement)) {
    return res.status(400).json({ erreur: "Le traitement doit être 'cout' (incorporé au stock) ou 'creance' (créance sur l'État)" });
  }
  await query(
    `INSERT INTO codes_taxes (code, libelle, ordre, taux, taux_depuis_position, base_composants, traitement, actif)
     VALUES ($1,$2,$3,$4,COALESCE($5,FALSE),$6,$7,COALESCE($8,TRUE))
     ON CONFLICT (code) DO UPDATE SET libelle=$2, ordre=$3, taux=$4, taux_depuis_position=COALESCE($5,FALSE),
       base_composants=$6, traitement=$7, actif=COALESCE($8,TRUE)`,
    [code.toUpperCase(), libelle, num(ordre) || 99, num(taux), taux_depuis_position,
      base_composants || 'VD', traitement, actif]);
  await auditer(req, 'enregistrement', 'code_taxe', code, `traitement=${traitement}`);
  res.json({ ok: true });
});

/* ---------------- Exonérations (F-M2-06) ---------------- */
r.get('/exonerations', async (req, res) => {
  const { rows } = await query('SELECT * FROM exonerations ORDER BY id');
  res.json(rows);
});

r.post('/exonerations', exiger('admin'), async (req, res) => {
  const { position_prefixe, origine, code_taxe, taux_applique, commentaire } = req.body;
  if (!code_taxe) return res.status(400).json({ erreur: 'Code taxe requis' });
  await query(
    `INSERT INTO exonerations (position_prefixe, origine, code_taxe, taux_applique, commentaire)
     VALUES ($1,$2,$3,$4,$5)`,
    [position_prefixe || '', (origine || '').toUpperCase(), code_taxe, num(taux_applique) || 0, commentaire || null]);
  await auditer(req, 'creation', 'exoneration', code_taxe);
  res.json({ ok: true });
});

r.delete('/exonerations/:id', exiger('admin'), async (req, res) => {
  await query('DELETE FROM exonerations WHERE id=$1', [req.params.id]);
  await auditer(req, 'suppression', 'exoneration', req.params.id);
  res.json({ ok: true });
});

/* ---------------- Simulateur de liquidation (F-M2-03) ---------------- */
r.post('/simulation', async (req, res) => {
  const { valeur_en_douane, position_tarifaire, origine, date } = req.body || {};
  if (num(valeur_en_douane) === null) return res.status(400).json({ erreur: 'Valeur en douane requise' });
  const resultat = await liquider({
    valeurEnDouane: num(valeur_en_douane),
    positionCode: position_tarifaire,
    origine,
    date: date || null
  });
  res.json(resultat);
});

/* Divergences entre taux constaté et taux simulé par position (F-M2-09) */
r.get('/divergences', async (req, res) => {
  const { rows } = await query(
    `SELECT a.position_tarifaire, COUNT(*) AS nb_articles,
            AVG(a.taux_effectif_constate) AS taux_constate_moyen
       FROM articles a
      WHERE a.taux_effectif_constate IS NOT NULL AND a.position_tarifaire IS NOT NULL
      GROUP BY a.position_tarifaire ORDER BY a.position_tarifaire`);
  const sortie = [];
  for (const row of rows) {
    const sim = await liquider({ valeurEnDouane: 100000, positionCode: row.position_tarifaire, origine: null });
    const simule = sim.taux_effectif;
    const constate = Number(row.taux_constate_moyen);
    sortie.push({
      position_tarifaire: row.position_tarifaire,
      nb_articles: Number(row.nb_articles),
      taux_simule: simule,
      taux_constate_moyen: Math.round(constate * 100) / 100,
      ecart: simule !== null ? Math.round((constate - simule) * 100) / 100 : null
    });
  }
  res.json(sortie.filter(s => s.ecart !== null && Math.abs(s.ecart) > 1));
});

module.exports = r;
