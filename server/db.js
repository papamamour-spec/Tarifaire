'use strict';
/*
 * Accès base de données PostgreSQL + migrations idempotentes + données d'amorçage.
 * La configuration se fait par DATABASE_URL (fournie par Railway pour le plugin PostgreSQL).
 */
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/tarifaire';

/*
 * Détermination du TLS :
 * - PGSSL=1 force le TLS, PGSSL=0 le désactive ;
 * - sslmode=disable/require dans l'URL est respecté ;
 * - les réseaux privés (railway.internal, localhost) ne supportent pas le TLS ;
 * - en cas d'erreur SSL à la connexion, on bascule automatiquement et on réessaie.
 */
function sslInitial() {
  if (process.env.PGSSL === '1') return true;
  if (process.env.PGSSL === '0') return false;
  if (/sslmode=disable/.test(connectionString)) return false;
  if (/sslmode=(require|prefer|verify)/.test(connectionString)) return true;
  try {
    const hote = new URL(connectionString).hostname;
    if (hote === 'localhost' || hote === '127.0.0.1' || hote.endsWith('.railway.internal') || hote.endsWith('.internal')) return false;
  } catch { /* URL non analysable : essai sans TLS d'abord */ }
  return false;
}

let sslActif = sslInitial();
let pool = creerPool();

function creerPool() {
  return new Pool({
    connectionString,
    ssl: sslActif ? { rejectUnauthorized: false } : false,
    max: 10
  });
}

async function query(text, params) {
  return pool.query(text, params);
}

const attendre = ms => new Promise(r => setTimeout(r, ms));

/*
 * Attend que la base soit joignable (la base Railway peut être encore en cours de
 * provisionnement au premier démarrage) et gère la bascule TLS automatique.
 */
