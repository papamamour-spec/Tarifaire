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

// Sonde de disponibilité (supervision Railway)
app.get('/api/sante', (req, res) => res.json({ ok: true, application: 'tarifaire', version: '1.0.0' }));

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

init()
  .then(() => {
    app.listen(PORT, () => console.log(`Tarifaire démarré sur le port ${PORT}`));
  })
  .catch(err => {
    console.error('Échec d’initialisation de la base de données :', err.message);
    process.exit(1);
  });
