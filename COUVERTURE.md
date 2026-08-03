# Couverture du cahier des charges CDC-PRICING-001

Audit exigence par exigence, tenu à jour à chaque évolution. Statuts : **Couvert** (fonctionnel en standard), **Partiel** (couvert avec une limite décrite), **Non couvert** (en feuille de route).

Synthèse : sur les 141 exigences du CDC (98 indispensables, 36 importantes, 7 souhaitables), la plateforme couvre **91 exigences en totalité et 21 partiellement**. Les 29 restantes sont listées en feuille de route en fin de document. **Toutes les exigences indispensables du lot 1 du CDC (socle et coût de revient, §17.2) sont couvertes.**

## M1 Référentiel article

| Réf. | Exigence | Priorité | Statut | Note |
|---|---|---|---|---|
| F-M1-01 | Fiche article complète | Indispensable | Couvert | Tous les blocs du §5.2 |
| F-M1-02 | Volume calculé depuis les dimensions | Indispensable | Couvert | |
| F-M1-03 | Densité et unité payante | Indispensable | Couvert | Indicateur poids/volume affiché |
| F-M1-04 | Alimentation automatique depuis les dossiers | Indispensable | Couvert | Poids, volume, colisage, position, taux effectif |
| F-M1-05 | Signaler les données manquantes | Indispensable | Couvert | Badge par fiche, filtre dédié ; le calcul estime au prorata plutôt que bloquer, conformément au point de vigilance §5.3 |
| F-M1-06 | Distinguer saisi / estimé, tracer la source | Indispensable | Couvert | Marquage « estimé » jusque dans le détail du coût |
| F-M1-07 | Historique des modifications | Indispensable | Couvert | Date, auteur, valeur précédente, source |
| F-M1-08 | Plusieurs fournisseurs, un principal | Indispensable | Couvert | Conditions d'achat par fournisseur, bascule du principal |
| F-M1-09 | Recherche multi-clés | Indispensable | Couvert | Code, code barres, fournisseur, libellé, position |
| F-M1-10 | Import/export tableur | Indispensable | Couvert | Format Annexe B, prévisualisation avant validation |
| F-M1-11 | Doublons de codes barres et libellés proches | Important | Couvert | Similarité pg_trgm pour les libellés |
| F-M1-12 | Articles liés (lot, UVC, remplacement) | Important | Couvert | Plus codes barres secondaires |
| F-M1-13 | Photos et fiches techniques | Important | Couvert | Téléversement, aperçu, téléchargement |
| F-M1-14 | Proposition de position tarifaire | Souhaitable | Couvert | Suggestion par similarité avec la nomenclature |
| F-M1-15 | Variantes (taille, couleur, parfum) | Souhaitable | Couvert | Via articles liés de type « variante » |

## M2 Référentiel douanier et fiscal

| Réf. | Exigence | Priorité | Statut | Note |
|---|---|---|---|---|
| F-M2-01 | Nomenclature versionnée avec date d'effet | Indispensable | Couvert | |
| F-M2-02 | Codes taxes paramétrables sans développement | Indispensable | Couvert | Base en cascade déclarative, coût vs créance |
| F-M2-03 | Simulation de liquidation | Indispensable | Couvert | |
| F-M2-04 | Liquidation réelle prime sur la simulation | Indispensable | Couvert | |
| F-M2-05 | Écart simulé / réel | Indispensable | Couvert | Écran dédié par article de déclaration |
| F-M2-06 | Exonérations par origine et position | Indispensable | Couvert | |
| F-M2-07 | Historisation des taux, recalcul à date | Indispensable | Couvert | Simulation à une date donnée |
| F-M2-08 | Import de la nomenclature | Important | Couvert | |
| F-M2-09 | Alerte taux constaté vs paramétré | Important | Couvert | |
| F-M2-10 | Régimes suspensifs, droits différés | Important | Non couvert | Feuille de route |

