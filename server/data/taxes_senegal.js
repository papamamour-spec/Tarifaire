'use strict';
/*
 * Fiscalité de porte et taxes spécifiques du Sénégal.
 *
 * Deux volets :
 *  - CODES_TAXES : les taxes liquidées au cordon douanier, dans l'ordre de la cascade
 *    (chaque base est exprimée en composants : VD = valeur en douane + codes des taxes
 *    déjà calculées). Le caractère coût / créance sur l'État est porté par le paramétrage,
 *    conformément à l'exigence structurante du CDC (§6.3).
 *  - REGLES : taux spécifiques par produit et exonérations, appliqués par le moteur avec
 *    la règle LA PLUS SPÉCIFIQUE (préfixe de position le plus long, origine précisée
 *    prioritaire). C'est ainsi que sont portés les droits d'accise par famille de produits
 *    et les exonérations de TVA.
 *
 * IMPORTANT : taux indicatifs tels que connus à début 2026 (CGI sénégalais et textes
 * UEMOA/CEDEAO). Le paramétrage est entièrement modifiable dans Douane & fiscalité ;
 * les textes officiels (Loi de finances, DGID, DGD) font foi.
 * Non modélisé ici : taxes assises sur des unités physiques (par exemple la taxe sur
 * les sachets plastiques au poids), à saisir comme coût de dossier le cas échéant.
 */

const CODES_TAXES = [
  // code, libellé, ordre, taux %, taux depuis la position (TEC), base, traitement
  ['DD', 'Droit de douane (TEC CEDEAO/UEMOA)', 1, null, true, 'VD', 'cout'],
  ['RS', 'Redevance statistique', 2, 1, false, 'VD', 'cout'],
  ['PCS', 'Prélèvement communautaire de solidarité UEMOA', 3, 0.8, false, 'VD', 'cout'],
  ['PCC', 'Prélèvement communautaire CEDEAO', 4, 0.5, false, 'VD', 'cout'],
  ['COSEC', 'Redevance COSEC (importations par voie maritime)', 5, 0.4, false, 'VD', 'cout'],
  ['PROMAD', 'Prélèvement de soutien à la modernisation de l’administration des douanes', 6, 1, false, 'VD', 'cout'],
  ['TCI', 'Taxe conjoncturelle à l’importation (produits agricoles ciblés)', 7, 0, false, 'VD', 'cout'],
  ['ACC', 'Droit d’accise (taux selon le produit, voir règles)', 8, 0, false, 'VD+DD+RS', 'cout'],
  ['TVA', 'TVA à l’importation', 9, 18, false, 'VD+DD+RS+PCS+PCC+COSEC+PROMAD+TCI+ACC', 'creance'],
  ['AIB', 'Acompte d’impôt sur le bénéfice (précompte à l’importation)', 10, 3, false, 'VD', 'creance']
];

