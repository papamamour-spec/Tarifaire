'use strict';
/*
 * Lot 3 : notifications applicatives (F-M9-04) avec envoi courriel facultatif.
 * L'envoi courriel utilise l'API Resend si RESEND_API_KEY est définie
 * (COURRIEL_EXPEDITEUR pour l'adresse d'envoi) ; sinon la notification reste in-app.
 */
const { query } = require('../db');

async function notifier({ role, email, titre, corps, lien }) {
  const { rows } = await query(
    `INSERT INTO notifications (destinataire_role, destinataire_email, titre, corps, lien)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [role || null, email || null, titre, corps || null, lien || null]);
  const id = rows[0].id;
  envoyerCourriel({ role, email, titre, corps }).then(ok => {
    if (ok) query('UPDATE notifications SET envoyee_courriel=TRUE WHERE id=$1', [id]).catch(() => {});
  }).catch(() => {});
  return id;
}

async function envoyerCourriel({ role, email, titre, corps }) {
  if (!process.env.RESEND_API_KEY) return false;
  let destinataires = [];
  if (email) destinataires = [email];
  else if (role) {
    const { rows } = await query('SELECT email FROM utilisateurs WHERE role=$1 AND actif', [role]);
    destinataires = rows.map(r => r.email);
  }
  if (!destinataires.length) return false;
  try {
    const rep = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.COURRIEL_EXPEDITEUR || 'Tarifaire <onboarding@resend.dev>',
        to: destinataires,
        subject: `[Tarifaire] ${titre}`,
        text: corps || titre
      })
    });
    return rep.ok;
  } catch (e) {
    console.warn('[courriel] échec d’envoi :', e.message);
    return false;
  }
}

module.exports = { notifier };