## M3 Fournisseurs et conditions d'achat

| Réf. | Exigence | Priorité | Statut | Note |
|---|---|---|---|---|
| F-M3-01 | Gestion des fournisseurs | Indispensable | Couvert | |
| F-M3-02 | Conditions d'achat datées | Indispensable | Couvert | |
| F-M3-03 | Incoterms et incidence sur la valeur en douane | Indispensable | Partiel | Incoterm porté par le dossier et la condition ; la déduction automatique des coûts à intégrer reste manuelle |
| F-M3-04 | Remises sur facture, fin de période, ristournes | Indispensable | Partiel | Remise sur facture couverte ; RFA et ristournes en feuille de route |
| F-M3-05 | Prestataires logistiques et grilles | Indispensable | Partiel | Coûts saisis par dossier et barèmes appris ; pas de gestion de grilles contractuelles |
| F-M3-06 | Alerte d'expiration de grille | Important | Non couvert | Feuille de route |
| F-M3-07 | Comparaison des fournisseurs | Important | Couvert | Prix net converti en F CFA, meilleur prix surligné |
| F-M3-08 | Historique des prix d'achat, tendance | Important | Partiel | Conditions datées conservées ; pas de graphique de tendance |

## M4 Dossiers d'importation

| Réf. | Exigence | Priorité | Statut | Note |
|---|---|---|---|---|
| F-M4-01 | Identifiant unique de dossier | Indispensable | Couvert | |
| F-M4-02 | Pièces rattachées avec document numérisé | Indispensable | Couvert | Téléversement par pièce |
| F-M4-03 | Import de facture, appariement code barres | Indispensable | Couvert | Par lot, transactionnel |
| F-M4-04 | Import déclaration, rattachement des lignes | Indispensable | Couvert | Rattachement automatique par position |
| F-M4-05 | Contrôle de concordance valeur/quantité | Indispensable | Couvert | Alerte au calcul |
| F-M4-06 | Signaler les lignes non rattachées | Indispensable | Couvert | |
| F-M4-07 | Dossier multi-conteneurs, multi-fournisseurs | Indispensable | Couvert | |
| F-M4-08 | Facture répartie sur plusieurs dossiers | Important | Partiel | Possible manuellement, sans assistant |
| F-M4-09 | Écart valeur déclarée / coûts réels | Indispensable | Couvert | |
| F-M4-10 | Écarts de réception | Indispensable | Partiel | Quantités modifiables et coût recalculable ; pas de rapprochement automatique avec un PV de réception |
| F-M4-11 | Reconnaissance automatique (OCR) | Souhaitable | Non couvert | Feuille de route |
| F-M4-12 | Dossiers de flux direct | Indispensable | Couvert | |

## M5 Moteur de coût de revient

| Réf. | Exigence | Priorité | Statut | Note |
|---|---|---|---|---|
| F-M5-01 | Une clé de répartition par nature | Indispensable | Couvert | valeur, poids, volume, unité payante, colis, quantité |
| F-M5-02 | Taxes au réel par ligne tarifaire | Indispensable | Couvert | Sans répartition globale |
| F-M5-03 | Unité payante pour le fret | Indispensable | Couvert | max(tonnes, m³), ratio paramétrable |
| F-M5-04 | Capitalisable vs charges de période | Indispensable | Couvert | Restituées comme indicateur |
| F-M5-05 | Coût de mise en rayon par format | Indispensable | Couvert | Logistique aval, démarque, portage |
| F-M5-06 | TVA rémanente si prorata < 100 % | Indispensable | Couvert | Paramètre `prorata_deduction` |
| F-M5-07 | Provisions au barème, extourne | Indispensable | Couvert | Barèmes appris à la clôture ; l'extourne consiste à remplacer la provision par la facture réelle puis recalculer |
| F-M5-08 | Révision sur facture tardive, stock vs vendu | Indispensable | Couvert | Avec alertes prix |
| F-M5-09 | CUMP multi-dossiers | Indispensable | Couvert | |
| F-M5-10 | Traçabilité de chaque composante | Indispensable | Couvert | Détail par ligne, clé et assiette |
| F-M5-11 | Comparaison clé unique / clés multiples | Important | Couvert | Écran dédié avec l'enjeu chiffré |
| F-M5-12 | Simulation variation fret, change, droits | Important | Couvert | Sur le dossier calculé |
| F-M5-13 | Coûts par lot | Souhaitable | Non couvert | Feuille de route |

