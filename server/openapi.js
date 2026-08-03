'use strict';
/*
 * Lot 4 : spécification OpenAPI condensée de l'interface applicative (F-M10-01).
 * Servie sur /api/docs (JSON) et rendue par la page /docs.html.
 * Authentification : en-tête Authorization: Bearer <jeton>, jeton obtenu via POST /api/connexion.
 */
function op(resume, roleMin, corps, reponses) {
  return { resume, role_minimum: roleMin || 'lecture', corps: corps || null, reponses: reponses || '200 JSON' };
}

function specOpenApi() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Tarifaire — interface applicative',
      version: '2.0.0',
      description: 'Plateforme de gestion du prix de revient et de la politique tarifaire (Sénégal / UEMOA). ' +
        'Toutes les routes sauf /connexion et /sante exigent un jeton Bearer. ' +
        'Les imports acceptent un corps JSON {contenu: "<CSV>"} (séparateur ; , ou tabulation). ' +
        'Rôles croissants : enqueteur, lecture, acheteur, import, comptable, controle, direction, admin.'
    },
    securite: 'Authorization: Bearer <jeton JWT>',
    chemins: {
      'POST /api/connexion': op('Connexion. Corps {email, mot_de_passe, code_2fa?}. 428 si 2FA requise.', 'public',
        '{email, mot_de_passe, code_2fa?}', '{token, utilisateur}'),
      'GET /api/sante': op('Sonde de disponibilité (sans jeton)', 'public'),

      'GET /api/referentiels/articles': op('Recherche d’articles. Paramètres q, famille, statut, incomplets=1, page, taille', 'lecture'),
      'GET /api/referentiels/articles/{code}': op('Fiche article complète avec historique et conditions d’achat', 'lecture'),
      'POST /api/referentiels/articles': op('Création ou modification d’un article', 'acheteur', '{code_interne, libelle, ...}'),
      'GET /api/referentiels/articles-export/csv': op('Export du référentiel (format Annexe B)', 'lecture'),
      'POST /api/referentiels/articles-import/csv': op('Import Annexe B. {contenu, confirmer:bool} ; sans confirmer : prévisualisation', 'acheteur'),
      'GET /api/referentiels/familles': op('Liste des familles', 'lecture'),
      'POST /api/referentiels/familles': op('Création/modification de famille', 'controle'),
      'GET /api/referentiels/fournisseurs': op('Liste des fournisseurs', 'lecture'),
      'POST /api/referentiels/fournisseurs': op('Création/modification de fournisseur', 'acheteur'),
      'GET /api/referentiels/conditions-achat': op('Conditions d’achat (paramètre article)', 'lecture'),
      'POST /api/referentiels/conditions-achat': op('Nouvelle condition d’achat', 'acheteur'),

      'GET /api/douane/positions': op('Nomenclature tarifaire (paramètre q)', 'lecture'),
      'POST /api/douane/positions': op('Ajout/mise à jour d’une position à dix chiffres', 'import'),
      'POST /api/douane/positions-import/csv': op('Import de la nomenclature {contenu}', 'import'),
      'GET /api/douane/taxes': op('Codes taxes paramétrables (base en cascade, coût vs créance)', 'lecture'),
      'POST /api/douane/taxes': op('Paramétrage d’un code taxe', 'admin'),
      'GET /api/douane/exonerations': op('Règles d’exonération', 'lecture'),
      'POST /api/douane/exonerations': op('Ajout d’une exonération', 'admin'),
      'POST /api/douane/simulation': op('Simulation de liquidation {valeur_en_douane, position_tarifaire, origine}', 'lecture'),
      'GET /api/douane/divergences': op('Positions dont le taux constaté diverge du taux paramétré', 'lecture'),

      'GET /api/dossiers': op('Liste des dossiers d’importation (paramètre statut)', 'lecture'),
      'POST /api/dossiers': op('Création/modification d’un dossier', 'import'),
      'GET /api/dossiers/{id}': op('Dossier complet : lignes, pièces, coûts, déclaration, résultats', 'lecture'),
      'POST /api/dossiers/{id}/statut': op('Changement de statut ; la clôture apprend les barèmes de provision', 'import', '{statut}'),
      'POST /api/dossiers/{id}/lignes': op('Ajout/modification d’une ligne de facture', 'import'),
      'POST /api/dossiers/{id}/lignes-import/csv': op('Import de facture {contenu, remplacer} — appariement par code barres, transactionnel', 'import'),
      'POST /api/dossiers/{id}/couts': op('Ajout d’un coût accessoire avec clé de répartition', 'import'),
      'POST /api/dossiers/{id}/declaration': op('Ajout d’un article de déclaration', 'import'),
      'POST /api/dossiers/{id}/declaration-import/csv': op('Import de la déclaration {contenu}', 'import'),
      'POST /api/dossiers/{id}/declaration/{daId}/taxes-reelles': op('Saisie des montants réellement liquidés {taxes:[{code_taxe, montant}]}', 'import'),
      'POST /api/dossiers/{id}/liquider': op('Liquidation simulée de la déclaration', 'import'),
      'POST /api/dossiers/{id}/rattacher-auto': op('Rattachement lignes/déclaration par position tarifaire', 'import'),
      'POST /api/dossiers/{id}/calculer': op('Calcul du coût de revient débarqué (transactionnel)', 'import'),
      'POST /api/dossiers/{id}/reviser': op('Révision après facture tardive {stocks:[{article_code, stock_restant}]}', 'import'),
      'GET /api/dossiers/{id}/revisions': op('Historique des révisions de coût', 'lecture'),
      'GET /api/dossiers/{id}/provisions-proposees': op('Provisions proposées depuis les barèmes appris', 'lecture'),
      'POST /api/dossiers/{id}/provisions-appliquer': op('Application des provisions proposées', 'import'),
      'PUT /api/dossiers/{id}/pieces/{pieceId}/fichier': op('Téléversement du document numérisé (corps binaire, en-tête X-Nom-Fichier)', 'import'),
      'GET /api/dossiers/{id}/pieces/{pieceId}/fichier': op('Téléchargement du document', 'lecture'),
      'GET /api/dossiers/{id}/resultats-export/csv': op('Export des coûts calculés', 'lecture'),
      'GET /api/dossiers/{id}/ecritures': op('Écritures comptables (paramètre format=csv)', 'lecture'),

      'GET /api/tarification/formats': op('Formats de magasin', 'lecture'),
      'POST /api/tarification/formats': op('Paramétrage d’un format', 'controle'),
      'GET /api/tarification/politiques': op('Politiques tarifaires', 'lecture'),
      'POST /api/tarification/politiques': op('Politique famille x format {taux_marque_cible, mode_arbitrage, ...}', 'controle'),
      'GET /api/tarification/regles-validation': op('Règle de validation par seuils', 'lecture'),
      'POST /api/tarification/regles-validation': op('{taux_marque_min, ecart_prix_max_pct}', 'direction'),
      'POST /api/tarification/proposer': op('Propositions de prix {article_code?, famille_code?, format_codes?}', 'acheteur'),
      'POST /api/tarification/tarifs': op('Enregistrement de propositions ; seuils => statut a_valider', 'acheteur'),
      'GET /api/tarification/tarifs': op('Tarifs (paramètres statut, format, article)', 'lecture'),
      'POST /api/tarification/tarifs/{id}/statut': op('{statut: valide|refuse|publie|annule}', 'direction'),
      'POST /api/tarification/tarifs-publier-lot': op('Publication en lot {ids:[...]}', 'direction'),
      'GET /api/tarification/tarifs-export/csv': op('Export des tarifs publiés vers ERP/caisse', 'lecture'),
      'GET /api/tarification/promotions': op('Campagnes promotionnelles', 'lecture'),
      'POST /api/tarification/promotions': op('{libelle, article_code|famille_code, taux_remise, date_debut, date_fin, marge_min}', 'acheteur'),
      'GET /api/tarification/promotions/{id}/simulation': op('Marge pendant la promotion, alertes sous marge minimale', 'lecture'),
      'GET /api/tarification/controles': op('Contrôles de cohérence : prix au kilo, ordre de gamme, écart entre formats', 'lecture'),

      'GET /api/veille/enseignes': op('Enseignes concurrentes', 'lecture'),
      'POST /api/veille/releves': op('Saisie d’un relevé {code_barres, prix_ttc, ...} ; 409 si prix aberrant', 'enqueteur'),
      'GET /api/veille/releves': op('Relevés (paramètres article, enseigne, non_apparies=1)', 'lecture'),
      'POST /api/veille/releves/{id}/apparier': op('Appariement manuel mémorisé {article_code}', 'acheteur'),
      'POST /api/veille/releves-import/csv': op('Import Annexe C {contenu}', 'acheteur'),
      'GET /api/veille/indices': op('Indices de prix par enseigne (paramètre format)', 'lecture'),
      'GET /api/veille/alertes': op('Écarts concurrentiels au-delà du seuil (paramètre seuil)', 'lecture'),

      'GET /api/pilotage/tableau-de-bord': op('Indicateurs de synthèse', 'lecture'),
      'GET /api/pilotage/analyse-dossiers': op('Analyse par dossier', 'lecture'),
      'GET /api/pilotage/marges-par-famille': op('Marges par famille et format', 'lecture'),
      'POST /api/pilotage/ventes-import/csv': op('Import des ventes ERP {contenu} (flux FE07)', 'comptable'),
      'GET /api/pilotage/marge-realisee': op('Marge réalisée vs théorique (paramètres depuis, famille)', 'lecture'),

      'GET /api/admin/utilisateurs': op('Utilisateurs', 'admin'),
      'POST /api/admin/utilisateurs': op('Création/modification d’utilisateur', 'admin'),
      'GET /api/admin/parametres': op('Paramètres', 'admin'),
      'POST /api/admin/parametres': op('{cle, valeur}', 'admin'),
      'GET /api/admin/taux-change': op('Derniers cours par devise', 'lecture'),
      'POST /api/admin/taux-change': op('{devise, cours, date_cours}', 'comptable'),
      'GET /api/admin/journal': op('Journal d’audit', 'comptable'),
      'GET /api/admin/journal-verification': op('Vérification d’intégrité de la chaîne du journal', 'comptable'),

      'POST /api/compte/mot-de-passe': op('{ancien, nouveau} (10 caractères minimum)', 'enqueteur'),
      'POST /api/compte/2fa/preparer': op('Génère le secret TOTP, retourne l’URL otpauth', 'enqueteur'),
      'POST /api/compte/2fa/confirmer': op('{code} : active la double authentification', 'enqueteur'),
      'POST /api/compte/2fa/desactiver': op('{code}', 'enqueteur'),
      'GET /api/compte/notifications': op('Notifications de l’utilisateur et de son rôle', 'enqueteur'),
      'POST /api/compte/notifications/{id}/lue': op('Marquer comme lue', 'enqueteur')
    }
  };
}

module.exports = { specOpenApi };