async function attendreBase() {
  const maxTentatives = 30;
  for (let tentative = 1; ; tentative++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      if (/ssl|tls/i.test(e.message || '')) {
        sslActif = !sslActif;
        console.warn(`[base] erreur SSL (« ${e.message} ») : nouvel essai avec TLS ${sslActif ? 'activé' : 'désactivé'}`);
        try { await pool.end(); } catch { /* sans importance */ }
        pool = creerPool();
        continue;
      }
      if (tentative >= maxTentatives) throw e;
      console.warn(`[base] injoignable (tentative ${tentative}/${maxTentatives}) : ${e.message} - nouvel essai dans 3 s`);
      await attendre(3000);
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS utilisateurs (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  mot_de_passe_hash TEXT NOT NULL,
  nom TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'acheteur',
  actif BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parametres (
  cle TEXT PRIMARY KEY,
  valeur TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS familles (
  code TEXT PRIMARY KEY,
  libelle TEXT NOT NULL,
  parent_code TEXT REFERENCES familles(code),
  niveau INT NOT NULL DEFAULT 1,
  marge_cible NUMERIC,
  demarque_taux NUMERIC
);

CREATE TABLE IF NOT EXISTS fournisseurs (
  code TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  pays TEXT,
  devise TEXT NOT NULL DEFAULT 'XOF',
  incoterm_defaut TEXT,
  contact TEXT,
  actif BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS articles (
  code_interne TEXT PRIMARY KEY,
  code_barres TEXT,
  libelle TEXT NOT NULL,
  libelle_court TEXT,
  famille_code TEXT REFERENCES familles(code),
  marque TEXT,
  type_marque TEXT,
  statut TEXT NOT NULL DEFAULT 'actif',
  fournisseur_code TEXT REFERENCES fournisseurs(code),
  reference_fournisseur TEXT,
  unites_par_carton INT,
  poids_net_unitaire NUMERIC,
  poids_brut_carton NUMERIC,
  longueur_carton NUMERIC,
  largeur_carton NUMERIC,
  hauteur_carton NUMERIC,
  volume_carton NUMERIC,
  volume_estime BOOLEAN NOT NULL DEFAULT FALSE,
  poids_estime BOOLEAN NOT NULL DEFAULT FALSE,
  position_tarifaire TEXT,
  origine TEXT,
  taux_effectif_constate NUMERIC,
  taux_tva_vente NUMERIC NOT NULL DEFAULT 18,
  marge_cible NUMERIC,
  role_assortiment TEXT,
  sensibilite_prix TEXT,
  mode_arbitrage TEXT,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  modifie_le TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_articles_cb ON articles(code_barres);
CREATE INDEX IF NOT EXISTS idx_articles_famille ON articles(famille_code);

CREATE TABLE IF NOT EXISTS codes_barres_secondaires (
  code_barres TEXT PRIMARY KEY,
  article_code TEXT NOT NULL REFERENCES articles(code_interne) ON DELETE CASCADE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS historique_articles (
  id SERIAL PRIMARY KEY,
  article_code TEXT NOT NULL,
  champ TEXT NOT NULL,
  ancienne_valeur TEXT,
  nouvelle_valeur TEXT,
  source TEXT NOT NULL DEFAULT 'saisie',
  auteur TEXT,
  date_modif TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conditions_achat (
  id SERIAL PRIMARY KEY,
  fournisseur_code TEXT NOT NULL REFERENCES fournisseurs(code),
  article_code TEXT NOT NULL REFERENCES articles(code_interne),
  prix_achat NUMERIC NOT NULL,
  devise TEXT NOT NULL DEFAULT 'XOF',
  remise_pct NUMERIC NOT NULL DEFAULT 0,
  incoterm TEXT,
  date_effet DATE NOT NULL DEFAULT CURRENT_DATE,
  date_fin DATE
);

CREATE TABLE IF NOT EXISTS positions_tarifaires (
  code TEXT NOT NULL,
  date_effet DATE NOT NULL DEFAULT '2000-01-01',
  libelle TEXT NOT NULL,
  categorie TEXT,
  taux_dd NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (code, date_effet)
);

CREATE TABLE IF NOT EXISTS codes_taxes (
  code TEXT PRIMARY KEY,
  libelle TEXT NOT NULL,
  ordre INT NOT NULL,
  taux NUMERIC,
  taux_depuis_position BOOLEAN NOT NULL DEFAULT FALSE,
  base_composants TEXT NOT NULL DEFAULT 'VD',
  traitement TEXT NOT NULL DEFAULT 'cout',
  actif BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS exonerations (
  id SERIAL PRIMARY KEY,
  position_prefixe TEXT NOT NULL DEFAULT '',
  origine TEXT NOT NULL DEFAULT '',
  code_taxe TEXT NOT NULL REFERENCES codes_taxes(code),
  taux_applique NUMERIC NOT NULL DEFAULT 0,
  commentaire TEXT
);

CREATE TABLE IF NOT EXISTS taux_change (
  devise TEXT NOT NULL,
  date_cours DATE NOT NULL DEFAULT CURRENT_DATE,
  cours NUMERIC NOT NULL,
  source TEXT,
  PRIMARY KEY (devise, date_cours)
);

CREATE TABLE IF NOT EXISTS dossiers (
  id SERIAL PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  libelle TEXT,
  statut TEXT NOT NULL DEFAULT 'ouvert',
  fournisseur_code TEXT REFERENCES fournisseurs(code),
  devise TEXT NOT NULL DEFAULT 'XOF',
  taux_change NUMERIC NOT NULL DEFAULT 1,
  incoterm TEXT,
  conteneur TEXT,
  poids_total NUMERIC,
  volume_total NUMERIC,
  date_creation TIMESTAMPTZ NOT NULL DEFAULT now(),
  date_embarquement DATE,
  date_declaration DATE,
  date_reception DATE,
  date_cloture DATE,
  commentaire TEXT
);

CREATE TABLE IF NOT EXISTS dossier_pieces (
  id SERIAL PRIMARY KEY,
  dossier_id INT NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  type_piece TEXT NOT NULL,
  reference TEXT,
  date_piece DATE,
  montant NUMERIC,
  devise TEXT,
  commentaire TEXT
);

CREATE TABLE IF NOT EXISTS dossier_lignes (
  id SERIAL PRIMARY KEY,
  dossier_id INT NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  rang INT NOT NULL,
  article_code TEXT REFERENCES articles(code_interne),
  code_barres TEXT,
  libelle TEXT,
  quantite NUMERIC NOT NULL DEFAULT 0,
  nb_cartons NUMERIC,
  prix_unitaire_devise NUMERIC NOT NULL DEFAULT 0,
  montant_devise NUMERIC NOT NULL DEFAULT 0,
  poids_brut NUMERIC,
  poids_estime BOOLEAN NOT NULL DEFAULT FALSE,
  volume NUMERIC,
  volume_estime BOOLEAN NOT NULL DEFAULT FALSE,
  declaration_rang INT
);
CREATE INDEX IF NOT EXISTS idx_dl_dossier ON dossier_lignes(dossier_id);

CREATE TABLE IF NOT EXISTS declaration_articles (
  id SERIAL PRIMARY KEY,
  dossier_id INT NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  rang INT NOT NULL,
  position_tarifaire TEXT NOT NULL,
  designation TEXT,
  origine TEXT,
  valeur_caf NUMERIC NOT NULL DEFAULT 0,
  poids_brut NUMERIC,
  UNIQUE (dossier_id, rang)
);

CREATE TABLE IF NOT EXISTS declaration_taxes (
  id SERIAL PRIMARY KEY,
  declaration_article_id INT NOT NULL REFERENCES declaration_articles(id) ON DELETE CASCADE,
  code_taxe TEXT NOT NULL,
  base NUMERIC NOT NULL DEFAULT 0,
  taux NUMERIC NOT NULL DEFAULT 0,
  montant NUMERIC NOT NULL DEFAULT 0,
  origine_montant TEXT NOT NULL DEFAULT 'simule'
);

CREATE TABLE IF NOT EXISTS dossier_couts (
  id SERIAL PRIMARY KEY,
  dossier_id INT NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  nature TEXT NOT NULL,
  libelle TEXT,
  montant NUMERIC NOT NULL DEFAULT 0,
  devise TEXT NOT NULL DEFAULT 'XOF',
  taux_change NUMERIC NOT NULL DEFAULT 1,
  cle_repartition TEXT NOT NULL DEFAULT 'valeur',
  capitalisable BOOLEAN NOT NULL DEFAULT TRUE,
  provision BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS resultats_couts (
  id SERIAL PRIMARY KEY,
  dossier_id INT NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  ligne_id INT NOT NULL REFERENCES dossier_lignes(id) ON DELETE CASCADE,
  article_code TEXT,
  quantite NUMERIC NOT NULL DEFAULT 0,
  prix_achat_total NUMERIC NOT NULL DEFAULT 0,
  cout_total NUMERIC NOT NULL DEFAULT 0,
  cout_unitaire NUMERIC NOT NULL DEFAULT 0,
  coefficient NUMERIC,
  taux_effectif NUMERIC,
  unite_payante NUMERIC,
  indicateur_up TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  calcule_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dossier_id, ligne_id)
);

CREATE TABLE IF NOT EXISTS formats_magasin (
  code TEXT PRIMARY KEY,
  libelle TEXT NOT NULL,
  logistique_aval_mode TEXT NOT NULL DEFAULT 'pct_valeur',
  logistique_aval_valeur NUMERIC NOT NULL DEFAULT 0,
  demarque_taux NUMERIC NOT NULL DEFAULT 0,
  taux_financement NUMERIC NOT NULL DEFAULT 0,
  rotation_jours NUMERIC NOT NULL DEFAULT 30,
  arrondi_regle TEXT NOT NULL DEFAULT 'plus_proche',
  arrondi_pas NUMERIC NOT NULL DEFAULT 5,
  terminaison TEXT
);

CREATE TABLE IF NOT EXISTS points_de_vente (
  code TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  format_code TEXT REFERENCES formats_magasin(code),
  zone_prix TEXT,
  ville TEXT
);

CREATE TABLE IF NOT EXISTS politiques_tarifaires (
  id SERIAL PRIMARY KEY,
  famille_code TEXT REFERENCES familles(code),
  format_code TEXT REFERENCES formats_magasin(code),
  taux_marque_cible NUMERIC NOT NULL,
  taux_marque_plancher NUMERIC NOT NULL DEFAULT 0,
  mode_arbitrage TEXT NOT NULL DEFAULT 'marge',
  indice_cible NUMERIC,
  encadrement_pct NUMERIC,
  UNIQUE (famille_code, format_code)
);

CREATE TABLE IF NOT EXISTS tarifs (
  id SERIAL PRIMARY KEY,
  article_code TEXT NOT NULL REFERENCES articles(code_interne),
  format_code TEXT NOT NULL REFERENCES formats_magasin(code),
  prix_ttc NUMERIC NOT NULL,
  prix_ht NUMERIC NOT NULL,
  cout_mise_en_rayon NUMERIC,
  taux_marque NUMERIC,
  contrainte TEXT,
  statut TEXT NOT NULL DEFAULT 'propose',
  justification TEXT,
  auteur TEXT,
  date_effet DATE NOT NULL DEFAULT CURRENT_DATE,
  date_fin DATE,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  alerte TEXT
);
CREATE INDEX IF NOT EXISTS idx_tarifs_article ON tarifs(article_code, format_code);

CREATE TABLE IF NOT EXISTS enseignes_concurrentes (
  code TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  type TEXT,
  site_web TEXT
);

CREATE TABLE IF NOT EXISTS releves_concurrents (
  id SERIAL PRIMARY KEY,
  code_barres TEXT NOT NULL,
  article_code TEXT REFERENCES articles(code_interne),
  enseigne_code TEXT REFERENCES enseignes_concurrentes(code),
  point_de_releve TEXT,
  date_releve DATE NOT NULL DEFAULT CURRENT_DATE,
  prix_ttc NUMERIC NOT NULL,
  type_prix TEXT NOT NULL DEFAULT 'fond_de_rayon',
  disponibilite TEXT,
  conditionnement TEXT,
  source TEXT NOT NULL DEFAULT 'terrain',
  justificatif TEXT,
  auteur TEXT,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_releves_cb ON releves_concurrents(code_barres);
CREATE INDEX IF NOT EXISTS idx_releves_article ON releves_concurrents(article_code);

CREATE TABLE IF NOT EXISTS journal_audit (
  id SERIAL PRIMARY KEY,
  utilisateur TEXT,
  action TEXT NOT NULL,
  objet_type TEXT NOT NULL,
  objet_id TEXT,
  detail TEXT,
  date_action TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lot 1 : sécurité des comptes et inaltérabilité du journal
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS doit_changer_mdp BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS echecs_connexion INT NOT NULL DEFAULT 0;
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS verrou_jusqua TIMESTAMPTZ;
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS totp_actif BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE journal_audit ADD COLUMN IF NOT EXISTS hash_precedent TEXT;
ALTER TABLE journal_audit ADD COLUMN IF NOT EXISTS hash TEXT;

-- Lot 2 : ventes remontées, marge réalisée, révisions de coût, barèmes de provision, règles de validation
CREATE TABLE IF NOT EXISTS ventes (
  id SERIAL PRIMARY KEY,
  article_code TEXT NOT NULL REFERENCES articles(code_interne),
  point_de_vente_code TEXT,
  date_vente DATE NOT NULL,
  quantite NUMERIC NOT NULL DEFAULT 0,
  ca_ttc NUMERIC NOT NULL DEFAULT 0,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ventes_article ON ventes(article_code, date_vente);

CREATE TABLE IF NOT EXISTS revisions_cout (
  id SERIAL PRIMARY KEY,
  dossier_id INT NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  article_code TEXT,
  quantite NUMERIC NOT NULL DEFAULT 0,
  stock_restant NUMERIC NOT NULL DEFAULT 0,
  cout_unitaire_avant NUMERIC NOT NULL DEFAULT 0,
  cout_unitaire_apres NUMERIC NOT NULL DEFAULT 0,
  ajustement_stock NUMERIC NOT NULL DEFAULT 0,
  ajustement_charge NUMERIC NOT NULL DEFAULT 0,
  date_revision TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS baremes_provision (
  nature TEXT PRIMARY KEY,
  cle_repartition TEXT NOT NULL DEFAULT 'valeur',
  mode TEXT NOT NULL DEFAULT 'pct_valeur',
  valeur NUMERIC NOT NULL DEFAULT 0,
  nb_dossiers INT NOT NULL DEFAULT 0,
  dernier_dossier TEXT,
  date_maj TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS regles_validation (
  id SERIAL PRIMARY KEY,
  taux_marque_min NUMERIC,
  ecart_prix_max_pct NUMERIC,
  actif BOOLEAN NOT NULL DEFAULT TRUE
);

-- Lot 3 : promotions, fichiers de pièces, notifications
CREATE TABLE IF NOT EXISTS promotions (
  id SERIAL PRIMARY KEY,
  libelle TEXT NOT NULL,
  article_code TEXT REFERENCES articles(code_interne),
  famille_code TEXT REFERENCES familles(code),
  format_code TEXT REFERENCES formats_magasin(code),
  taux_remise NUMERIC NOT NULL,
  date_debut DATE NOT NULL,
  date_fin DATE NOT NULL,
  marge_min NUMERIC NOT NULL DEFAULT 0,
  statut TEXT NOT NULL DEFAULT 'prevue',
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pieces_fichiers (
  id SERIAL PRIMARY KEY,
  piece_id INT NOT NULL REFERENCES dossier_pieces(id) ON DELETE CASCADE,
  nom_fichier TEXT NOT NULL,
  type_mime TEXT NOT NULL,
  taille INT NOT NULL,
  contenu BYTEA NOT NULL,
  televerse_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Compléments fiche article : photos (F-M1-13), articles liés et variantes (F-M1-12, F-M1-15)
CREATE TABLE IF NOT EXISTS articles_photos (
  id SERIAL PRIMARY KEY,
  article_code TEXT NOT NULL REFERENCES articles(code_interne) ON DELETE CASCADE,
  nom_fichier TEXT NOT NULL,
  type_mime TEXT NOT NULL,
  taille INT NOT NULL,
  contenu BYTEA NOT NULL,
  televerse_le TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_photos_article ON articles_photos(article_code);

CREATE TABLE IF NOT EXISTS articles_lies (
  id SERIAL PRIMARY KEY,
  article_code TEXT NOT NULL REFERENCES articles(code_interne) ON DELETE CASCADE,
  article_lie_code TEXT NOT NULL REFERENCES articles(code_interne) ON DELETE CASCADE,
  type_lien TEXT NOT NULL,
  description TEXT,
  UNIQUE (article_code, article_lie_code, type_lien)
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  destinataire_role TEXT,
  destinataire_email TEXT,
  titre TEXT NOT NULL,
  corps TEXT,
  lien TEXT,
  lue BOOLEAN NOT NULL DEFAULT FALSE,
  envoyee_courriel BOOLEAN NOT NULL DEFAULT FALSE,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_role ON notifications(destinataire_role, lue);
`;

/* Index de recherche approchée (facultatif : nécessite le droit CREATE EXTENSION). */
async function extensionsRecherche() {
  try {
    await query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await query(`CREATE INDEX IF NOT EXISTS idx_articles_libelle_trgm ON articles USING gin (libelle gin_trgm_ops)`);
  } catch (e) {
    console.warn('[base] pg_trgm indisponible (recherche non indexée) :', e.message);
  }
}

/* Exécute fn dans une transaction ; fn reçoit une fonction query liée au client. */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultat = await fn((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return resultat;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  await query(SCHEMA);
}

async function seed() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM utilisateurs');
  if (rows[0].n > 0) return;

  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
  // Sans ADMIN_PASSWORD explicite, le mot de passe par défaut doit être changé à la première connexion.
  await query(
    `INSERT INTO utilisateurs (email, mot_de_passe_hash, nom, role, doit_changer_mdp) VALUES ($1,$2,$3,'admin',$4)`,
    [process.env.ADMIN_EMAIL || 'admin@demo.sn', hash, 'Administrateur', !process.env.ADMIN_PASSWORD]
  );

  await query(`INSERT INTO parametres (cle, valeur) VALUES
    ('devise_reference','XOF'),
    ('ratio_unite_payante','1'),
    ('entreprise','Enseigne de démonstration')
    ON CONFLICT (cle) DO NOTHING`);

  // Codes taxes : peuplés par seedFiscalite() (données server/data/taxes_senegal.js)

  // Catégories du TEC UEMOA : 0 %, 5 %, 10 %, 20 %, 35 %
  await query(`INSERT INTO positions_tarifaires (code, libelle, categorie, taux_dd) VALUES
    ('1006309000','Riz semi-blanchi ou blanchi','Cat. 1',10),
    ('1701999000','Sucre raffiné','Cat. 2',20),
    ('0402211000','Lait en poudre entier','Cat. 2',5),
    ('1511909000','Huile de palme raffinée','Cat. 2',10),
    ('1902190000','Pâtes alimentaires','Cat. 3',20),
    ('2202990000','Boissons non alcoolisées','Cat. 3',20),
    ('3401110000','Savons de toilette','Cat. 3',20),
    ('3402209000','Détergents conditionnés','Cat. 3',20),
    ('4818100000','Papier hygiénique','Cat. 3',20),
    ('7321111000','Réchauds à gaz','Cat. 3',20),
    ('8516600000','Cuisinières électriques','Cat. 3',20),
    ('9403609000','Meubles en bois','Cat. 4',35)
    ON CONFLICT DO NOTHING`);

  await query(`INSERT INTO formats_magasin (code, libelle, logistique_aval_mode, logistique_aval_valeur, demarque_taux, taux_financement, rotation_jours, arrondi_regle, arrondi_pas, terminaison) VALUES
    ('HYP','Hypermarché','pct_valeur',2.0,1.0,8,35,'plus_proche',25,NULL),
    ('SUP','Supermarché','pct_valeur',2.5,1.2,8,30,'plus_proche',25,NULL),
    ('PROX','Proximité','pct_valeur',3.5,1.5,8,25,'superieur',50,NULL),
    ('CASH','Cash & Carry','pct_valeur',1.2,0.5,8,20,'plus_proche',5,NULL),
    ('WEB','Commerce en ligne','pct_valeur',4.0,0.3,8,15,'plus_proche',5,NULL)
    ON CONFLICT DO NOTHING`);

  await query(`INSERT INTO familles (code, libelle, niveau, marge_cible) VALUES
    ('PGC','Produits grande consommation',1,22),
    ('EPICERIE','Épicerie',2,20),
    ('LIQUIDES','Liquides',2,18),
    ('DPH','Droguerie parfumerie hygiène',2,25),
    ('BAZAR','Bazar',1,30),
    ('ELECTRO','Électroménager',2,28)
    ON CONFLICT DO NOTHING`);
  await query(`UPDATE familles SET parent_code='PGC' WHERE code IN ('EPICERIE','LIQUIDES','DPH') AND parent_code IS NULL`);
  await query(`UPDATE familles SET parent_code='BAZAR' WHERE code='ELECTRO' AND parent_code IS NULL`);

  await query(`INSERT INTO enseignes_concurrentes (code, nom, type) VALUES
    ('AUCH','Auchan Sénégal','moderne'),
    ('CARR','Carrefour Market','moderne'),
    ('EXKI','Exclusive / autres','moderne'),
    ('MARCHE','Marché traditionnel','traditionnel')
    ON CONFLICT DO NOTHING`);

  await query(`INSERT INTO journal_audit (utilisateur, action, objet_type, detail)
    VALUES ('système','initialisation','base','Amorçage initial des référentiels')`);
}

/*
 * Nomenclature TEC CEDEAO/UEMOA (Sénégal) : 97 chapitres avec taux dominant
 * et positions détaillées pour la grande distribution. Idempotent : n'écrase
 * jamais une position déjà présente (saisie manuelle ou import officiel).
 */
async function seedNomenclature() {
  const { CHAPITRES, POSITIONS, categorie } = require('./data/tec_cedeao');
  const lignes = [
    ...CHAPITRES.map(([code, libelle, taux]) => ({ code, libelle: `Chapitre ${code} : ${libelle}`, taux })),
    ...POSITIONS.map(([code, libelle, taux]) => ({ code, libelle, taux }))
  ];
  await transaction(async q => {
    for (const l of lignes) {
      await q(
        `INSERT INTO positions_tarifaires (code, libelle, categorie, taux_dd)
         VALUES ($1,$2,$3,$4) ON CONFLICT (code, date_effet) DO NOTHING`,
        [l.code, l.libelle, categorie(l.taux), l.taux]);
    }
  });
}

/*
 * Fiscalité de porte sénégalaise : codes taxes en cascade et règles spécifiques par
 * produit (accises, TCI, exonérations de TVA, origine communautaire). Idempotent :
 * n'écrase jamais un code taxe modifié ni une règle déjà présente. Migration ciblée :
 * la base de la TVA n'est mise à jour que si elle porte encore sa valeur d'origine.
 */
async function seedFiscalite() {
  const { CODES_TAXES, REGLES } = require('./data/taxes_senegal');
  await transaction(async q => {
    for (const [code, libelle, ordre, taux, depuisPosition, base, traitement] of CODES_TAXES) {
      await q(
        `INSERT INTO codes_taxes (code, libelle, ordre, taux, taux_depuis_position, base_composants, traitement)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING`,
        [code, libelle, ordre, taux, depuisPosition, base, traitement]);
    }
    // Bases historiques : y insérer la TCI uniquement si le paramétrage n'a pas été touché
    await q(
      `UPDATE codes_taxes SET base_composants='VD+DD+RS+PCS+PCC+COSEC+TCI+ACC'
        WHERE code='TVA' AND base_composants='VD+DD+RS+PCS+PCC+COSEC+ACC'`);
    await q(
      `UPDATE codes_taxes SET ordre=7 WHERE code='ACC' AND ordre=6`);
    await q(
      `UPDATE codes_taxes SET ordre=8 WHERE code='TVA' AND ordre=7`);
    await q(
      `UPDATE codes_taxes SET ordre=9 WHERE code='AIB' AND ordre=8`);
    for (const [prefixe, origine, codeTaxe, taux, commentaire] of REGLES) {
      const { rows } = await q(
        `SELECT 1 FROM exonerations WHERE position_prefixe=$1 AND origine=$2 AND code_taxe=$3`,
        [prefixe, origine, codeTaxe]);
      if (!rows.length) {
        await q(
          `INSERT INTO exonerations (position_prefixe, origine, code_taxe, taux_applique, commentaire)
           VALUES ($1,$2,$3,$4,$5)`,
          [prefixe, origine, codeTaxe, taux, commentaire]);
      }
    }
  });
}

async function init() {
  if (!process.env.DATABASE_URL) {
    console.warn('[base] DATABASE_URL non définie : tentative sur postgres://localhost:5432/tarifaire. ' +
      'Sur Railway, ajoutez un service PostgreSQL et la variable DATABASE_URL=${{Postgres.DATABASE_URL}}.');
  }
  await attendreBase();
  await migrate();
  await extensionsRecherche();
  await seed();
  await seedNomenclature();
  await seedFiscalite();
}

module.exports = { query, init, transaction };