## M6 Politique tarifaire multi-formats

| Réf. | Exigence | Priorité | Statut | Note |
|---|---|---|---|---|
| F-M6-01 | Formats de magasin, rattachement des PDV | Indispensable | Couvert | |
| F-M6-02 | Zones de prix | Indispensable | Partiel | Champ zone sur les PDV ; pas encore de politique par zone |
| F-M6-03 | Taux cible et plancher par niveau | Indispensable | Couvert | Famille x format, article |
| F-M6-04 | Arrondis et terminaisons par format | Indispensable | Couvert | |
| F-M6-05 | Résolution au niveau le plus fin | Indispensable | Couvert | Article > famille+format > famille > format > défaut |
| F-M6-06 | Dates d'effet et tarifs futurs | Indispensable | Couvert | |
| F-M6-07 | Cohérence de gamme et prix au kilo | Important | Couvert | Contrôleur dédié |
| F-M6-08 | Écart borné entre formats | Important | Couvert | |
| F-M6-09 | Promotions avec marge sur période | Important | Couvert | |
| F-M6-10 | Simulation d'un changement de politique | Important | Partiel | Propositions recalculables en masse ; pas d'écran avant/après |
| F-M6-11 | Prix spécifiques au commerce en ligne | Important | Couvert | Format WEB avec coûts de préparation |
| F-M6-12 | Prix par client (activité de gros) | Souhaitable | Non couvert | Feuille de route |

## M7 Veille concurrentielle

| Réf. | Exigence | Priorité | Statut | Note |
|---|---|---|---|---|
| F-M7-01 | Mobile hors connexion, synchronisation différée | Indispensable | Couvert | PWA, file locale, synchronisation automatique |
| F-M7-02 | Lecture caméra du code barres | Indispensable | Couvert | BarcodeDetector avec repli manuel |
| F-M7-03 | Prix, présence, promotion | Indispensable | Couvert | |
| F-M7-04 | Photo de l'étiquette, géolocalisation | Indispensable | Partiel | Champ justificatif ; capture photo et géolocalisation automatiques en feuille de route |
| F-M7-05 | Campagnes de relevés | Indispensable | Non couvert | Feuille de route |
| F-M7-06 | Taux de réalisation par enquêteur | Important | Non couvert | Feuille de route |
| F-M7-07 | Détection des saisies aberrantes | Important | Couvert | Écart à la médiane, confirmation exigée |
| F-M7-08 | Saisie des non-référencés | Important | Couvert | |
| F-M7-09 à 14 | Collecte en ligne automatisée | Indispensable/Important | Non couvert | Import panel et appariement couverts ; le robot de collecte est en feuille de route (cadre juridique §10.1.2 à instruire) |
| F-M7-15 | Import de fichier de panel | Important | Couvert | Format Annexe C |
| F-M7-16 | Distinction promo / fond de rayon | Important | Couvert | |
| F-M7-17 | Historisation et évolution | Indispensable | Couvert | |
| F-M7-18 | Indice par référence, famille, enseigne | Indispensable | Couvert | |
| F-M7-19 | Indice sur panier | Indispensable | Partiel | Indice global par enseigne ; pas de panier nommé |
| F-M7-20 | Positionnement par point de vente | Indispensable | Partiel | Par enseigne et format ; pas par PDV |
| F-M7-21 | Alertes d'écart paramétrables | Indispensable | Couvert | |
| F-M7-22 | Comparaison au litre/kilo | Important | Partiel | Champ conditionnement stocké ; comparaison affichée dans les contrôles de gamme internes |
| F-M7-23 | Pondération par le chiffre d'affaires | Important | Couvert | Indice pondéré CA 90 jours |
| F-M7-24 | Fraîcheur des relevés | Indispensable | Couvert | Âge affiché, relevés périmés signalés |