// [préfixe de position, origine ('' = toutes), code taxe, taux appliqué %, commentaire]
const REGLES = [
  // ------- Droits d'accise (taxes spécifiques du CGI sénégalais) -------
  ['2203', '', 'ACC', 40, 'Bières : accise boissons alcoolisées'],
  ['2204', '', 'ACC', 40, 'Vins : accise boissons alcoolisées'],
  ['2205', '', 'ACC', 40, 'Vermouths : accise boissons alcoolisées'],
  ['2206', '', 'ACC', 40, 'Autres boissons fermentées : accise boissons alcoolisées'],
  ['2207', '', 'ACC', 40, 'Alcool éthylique : accise'],
  ['2208', '', 'ACC', 40, 'Spiritueux : accise boissons alcoolisées'],
  ['2202', '', 'ACC', 5, 'Boissons gazeuses et sucrées non alcoolisées : accise'],
  ['2009', '', 'ACC', 5, 'Jus avec sucres ajoutés : accise boissons sucrées (à vérifier selon composition)'],
  ['2402', '', 'ACC', 65, 'Cigares et cigarettes : accise tabacs'],
  ['2403', '', 'ACC', 65, 'Autres tabacs fabriqués : accise tabacs'],
  ['0901', '', 'ACC', 5, 'Café : accise'],
  ['0902', '', 'ACC', 5, 'Thé : accise'],
  ['3303', '', 'ACC', 15, 'Parfums : accise produits cosmétiques'],
  ['3304', '', 'ACC', 15, 'Produits de beauté : accise produits cosmétiques (dépigmentants : taux majoré, à préciser)'],
  ['3305', '', 'ACC', 15, 'Préparations capillaires : accise produits cosmétiques'],
  ['3307', '', 'ACC', 15, 'Déodorants et préparations de toilette : accise produits cosmétiques'],
  ['0405', '', 'ACC', 15, 'Beurre et matières grasses laitières : accise corps gras alimentaires'],
  ['1517', '', 'ACC', 15, 'Margarines et mélanges : accise corps gras alimentaires'],
  ['150710', '', 'ACC', 0, 'Huile de soja brute destinée au raffinage : hors accise corps gras'],
  ['151110', '', 'ACC', 0, 'Huile de palme brute destinée au raffinage : hors accise corps gras'],

  // ------- Taxe conjoncturelle à l'importation -------
  ['1701', '', 'TCI', 10, 'Sucre : taxe conjoncturelle à l’importation (protection de la filière)'],

  // ------- Exonérations de TVA à l'importation (produits de première nécessité et assimilés) -------
  ['1006', '', 'TVA', 0, 'Riz : exonéré de TVA'],
  ['1001', '', 'TVA', 0, 'Blé : exonéré de TVA'],
  ['1101', '', 'TVA', 0, 'Farine de blé : exonérée de TVA'],
  ['30', '', 'TVA', 0, 'Produits pharmaceutiques (chapitre 30) : exonérés de TVA'],
  ['4901', '', 'TVA', 0, 'Livres : exonérés de TVA'],
  ['4902', '', 'TVA', 0, 'Journaux et périodiques : exonérés de TVA'],
  ['31', '', 'TVA', 0, 'Engrais : exonérés de TVA'],
  ['0402', '', 'TVA', 0, 'Lait en poudre non transformé : exonéré de TVA (à vérifier selon conditionnement)'],

  // ------- Exonérations liées aux redevances maritimes -------
  // COSEC : ne frappe que les importations par voie maritime ; pour un dossier aérien ou
  // terrestre, mettre le taux à 0 sur le dossier ou saisir la liquidation réelle.

  // ------- Régime préférentiel communautaire -------
  // Les produits originaires agréés UEMOA/CEDEAO (certificat d'origine) sont exonérés de
  // droit de douane. Exemples pour les principaux partenaires ; compléter selon vos flux
  // et vos agréments : la règle exige l'origine ET prime sur le taux du TEC.
  ['', 'CI', 'DD', 0, 'Origine Côte d’Ivoire : produit originaire CEDEAO agréé (certificat exigé)'],
  ['', 'ML', 'DD', 0, 'Origine Mali : produit originaire CEDEAO agréé (certificat exigé)'],
  ['', 'GH', 'DD', 0, 'Origine Ghana : produit originaire CEDEAO agréé (certificat exigé)'],
  ['', 'NG', 'DD', 0, 'Origine Nigeria : produit originaire CEDEAO agréé (certificat exigé)'],
  ['', 'BJ', 'DD', 0, 'Origine Bénin : produit originaire CEDEAO agréé (certificat exigé)'],
  ['', 'BF', 'DD', 0, 'Origine Burkina Faso : produit originaire CEDEAO agréé (certificat exigé)'],
  ['', 'TG', 'DD', 0, 'Origine Togo : produit originaire CEDEAO agréé (certificat exigé)'],
  ['', 'GN', 'DD', 0, 'Origine Guinée : produit originaire CEDEAO agréé (certificat exigé)']
];

module.exports = { CODES_TAXES, REGLES };
