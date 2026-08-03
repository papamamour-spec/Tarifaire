'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query } = require('./db');

const SECRET = process.env.JWT_SECRET || 'tarifaire-dev-secret-changez-moi';
const DUREE = process.env.JWT_DUREE || '12h';

// Hiérarchie simple des rôles (M11) : chaque rôle inclut les droits des rôles inférieurs listés.
const ROLES = ['enqueteur', 'lecture', 'acheteur', 'import', 'comptable', 'controle', 'direction', 'admin'];

function niveau(role) {
  const i = ROLES.indexOf(role);
  return i === -1 ? 0 : i;
}

async function login(req, res) {
  const { email, mot_de_passe } = req.body || {};
  if (!email || !mot_de_passe) return res.status(400).json({ erreur: 'Courriel et mot de passe requis' });
  const { rows } = await query('SELECT * FROM utilisateurs WHERE lower(email)=lower($1) AND actif', [email]);
  if (!rows.length || !bcrypt.compareSync(mot_de_passe, rows[0].mot_de_passe_hash)) {
    return res.status(401).json({ erreur: 'Identifiants invalides' });
  }
  const u = rows[0];
  const token = jwt.sign({ id: u.id, email: u.email, nom: u.nom, role: u.role }, SECRET, { expiresIn: DUREE });
  await query(`INSERT INTO journal_audit (utilisateur, action, objet_type) VALUES ($1,'connexion','session')`, [u.email]);
  res.json({ token, utilisateur: { id: u.id, email: u.email, nom: u.nom, role: u.role } });
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

async function auditer(req, action, objetType, objetId, detail) {
  try {
    await query(
      `INSERT INTO journal_audit (utilisateur, action, objet_type, objet_id, detail) VALUES ($1,$2,$3,$4,$5)`,
      [req.utilisateur ? req.utilisateur.email : 'anonyme', action, objetType,
        objetId !== undefined && objetId !== null ? String(objetId) : null, detail || null]);
  } catch { /* le journal ne doit jamais bloquer l'opération */ }
}

module.exports = { login, authentifier, exiger, auditer, ROLES };