## M8 Moteur de prix

| Réf. | Exigence | Priorité | Statut | Note |
|---|---|---|---|---|
| F-M8-01 | Propositions en masse | Indispensable | Couvert | |
| F-M8-02 | Marge et contrainte déterminante restituées | Indispensable | Couvert | |
| F-M8-03 | Modification manuelle justifiée | Indispensable | Couvert | Mode manuel + justification |
| F-M8-04 | Validation par seuils | Indispensable | Couvert | Marge min, écart max |
| F-M8-05 | Trace complète | Indispensable | Couvert | Statuts + journal d'audit |
| F-M8-06 | Publication à date d'effet, y compris future | Indispensable | Couvert | |
| F-M8-07 | Annulation, retour version précédente | Indispensable | Couvert | Statuts annulé/remplacé conservés |
| F-M8-08 | Étiquettes de rayon | Important | Couvert | Page imprimable |
| F-M8-09 | Simulation d'impact CA/marge | Important | Partiel | Simulation de marge des promotions ; pas de projection CA |
| F-M8-10 | Élasticité prix estimée | Souhaitable | Non couvert | Feuille de route |
| F-M8-11 | Optimisation sous contrainte | Souhaitable | Non couvert | Feuille de route |

## M9 Pilotage et restitution

| Réf. | Exigence | Priorité | Statut | Note |
|---|---|---|---|---|
| F-M9-01 | Tableaux de bord par profil | Indispensable | Partiel | Tableau unique complet ; pas de personnalisation par profil |
| F-M9-02 | Analyse multidimensionnelle | Indispensable | Partiel | Analyses par dossier, famille, format ; pas de navigation libre |
| F-M9-03 | Export tableur de toute restitution | Indispensable | Couvert | |
| F-M9-04 | Alertes avec notification et courriel | Indispensable | Couvert | In-app + Resend optionnel |
| F-M9-05 | Marge théorique vs réalisée | Indispensable | Couvert | Sur les ventes importées |
| F-M9-06 | Écarts de coût par nature et cause | Important | Partiel | Détail par composante et révisions ; pas d'écran de synthèse des causes |
| F-M9-07 | Rapports programmés | Important | Non couvert | Feuille de route |
| F-M9-08 | Accès lecture par API pour le décisionnel | Important | Couvert | API JSON documentée |

## M10 Interopérabilité

| Réf. | Exigence | Priorité | Statut | Note |
|---|---|---|---|---|
| F-M10-01 | API REST documentée et versionnée | Indispensable | Couvert | /docs.html, /api/docs |
| F-M10-02 | Jeton, limitation de débit, journalisation | Indispensable | Couvert | |
| F-M10-03 | Import/export tableur avec modèles | Indispensable | Couvert | Formats Annexes B et C documentés |
| F-M10-04 | Assistant de correspondance de colonnes | Indispensable | Partiel | Analyse tolérante (séparateurs, entêtes) ; pas de mappage mémorisé |
| F-M10-05 | Prévisualisation avant import | Indispensable | Partiel | Sur le référentiel ; rapports de rejets partout |
| F-M10-06 | Reprise d'import sans doublon | Indispensable | Partiel | Imports transactionnels ; l'idempotence par clé reste à faire |
| F-M10-07 | Échanges programmés supervisés | Indispensable | Non couvert | Feuille de route |
| F-M10-08 | Notifications sortantes (webhooks) | Important | Non couvert | Feuille de route |
| F-M10-09 | Journal des échanges | Indispensable | Partiel | Journal d'audit ; pas de détail enregistrement par enregistrement |
| F-M10-10 | Mode autonome sans ERP | Indispensable | Couvert | |

