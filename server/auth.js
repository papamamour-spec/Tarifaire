'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query } = require('./db');
const { verifierCode } = require('./totp');

const SECRET = process.env.JWT_SECRET || 'tarifaire-dev-secret-changez-moi';
const DUREE = process.env.JWT_DUREE || '12h';
const MAX_ECHECS = 5;
const VERROU_MINUTES = 15;

// Hiérarchie simple des rôles (M11) : chaque rôle inclut les droits des rôles inférieurs listés.
const ROLES = ['enqueteur', 'lecture', 'acheteur', 'import', 'comptable', 'controle', 'direction', 'admin'];

function niveau(role) {
  const i = ROLES.indexOf(role);
  return i === -1 ? 0 : i;
}

async function login(req, res) {
  const { email, mot_de_passe, code_2fa } = req.body || {};
  if (!email || !mot_de_passe) return res.status(400).json({ erreur: 'Courriel et mot de passe requis' });
  const { rows } = await query('SELECT * FROM utilisateurs WHERE lower(email)=lower($1) AND actif', [email]);
  const u = rows[0];

  if (u && u.verrou_jusqua && new Date(u.verrou_jusqua) > new Date()) {
    return res.status(423).json({ erreur: `Compte verrouillé après ${MAX_ECHECS} échecs. Réessayez dans quelques minutes.` });
  }

  if (!u || !bcrypt.compareSync(mot_de_passe, u.mot_de_passe_hash)) {
    if (u) {
      const echecs = (u.echecs_connexion || 0) + 1;
      await query(
        `UPDATE utilisateurs SET echecs_connexion=$1::int,
           verrou_jusqua = CASE WHEN $1::int >= $2::int THEN now() + interval '${VERROU_MINUTES} minutes' ELSE verrou_jusqua END
         WHERE id=$3`, [echecs, MAX_ECHECS, u.id]);
      if (echecs >= MAX_ECHECS) await journaliser(u.email, 'verrouillage_compte', 'session', null, `${echecs} échecs`);
    }
    return res.status(401).json({ erreur: 'Identifiants invalides' });
  }

  // Double authentification si activée sur le compte (F-M11-03)
  if (u.totp_actif) {
    if (!code_2fa) return res.status(428).json({ erreur: 'Code de double authentification requis', exige_2fa: true });
    if (!verifierCode(u.totp_secret, code_2fa)) {
      await journaliser(u.email, 'echec_2fa', 'session');
      return res.status(401).json({ erreur: 'Code de double authentification invalide' });
    }
  }

  await query('UPDATE utilisateurs SET echecs_connexion=0, verrou_jusqua=NULL WHERE id=$1', [u.id]);
  const token = jwt.sign({ id: u.id, email: u.email, nom: u.nom, role: u.role }, SECRET, { expiresIn: DUREE });
  await journaliser(u.email, 'connexion', 'session');
  res.json({
    token,
    utilisateur: { id: u.id, email: u.email, nom: u.nom, role: u.role, doit_changer_mdp: u.doit_changer_mdp, totp_actif: u.totp_actif }
  });
}

async function changerMotDePasse(req, res) {
  const { ancien, nouveau } = req.body || {};
  if (!ancien || !nouveau) return res.status(400).json({ erreur: 'Ancien et nouveau mot de passe requis' });
  if (String(nouveau).length < 10) return res.status(400).json({ erreur: 'Le nouveau mot de passe doit comporter au moins 10 caractères' });
  const { rows } = await query('SELECT * FROM utilisateurs WHERE id=$1', [req.utilisateur.id]);
  if (!rows.length || !bcrypt.compareSync(ancien, rows[0].mot_de_passe_hash)) {
    return res.status(401).json({ erreur: 'Ancien mot de passe incorrect' });
  }
  await query('UPDATE utilisateurs SET mot_de_passe_hash=$1, doit_changer_mdp=FALSE WHERE id=$2',
    [bcrypt.hashSync(nouveau, 10), req.utilisateur.id]);
  await journaliser(req.utilisateur.email, 'changement_mot_de_passe', 'utilisateur', req.utilisateur.email);
  res.json({ ok: true });
}

function authentifier(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ erreur: 'Authentification requise' });
  try {
    req.utilisateur = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ erreur: 'Session expirée, reconnectez-vous' });
  }
}

// Middleware d'exigence de rôle minimal.
function exiger(roleMin) {
  return (req, res, next) => {
    if (!req.utilisateur) return res.status(401).json({ erreur: 'Authentification requise' });
    if (req.utilisateur.role === 'admin' || niveau(req.utilisateur.role) >= niveau(roleMin)) return next();
    res.status(403).json({ erreur: 'Droits insuffisants pour cette opération' });
  };
}

/*
 * Journal d'audit chaîné (F-M11-05) : chaque entrée porte le hachage de la précédente
 * et son propre hachage SHA-256 calculé sur son contenu ; toute altération, suppression
 * ou réordonnancement rompt la chaîne, ce qui est vérifiable a posteriori.
 */
function empreinteEntree(hashPrecedent, utilisateur, action, objetType, objetId, detail) {
  return crypto.createHash('sha256')
    .update([hashPrecedent, utilisateur || 'anonyme', action, objetType,
      objetId !== undefined && objetId !== null ? String(objetId) : '', detail || ''].join('|'))
    .digest('hex');
}

async function journaliser(utilisateur, action, objetType, objetId, detail) {
  try {
    const { rows: prev } = await query('SELECT hash FROM journal_audit ORDER BY id DESC LIMIT 1');
    const hashPrecedent = prev.length && prev[0].hash ? prev[0].hash : 'GENESE';
    const empreinte = empreinteEntree(hashPrecedent, utilisateur, action, objetType, objetId, detail);
    await query(
      `INSERT INTO journal_audit (utilisateur, action, objet_type, objet_id, detail, hash_precedent, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [utilisateur || 'anonyme', action, objetType,
        objetId !== undefined && objetId !== null ? String(objetId) : null, detail || null, hashPrecedent, empreinte]);
  } catch { /* le journal ne doit jamais bloquer l'opération */ }
}

async function auditer(req, action, objetType, objetId, detail) {
  return journaliser(req.utilisateur ? req.utilisateur.email : 'anonyme', action, objetType, objetId, detail);
}

/* Vérifie l'intégrité de la chaîne du journal ; retourne la première rupture éventuelle. */
async function verifierJournal() {
  const { rows } = await query('SELECT * FROM journal_audit WHERE hash IS NOT NULL ORDER BY id');
  let precedent = 'GENESE';
  for (const e of rows) {
    if (e.hash_precedent !== precedent) return { integre: false, rupture_id: e.id, motif: 'chaînage rompu (entrée supprimée ou réordonnée)' };
    const attendu = empreinteEntree(e.hash_precedent, e.utilisateur, e.action, e.objet_type, e.objet_id, e.detail);
    if (attendu !== e.hash) return { integre: false, rupture_id: e.id, motif: 'contenu modifié après enregistrement' };
    precedent = e.hash;
  }
  return { integre: true, entrees_verifiees: rows.length };
}

module.exports = { login, changerMotDePasse, authentifier, exiger, auditer, journaliser, verifierJournal, ROLES };
