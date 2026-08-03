'use strict';
/* Module M11 : administration — utilisateurs, paramètres, journal d'audit, taux de change. */
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { exiger, auditer, ROLES } = require('../auth');
const { num } = require('../util');

const r = express.Router();

r.get('/utilisateurs', exiger('admin'), async (req, res) => {
  const { rows } = await query('SELECT id, email, nom, role, actif, cree_le FROM utilisateurs ORDER BY id');
  res.json(rows);
});

r.post('/utilisateurs', exiger('admin'), async (req, res) => {
  const { email, nom, role, mot_de_passe, actif } = req.body || {};
  if (!email || !nom) return res.status(400).json({ erreur: 'Courriel et nom requis' });
  if (role && !ROLES.includes(role)) return res.status(400).json({ erreur: `Rôle invalide. Attendu : ${ROLES.join(', ')}` });
  const { rows: existant } = await query('SELECT id FROM utilisateurs WHERE lower(email)=lower($1)', [email]);
  if (existant.length) {
    const sets = ['nom=$2', 'role=COALESCE($3, role)', 'actif=COALESCE($4, actif)'];
    const params = [email, nom, role || null, typeof actif === 'boolean' ? actif : null];
    if (mot_de_passe) { params.push(bcrypt.hashSync(mot_de_passe, 10)); sets.push(`mot_de_passe_hash=$${params.length}`); }
    await query(`UPDATE utilisateurs SET ${sets.join(', ')} WHERE lower(email)=lower($1)`, params);
    await auditer(req, 'modification', 'utilisateur', email);
    return res.json({ ok: true, action: 'modifie' });
  }
  if (!mot_de_passe) return res.status(400).json({ erreur: 'Mot de passe requis pour un nouvel utilisateur' });
  await query(
    `INSERT INTO utilisateurs (email, mot_de_passe_hash, nom, role) VALUES ($1,$2,$3,$4)`,
    [email, bcrypt.hashSync(mot_de_passe, 10), nom, role || 'lecture']);
  await auditer(req, 'creation', 'utilisateur', email);
  res.json({ ok: true, action: 'cree' });
});

r.get('/parametres', exiger('admin'), async (req, res) => {
  const { rows } = await query('SELECT * FROM parametres ORDER BY cle');
  res.json(rows);
});

r.post('/parametres', exiger('admin'), async (req, res) => {
  const { cle, valeur } = req.body || {};
  if (!cle) return res.status(400).json({ erreur: 'Clé requise' });
  await query(
    `INSERT INTO parametres (cle, valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur=$2`,
    [cle, String(valeur ?? '')]);
  await auditer(req, 'parametre', 'parametres', cle, String(valeur ?? ''));
  res.json({ ok: true });
});

r.get('/journal', exiger('comptable'), async (req, res) => {
  const { rows } = await query('SELECT * FROM journal_audit ORDER BY id DESC LIMIT 300');
  res.json(rows);
});

/* Lot 1 — Vérification d'intégrité du journal chaîné (F-M11-05) */
r.get('/journal-verification', exiger('comptable'), async (req, res) => {
  const { verifierJournal } = require('../auth');
  res.json(await verifierJournal());
});

/*
 * F-M11-09 et F-NF-06 : export complet des données dans un format ouvert (réversibilité).
 * Toutes les tables métier en JSON, hors contenus binaires et secrets.
 */
r.get('/export-complet', exiger('admin'), async (req, res) => {
  const tables = ['familles', 'fournisseurs', 'articles', 'codes_barres_secondaires', 'articles_lies',
    'conditions_achat', 'positions_tarifaires', 'codes_taxes', 'exonerations', 'taux_change',
    'dossiers', 'dossier_pieces', 'dossier_lignes', 'declaration_articles', 'declaration_taxes',
    'dossier_couts', 'resultats_couts', 'revisions_cout', 'baremes_provision',
    'formats_magasin', 'points_de_vente', 'politiques_tarifaires', 'regles_validation', 'tarifs',
    'promotions', 'enseignes_concurrentes', 'releves_concurrents', 'ventes', 'parametres',
    'historique_articles', 'journal_audit'];
  const exportation = { genere_le: new Date().toISOString(), application: 'tarifaire', tables: {} };
  for (const table of tables) {
    const { rows } = await query(`SELECT * FROM ${table}`);
    exportation.tables[table] = rows;
  }
  await auditer(req, 'export_complet', 'base', null, `${tables.length} tables`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="export_tarifaire_complet.json"`);
  res.json(exportation);
});

/* Table des cours de change (M2 — table des cours, FE09) */
r.get('/taux-change', async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT ON (devise) * FROM taux_change ORDER BY devise, date_cours DESC`);
  res.json(rows);
});

r.post('/taux-change', exiger('comptable'), async (req, res) => {
  const { devise, cours, date_cours, source } = req.body || {};
  if (!devise || num(cours) === null) return res.status(400).json({ erreur: 'Devise et cours requis' });
  await query(
    `INSERT INTO taux_change (devise, date_cours, cours, source)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4)
     ON CONFLICT (devise, date_cours) DO UPDATE SET cours=$3, source=$4`,
    [devise.toUpperCase(), date_cours || null, num(cours), source || null]);
  res.json({ ok: true });
});

module.exports = r;