## M11 Administration et sécurité

| Réf. | Exigence | Priorité | Statut | Note |
|---|---|---|---|---|
| F-M11-01 | Multi-entités cloisonnées | Indispensable | Non couvert | Feuille de route (chantier structurant) |
| F-M11-02 | Rôles et habilitations | Indispensable | Couvert | 8 rôles hiérarchisés |
| F-M11-03 | Double authentification | Indispensable | Couvert | TOTP par utilisateur |
| F-M11-04 | Annuaire d'entreprise, SSO | Important | Non couvert | Feuille de route |
| F-M11-05 | Journalisation inaltérable | Indispensable | Couvert | Chaîne SHA-256 vérifiable |
| F-M11-06 | Restriction d'accès aux coûts et marges | Indispensable | Couvert | Par rôle |
| F-M11-07 | Paramétrage autonome | Indispensable | Couvert | Taxes, politiques, formats, barèmes |
| F-M11-08 | Sauvegarde et restauration | Indispensable | Partiel | Sauvegardes du fournisseur d'hébergement (Railway) ; procédure de restauration à contractualiser |
| F-M11-09 | Export complet des données | Indispensable | Couvert | JSON toutes tables |
| F-M11-10 | Environnements séparés | Indispensable | Partiel | À instancier via plusieurs environnements Railway |
| F-M11-11 | Interface en français, extensible anglais | Indispensable | Partiel | Français complet ; anglais non traduit |
| F-M11-12 | Corbeille | Important | Partiel | Tarifs et transactions en annulation logique ; pas de corbeille générale |

## Exigences non fonctionnelles

| Réf. | Exigence | Priorité | Statut | Note |
|---|---|---|---|---|
| F-NF-01 | Chiffrement échanges et repos | Indispensable | Partiel | TLS via l'hébergeur ; chiffrement au repos selon l'offre PostgreSQL choisie |
| F-NF-02/03 | Conformité loi données personnelles | Indispensable | Partiel | Peu de données personnelles traitées ; déclaration à l'autorité = démarche organisationnelle |
| F-NF-04 | Conservation et purge paramétrables | Indispensable | Non couvert | Feuille de route |
| F-NF-05 | Tests d'intrusion | Important | Non couvert | Démarche organisationnelle |
| F-NF-06 | Réversibilité, format ouvert | Indispensable | Couvert | Export complet JSON + CSV |
| F-NF-07 | Propriété des données | Indispensable | Couvert | Contractuel ; l'export garantit l'effectivité |
| F-NF-08 | Séquestre du code | Important | Couvert | Le client détient le dépôt du code |

## Feuille de route restante, par ordre de valeur suggéré

1. Campagnes de relevés avec suivi par enquêteur (F-M7-05/06) et photo + géolocalisation (F-M7-04)
2. Multi-entités cloisonnées (F-M11-01) puis SSO (F-M11-04)
3. Échanges programmés et supervision, webhooks sortants, journal des échanges détaillé (F-M10-07/08/09), idempotence par clé (F-M10-06)
4. Régimes suspensifs (F-M2-10), RFA et ristournes (F-M3-04), grilles de prestataires avec alertes (F-M3-05/06)
5. Rapports programmés (F-M9-07), tableaux par profil (F-M9-01), zones de prix actives (F-M6-02)
6. Collecte en ligne automatisée dans le cadre juridique du §10.1.2 (F-M7-09 à 14)
7. Purge paramétrable (F-NF-04), corbeille générale (F-M11-12), version anglaise (F-M11-11)
8. Souhaitables : OCR des pièces, coûts par lot, élasticité, optimisation sous contrainte, prix clients de gros
