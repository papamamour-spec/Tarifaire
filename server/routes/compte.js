'use strict';
/* Lot 4 : espace personnel - mot de passe, double authentification TOTP, notifications. */
const express = require('express');
const { query } = require('../db');
const { changerMotDePasse, auditer } = require('../auth');
const { genererSecret, verifierCode, urlOtpauth } = require('../totp');

const r = express.Router();

r.post('/mot-de-passe', (req, res, next) => changerMotDePasse(req, res).catch(next));

/* Préparation de la double authentification : génère le secret, à confirmer par un code. */
r.post('/2fa/preparer', async (req, res) => {
  const secret = genererSecret();
  await query('UPDATE utilisateurs SET totp_secret=$1, totp_actif=FALSE WHERE id=$2', [secret, req.utilisateur.id]);
  res.json({
    secret,
    otpauth: urlOtpauth(secret, req.utilisateur.email),
    aide: 'Saisissez ce secret (ou scannez l’URL otpauth) dans votre application d’authentification, puis confirmez avec un code.'
  });
});

r.post('/2fa/confirmer', async (req, res) => {
  const { code } = req.body || {};
  const { rows } = await query('SELECT totp_secret FROM utilisateurs WHERE id=$1', [req.utilisateur.id]);
  if (!rows.length || !rows[0].totp_secret) return res.status(400).json({ erreur: 'Aucune activation en cours : préparez d’abord la double authentification' });
  if (!verifierCode(rows[0].totp_secret, code)) return res.status(401).json({ erreur: 'Code invalide, réessayez' });
  await query('UPDATE utilisateurs SET totp_actif=TRUE WHERE id=$1', [req.utilisateur.id]);
  await auditer(req, 'activation_2fa', 'utilisateur', req.utilisateur.email);
  res.json({ ok: true });
});

r.post('/2fa/desactiver', async (req, res) => {
  const { code } = req.body || {};
  const { rows } = await query('SELECT totp_secret, totp_actif FROM utilisateurs WHERE id=$1', [req.utilisateur.id]);
  if (rows.length && rows[0].totp_actif && !verifierCode(rows[0].totp_secret, code)) {
    return res.status(401).json({ erreur: 'Code requis pour désactiver la double authentification' });
  }
  await query('UPDATE utilisateurs SET totp_secret=NULL, totp_actif=FALSE WHERE id=$1', [req.utilisateur.id]);
  await auditer(req, 'desactivation_2fa', 'utilisateur', req.utilisateur.email);
  res.json({ ok: true });
});

/* Notifications de l'utilisateur : les siennes et celles adressées à son rôle. */
r.get('/notifications', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM notifications
      WHERE (destinataire_email = $1)
         OR (destinataire_role = $2)
         OR (destinataire_role IS NULL AND destinataire_email IS NULL)
      ORDER BY id DESC LIMIT 100`,
    [req.utilisateur.email, req.utilisateur.role]);
  res.json(rows);
});

r.post('/notifications/:id/lue', async (req, res) => {
  await query('UPDATE notifications SET lue=TRUE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = r;
