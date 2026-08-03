'use strict';
/*
 * Tarifaire — plateforme de gestion du prix de revient et de la politique tarifaire
 * (commerce de détail, Sénégal / UEMOA). Point d'entrée du serveur.
 */
const path = require('path');
const express = require('express');
const { init } = require('./db');
const { login, authentifier } = require('./auth');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));

// Fichiers statiques de l'application web
app.use(express.static(path.join(__dirname, '..', 'public')));

// État d'initialisation de la base (le serveur écoute avant que la base soit prête,
// afin que le healthcheck Railway passe pendant le provisionnement de PostgreSQL).
let basePrete = false;
let erreurBase = null;

// Sonde de disponibilité (supervision Railway)
app.get('/api/sante', (req, res) => res.json({
  ok: true, application: 'tarifaire', version: '1.0.0',
  base: basePrete ? 'connectee' : 'en_attente',
  ...(erreurBase && !basePrete ? { detail: erreurBase } : {})
}));

// Tant que la base n'est pas prête, les routes métier répondent 503 avec le motif.
app.use('/api', (req, res, next) => {
  if (basePrete || req.path === '/sante') return next();
  res.status(503).json({
    erreur: 'Base de données non disponible' + (erreurBase ? ' : ' + erreurBase : ''),
    aide: 'Vérifiez que le service PostgreSQL est créé et que la variable DATABASE_URL est définie sur le service applicatif.'
  });
});

app.post('/api/connexion', (req, res, next) => login(req, res).catch(next));

// Toutes les autres routes API exigent un jeton (F-M10-02)
app.use('/api', authentifier);

app.use('/api/referentiels', require('./routes/referentiels'));
app.use('/api/douane', require('./routes/douane'));
app.use('/api/dossiers', require('./routes/dossiers'));
app.use('/api/tarification', require('./routes/tarification'));
app.use('/api/veille', require('./routes/veille'));
app.use('/api/pilotage', require('./routes/pilotage'));
app.use('/api/admin', require('./routes/admin'));

// L'application web gère ses propres vues : toute autre route sert la page unique
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Gestion centralisée des erreurs
app.use((err, req, res, _next) => {
  console.error('[erreur]', err);
  res.status(500).json({ erreur: 'Erreur interne du serveur', detail: err.message });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`Tarifaire à l'écoute sur le port ${PORT} (initialisation de la base en cours…)`));

// Initialisation de la base en arrière-plan, avec réessais permanents :
// le service reste joignable et explique ce qui manque au lieu de s'arrêter.
(async function initialiser() {
  for (;;) {
    try {
      await init();
      basePrete = true;
      erreurBase = null;
      console.log('Base de données prête : schéma migré et amorcé.');
      return;
    } catch (err) {
      erreurBase = err.message;
      console.error('Échec d’initialisation de la base de données :', err.message, '— nouvel essai dans 10 s');
      await new Promise(r => setTimeout(r, 10000));
    }
  }
})();
