# Tarifaire — Plateforme prix de revient & politique tarifaire (Sénégal / UEMOA)

Plateforme de gestion du **coût de revient débarqué** et de la **politique tarifaire** pour le commerce de détail en Afrique de l'Ouest, développée d'après le cahier des charges `CDC-PRICING-001`. Du coût débarqué au prix en rayon, avec veille concurrentielle et échanges de fichiers vers l'ERP.

## Fonctionnalités (couverture du CDC)

| Module | Contenu livré |
|---|---|
| **M1 — Référentiel article** | Fiche complète (identification, logistique, douane, commercial), volume calculé depuis les dimensions, densité et unité payante, signalement des données manquantes, historique des modifications, données estimées distinguées des données constatées, import/export CSV (format Annexe B), détection de doublons de codes barres, enrichissement automatique depuis les dossiers |
| **M2 — Référentiel douanier** | Nomenclature TEC UEMOA à 10 chiffres, **codes taxes 100 % paramétrables** (base en cascade `VD+DD+…`, taux, coût vs **créance sur l'État**), exonérations par origine/position, simulateur de liquidation, montants réels primant sur la simulation, alerte de divergence taux constaté/paramétré |
| **M3 — Achats** | Fournisseurs, conditions d'achat datées, devises |
| **M4 — Dossiers d'importation** | Cycle de vie complet (ouvert → titres → embarqué → déclaré → réceptionné → clôturé → révisé), pièces rattachées, import CSV de la facture (appariement par code barres) et de la déclaration, rattachement lignes ↔ articles de déclaration (automatique par position), contrôles de concordance |
| **M5 — Moteur de coût** | Coût de revient débarqué **avec une clé de répartition par nature** (valeur, poids, volume, **unité payante**, colis, quantité), droits et taxes au **montant réel par ligne tarifaire**, ventilation coût / créance TVA, charges de période séparées, estimation des poids/volumes manquants au prorata (marquée « estimée », totaux = connaissement), CUMP multi-dossiers, traçabilité de chaque composante, coût de mise en rayon par format (logistique aval, démarque, portage) |
| **M6 — Politique tarifaire** | Formats de magasin, taux de marque cible et plancher par famille × format (résolution « niveau le plus fin »), règles d'arrondi et terminaisons psychologiques, modes d'arbitrage |
| **M7 — Veille concurrentielle** | Saisie de relevés (détection de prix aberrants), import panel (format Annexe C), appariement automatique par code barres + file de validation manuelle mémorisée, indices de prix par enseigne, alertes d'écart, fraîcheur des relevés |
| **M8 — Moteur de prix** | Propositions en masse par périmètre, chaîne complète CMR → marge cible → TTC → arrondi → confrontation marché, 5 modes d'arbitrage (marge, marché, encadré, alignement, manuel), **contrainte déterminante toujours explicitée**, plancher de marge, circuit proposé → validé → publié avec remplacement du tarif précédent, export CSV vers ERP/caisse |
| **M9 — Pilotage** | Tableau de bord (complétude, créance TVA, coefficient moyen, bornes de taux effectif, marges négatives…), analyse par dossier, marges par famille |
| **M10 — Interopérabilité** | API REST JSON authentifiée par jeton, imports/exports CSV partout (formats Annexes B et C), mode autonome sans ERP |
| **M11 — Administration** | Rôles hiérarchisés (enquêteur → … → admin), journal d'audit, paramètres, environnements par variables |

Adapté au contexte ouest-africain : interface légère sans dépendance externe, franc CFA sans décimale, taxes en cascade type liquidation sénégalaise (DD/RS/PCS/PCC/COSEC/accises/TVA/acompte BIC), écritures d'esprit SYSCOHADA, interface en français.

## Déploiement sur Railway

1. **Créer un projet** sur [railway.app](https://railway.app) et y déployer ce dépôt GitHub (« Deploy from GitHub repo »). Railway détecte Node.js automatiquement (ou utilise le `Dockerfile`).
2. **Ajouter PostgreSQL** : dans le projet, « + New » → « Database » → « PostgreSQL ».
3. **Lier la base au service** : dans les variables du service applicatif, ajouter
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}` (référence de variable Railway).
4. **Définir les variables** :
   - `JWT_SECRET` : une chaîne aléatoire longue (obligatoire en production) ;
   - `ADMIN_EMAIL` / `ADMIN_PASSWORD` : compte administrateur créé au premier démarrage (facultatif, défaut `admin@demo.sn` / `admin123` — à changer).
5. **Générer un domaine** : Settings → Networking → « Generate Domain ».

Le schéma de base se crée et s'amorce automatiquement au démarrage (idempotent). La sonde de disponibilité est exposée sur `/api/sante` (déjà configurée dans `railway.json`).

### Dépannage du déploiement

- Le serveur démarre **même si la base n'est pas encore prête** : `/api/sante` répond immédiatement (`base: "en_attente"` puis `"connectee"`), et les routes métier renvoient 503 avec le motif tant que la connexion n'est pas établie. Consultez les *Deploy Logs* : chaque tentative de connexion y est tracée avec l'erreur exacte.
- **`DATABASE_URL` manquante** : le service PostgreSQL doit exister dans le projet **et** la variable doit être ajoutée sur le service applicatif (`${{Postgres.DATABASE_URL}}`), puis redéployer.
- **TLS** : les URL internes Railway (`*.railway.internal`) ne supportent pas TLS — le serveur le détecte et bascule automatiquement ; `PGSSL=1` ou `PGSSL=0` permettent de forcer un mode.

## Démarrage local

```bash
npm install
# démarrer un PostgreSQL local puis :
cp .env.example .env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/tarifaire npm start
# http://localhost:3000 — connexion : admin@demo.sn / admin123
```

## Parcours type (lot 1 du CDC)

1. **Référentiel** : importer les articles (CSV Annexe B) ou les saisir.
2. **Douane** : vérifier les codes taxes (la distinction coût / créance est portée par le paramétrage) et compléter la nomenclature.
3. **Dossier** : créer le dossier (devise, taux de change, poids/volume du connaissement), importer la facture fournisseur, saisir les coûts accessoires (fret → clé *unité payante*), saisir la déclaration, liquider (simulation) puis saisir les montants réels de la quittance.
4. **Calculer** : le coût de revient débarqué se calcule ligne par ligne, la TVA part en créance, le référentiel s'enrichit, les écritures s'exportent.
5. **Tarifer** : générer les propositions de prix par format, arbitrer, publier, exporter vers l'ERP/caisse.
6. **Veiller** : saisir ou importer les relevés concurrents, suivre les indices et les alertes.

## Architecture technique

- **Serveur** : Node.js ≥ 18, Express, PostgreSQL (`pg`), JWT, bcrypt. Migrations et amorçage idempotents au démarrage (`server/db.js`).
- **Moteurs métier** (`server/services/`) : `liquidation.js` (taxes en cascade déclaratives), `cout.js` (clés multiples, unité payante, estimations), `prix.js` (arbitrage coût/marge/marché).
- **Interface** : application monopage sans dépendance externe (`public/`), adaptée aux faibles bandes passantes.
- **Sécurité** : authentification par jeton, rôles hiérarchisés, journal d'audit, aucune suppression physique des transactions (les tarifs remplacés sont conservés).

## Comptes et rôles

| Rôle | Droits |
|---|---|
| `enqueteur` | Saisie de relevés uniquement |
| `lecture` | Consultation |
| `acheteur` | + articles, conditions d'achat, propositions de prix, veille |
| `import` | + dossiers d'importation, déclarations, calculs |
| `comptable` | + taux de change, journal |
| `controle` | + politiques tarifaires, formats, familles |
| `direction` | + validation et publication des tarifs |
| `admin` | Tout, y compris utilisateurs, taxes et paramètres |
