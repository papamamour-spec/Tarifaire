'use strict';
/*
 * Tests d'intégration : rejouent le parcours du lot 1 du CDC et les fonctions des lots 2 à 4
 * contre une vraie base PostgreSQL. Nécessitent DATABASE_URL (base VIDE dédiée aux tests) ;
 * ignorés sinon. En CI, GitHub Actions fournit un service PostgreSQL propre.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const BASE_URL = process.env.DATABASE_URL;
// Port dérivé du PID : deux exécutions concurrentes ou un zombie ne se marchent pas dessus
const PORT = process.env.TEST_PORT || (3500 + (process.pid % 400));
const B = `http://localhost:${PORT}/api`;
const actif = !!BASE_URL;

let serveur = null;
let jeton = null;

async function api(chemin, options = {}) {
  const opts = { headers: { 'Content-Type': 'application/json' }, ...options };
  if (jeton) opts.headers.Authorization = 'Bearer ' + jeton;
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const rep = await fetch(B + chemin, opts);
  const data = await rep.json().catch(() => ({}));
  if (!rep.ok) {
    const e = new Error(data.erreur || 'HTTP ' + rep.status);
    e.statut = rep.status; e.data = data;
    throw e;
  }
  return data;
}

before(async () => {
  if (!actif) return;
  // Base rendue vierge avant chaque exécution : la suite est rejouable localement
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: BASE_URL });
  try {
    const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`);
    if (rows.length) {
      await pool.query(`TRUNCATE ${rows.map(r => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await pool.end();
  }
  serveur = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: BASE_URL, JWT_SECRET: 'secret-de-test' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 60; i++) {
    try {
      const s = await (await fetch(`${B}/sante`)).json();
      if (s.base === 'connectee') return;
    } catch { /* pas encore prêt */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Le serveur de test n’a pas démarré');
});

after(() => { if (serveur) serveur.kill('SIGTERM'); });

test('connexion et jeton', { skip: !actif }, async () => {
  const r = await api('/connexion', { method: 'POST', body: { email: 'admin@demo.sn', mot_de_passe: 'admin123' } });
  assert.ok(r.token);
  jeton = r.token;
});

test('parcours lot 1 : référentiel, dossier, liquidation, coût de revient exact', { skip: !actif }, async () => {
  await api('/referentiels/fournisseurs', { method: 'POST', body: { code: 'TEST', nom: 'Fournisseur test', devise: 'USD' } });

  const importArticles = await api('/referentiels/articles-import/csv', {
    method: 'POST',
    body: {
      confirmer: true,
      contenu: ['code_interne;code_barres;libelle;famille;unites_par_carton;poids_brut_carton;longueur_carton;largeur_carton;hauteur_carton;position_tarifaire;origine;taux_tva_vente;statut',
        'T001;6111242100992;Riz test 5kg;EPICERIE;4;21;40;30;25;1006309000;TH;18;actif',
        'T002;6111242200999;Savon test;DPH;48;10.5;40;30;20;3401110000;ID;18;actif'].join('\n')
    }
  });
  assert.equal(importArticles.crees + importArticles.modifies, 2);
  assert.equal(importArticles.rejets.length, 0);

  const dossier = await api('/dossiers', {
    method: 'POST',
    body: { reference: 'TEST-001', fournisseur_code: 'TEST', devise: 'USD', taux_change: 600, poids_total: 12600, volume_total: 20 }
  });
  const id = dossier.id;

  const facture = await api(`/dossiers/${id}/lignes-import/csv`, {
    method: 'POST',
    body: {
      contenu: ['code_barres;libelle;quantite;prix_unitaire;nb_cartons;poids_brut',
        '6111242100992;Riz;2000;3.2;500;10500', '6111242200999;Savon;9600;0.25;200;2100'].join('\n')
    }
  });
  assert.equal(facture.appariees, 2);

  await api(`/dossiers/${id}/couts`, { method: 'POST', body: { nature: 'fret', libelle: 'Fret', montant: 2000, devise: 'USD', taux_change: 600, cle_repartition: 'unite_payante' } });
  await api(`/dossiers/${id}/couts`, { method: 'POST', body: { nature: 'transitaire', libelle: 'Transitaire', montant: 300000, cle_repartition: 'valeur' } });

  await api(`/dossiers/${id}/declaration-import/csv`, {
    method: 'POST',
    body: {
      contenu: ['rang;position_tarifaire;designation;origine;valeur_caf;poids_brut',
        '1;1006309000;Riz;TH;3840000;10500', '2;3401110000;Savon;ID;1440000;2100'].join('\n')
    }
  });
  await api(`/dossiers/${id}/liquider`, { method: 'POST' });
  const rattachement = await api(`/dossiers/${id}/rattacher-auto`, { method: 'POST' });
  assert.equal(rattachement.rattachees, 2);

  const calcul = await api(`/dossiers/${id}/calculer`, { method: 'POST' });
  assert.equal(calcul.alertes.length, 0);
  // R03 : la somme des coûts répartis est strictement égale aux coûts saisis
  const sommeComposantes = calcul.lignes.reduce((s, l) => s + l.composantes.reduce((s2, c) => s2 + c.montant, 0), 0);
  assert.equal(Math.round(sommeComposantes), Math.round(calcul.totaux.cout_total));
  // Le taux effectif diffère entre lignes tarifaires (pas de coefficient unique)
  const tauxEffectifs = calcul.lignes.map(l => l.taux_effectif);
  assert.notEqual(tauxEffectifs[0], tauxEffectifs[1]);
  // La TVA et l'acompte sont en créance, pas dans le coût
  assert.ok(calcul.totaux.taxes_creance > 0);
});

test('liquidation en cascade : la TVA est assise sur la valeur majorée des droits', { skip: !actif }, async () => {
  const sim = await api('/douane/simulation', { method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '1006309000' } });
  const tva = sim.lignes.find(l => l.code === 'TVA');
  assert.ok(tva.base > 1000000, 'la base TVA doit inclure les droits en cascade');
  assert.equal(tva.traitement, 'creance');
  const dd = sim.lignes.find(l => l.code === 'DD');
  assert.equal(dd.taux, 10);
});

test('lot 2 : moteur de prix, seuils de validation, publication', { skip: !actif }, async () => {
  await api('/tarification/regles-validation', { method: 'POST', body: { taux_marque_min: 15, ecart_prix_max_pct: 20 } });
  const props = await api('/tarification/proposer', { method: 'POST', body: { article_code: 'T001', format_codes: ['SUP'] } });
  assert.equal(props.propositions.length, 1);
  const p = props.propositions[0];
  assert.ok(p.prix_ttc_propose > 0);
  assert.ok(['marge', 'marche', 'plancher'].includes(p.contrainte));

  const enr = await api('/tarification/tarifs', {
    method: 'POST',
    body: { tarifs: [{ article_code: p.article_code, format_code: p.format_code, prix_ttc: p.prix_ttc_propose, cout_mise_en_rayon: p.cout_mise_en_rayon, taux_marque: p.taux_marque }] }
  });
  assert.equal(enr.crees, 1);

  const tarifs = await api('/tarification/tarifs?article=T001');
  const dernier = tarifs[0];
  await api(`/tarification/tarifs/${dernier.id}/statut`, { method: 'POST', body: { statut: 'publie' } });

  // Une proposition à marge trop faible passe en a_valider
  const basseMarge = await api('/tarification/tarifs', {
    method: 'POST',
    body: { tarifs: [{ article_code: 'T001', format_code: 'SUP', prix_ttc: dernier.prix_ttc, taux_marque: 2 }] }
  });
  assert.equal(basseMarge.a_valider, 1);
});

test('lot 2 : révision après facture tardive avec alerte de prix', { skip: !actif }, async () => {
  const dossiers = await api('/dossiers');
  const id = dossiers.find(d => d.reference === 'TEST-001').id;
  // Facture tardive : surestaries capitalisables importantes
  await api(`/dossiers/${id}/couts`, { method: 'POST', body: { nature: 'transitaire', libelle: 'Facture tardive', montant: 2000000, cle_repartition: 'valeur' } });
  const rev = await api(`/dossiers/${id}/reviser`, { method: 'POST', body: { stocks: [{ article_code: 'T001', stock_restant: 500 }] } });
  assert.ok(rev.revisions.length >= 1);
  const r1 = rev.revisions.find(x => x.article_code === 'T001');
  assert.ok(r1.cout_unitaire_apres > r1.cout_unitaire_avant);
  // 500 en stock sur 2000 : l'essentiel de l'ajustement part en charge
  assert.ok(Math.abs(r1.ajustement_charge) > Math.abs(r1.ajustement_stock));
});

test('lot 2 : clôture, barèmes appris et provisions proposées', { skip: !actif }, async () => {
  const dossiers = await api('/dossiers');
  const id = dossiers.find(d => d.reference === 'TEST-001').id;
  const cloture = await api(`/dossiers/${id}/statut`, { method: 'POST', body: { statut: 'cloture' } });
  assert.ok(cloture.baremes_appris >= 2);

  const nouveau = await api('/dossiers', { method: 'POST', body: { reference: 'TEST-002', devise: 'XOF', taux_change: 1, poids_total: 1000, volume_total: 2 } });
  await api(`/dossiers/${nouveau.id}/lignes`, { method: 'POST', body: { code_barres: '6111242100992', quantite: 100, prix_unitaire_devise: 2000, nb_cartons: 25, poids_brut: 525 } });
  const provisions = await api(`/dossiers/${nouveau.id}/provisions-proposees`);
  assert.ok(provisions.length >= 1, 'les barèmes appris doivent proposer des provisions');
  const application = await api(`/dossiers/${nouveau.id}/provisions-appliquer`, { method: 'POST' });
  assert.equal(application.creees, provisions.length);
});

test('lot 2 : import des ventes et marge réalisée', { skip: !actif }, async () => {
  const imp = await api('/pilotage/ventes-import/csv', {
    method: 'POST',
    body: { contenu: 'code_barres;point_de_vente;date_vente;quantite;ca_ttc\n6111242100992;MAG1;2026-08-01;100;400000' }
  });
  assert.equal(imp.importees, 1);
  const marge = await api('/pilotage/marge-realisee');
  assert.equal(marge.lignes.length, 1);
  assert.ok(marge.lignes[0].taux_marque_realise !== null);
  assert.ok(marge.lignes[0].taux_marque_theorique !== null);
});

test('lot 3 : veille avec détection de prix aberrant', { skip: !actif }, async () => {
  await api('/veille/releves', { method: 'POST', body: { code_barres: '6111242100992', enseigne_code: 'AUCH', prix_ttc: 3500 } });
  await assert.rejects(
    api('/veille/releves', { method: 'POST', body: { code_barres: '6111242100992', enseigne_code: 'AUCH', prix_ttc: 90000 } }),
    e => e.statut === 409
  );
});

test('lot 3 : contrôles de cohérence exécutables', { skip: !actif }, async () => {
  const r = await api('/tarification/controles?format=SUP');
  assert.ok(Array.isArray(r.anomalies));
});

test('lot 3 : promotion et simulation de marge', { skip: !actif }, async () => {
  const promo = await api('/tarification/promotions', {
    method: 'POST',
    body: { libelle: 'Test promo', article_code: 'T001', taux_remise: 50, date_debut: '2026-08-01', date_fin: '2026-08-15', marge_min: 5 }
  });
  const sim = await api(`/tarification/promotions/${promo.id}/simulation`);
  assert.ok(sim.lignes.length >= 1);
  assert.ok(sim.lignes[0].prix_promo < sim.lignes[0].prix_normal);
});

test('lot 4 : 2FA de bout en bout', { skip: !actif }, async () => {
  const { codeTotp } = require('../server/totp');
  const prep = await api('/compte/2fa/preparer', { method: 'POST' });
  assert.ok(prep.secret.length >= 16);
  const code = codeTotp(prep.secret, Math.floor(Date.now() / 1000 / 30));
  await api('/compte/2fa/confirmer', { method: 'POST', body: { code } });
  // La connexion sans code doit maintenant répondre 428
  await assert.rejects(
    api('/connexion', { method: 'POST', body: { email: 'admin@demo.sn', mot_de_passe: 'admin123' } }),
    e => e.statut === 428 && e.data.exige_2fa
  );
  // Avec le code, elle passe
  const code2 = codeTotp(prep.secret, Math.floor(Date.now() / 1000 / 30));
  const r = await api('/connexion', { method: 'POST', body: { email: 'admin@demo.sn', mot_de_passe: 'admin123', code_2fa: code2 } });
  assert.ok(r.token);
  await api('/compte/2fa/desactiver', { method: 'POST', body: { code: codeTotp(prep.secret, Math.floor(Date.now() / 1000 / 30)) } });
});

test('lot 1 : journal d’audit chaîné intègre', { skip: !actif }, async () => {
  const v = await api('/admin/journal-verification');
  assert.equal(v.integre, true);
  assert.ok(v.entrees_verifiees > 5);
});

test('lot 1 : verrouillage de compte après échecs répétés', { skip: !actif }, async () => {
  await api('/admin/utilisateurs', {
    method: 'POST',
    body: { email: 'verrou@test.sn', nom: 'Test verrou', role: 'lecture', mot_de_passe: 'motdepasse-solide' }
  });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      api('/connexion', { method: 'POST', body: { email: 'verrou@test.sn', mot_de_passe: 'faux' } }),
      e => e.statut === 401
    );
  }
  // Même le bon mot de passe est refusé pendant le verrou
  await assert.rejects(
    api('/connexion', { method: 'POST', body: { email: 'verrou@test.sn', mot_de_passe: 'motdepasse-solide' } }),
    e => e.statut === 423
  );
});

test('référentiel : article multi-fournisseurs, principal et comparaison', { skip: !actif }, async () => {
  await api('/referentiels/fournisseurs', { method: 'POST', body: { code: 'FRN2', nom: 'Deuxième fournisseur', pays: 'TR', devise: 'USD' } });
  await api('/admin/taux-change', { method: 'POST', body: { devise: 'USD', cours: 600 } });

  // T001 a déjà TEST comme fournisseur potentiel ; on rattache deux conditions
  await api('/referentiels/conditions-achat', {
    method: 'POST', body: { fournisseur_code: 'TEST', article_code: 'T001', prix_achat: 2000, devise: 'XOF' }
  });
  await api('/referentiels/conditions-achat', {
    method: 'POST', body: { fournisseur_code: 'FRN2', article_code: 'T001', prix_achat: 3, devise: 'USD', remise_pct: 10 }
  });

  const comp = await api('/referentiels/articles/T001/comparaison-fournisseurs');
  assert.equal(comp.comparaison.length, 2);
  // FRN2 : 3 USD - 10 % = 2,7 USD x 600 = 1620 F, moins cher que 2000 F : premier du classement
  assert.equal(comp.comparaison[0].fournisseur_code, 'FRN2');
  assert.equal(comp.comparaison[0].prix_net_xof, 1620);

  // Rattacher un fournisseur sans condition est refusé
  await assert.rejects(
    api('/referentiels/articles/T001/fournisseur-principal', { method: 'POST', body: { fournisseur_code: 'INEXISTANT' } }),
    e => e.statut === 400
  );
  // Bascule du principal vers FRN2
  await api('/referentiels/articles/T001/fournisseur-principal', { method: 'POST', body: { fournisseur_code: 'FRN2' } });
  const comp2 = await api('/referentiels/articles/T001/comparaison-fournisseurs');
  assert.equal(comp2.principal, 'FRN2');

  // Codes barres secondaires : ajout valide, doublon refusé
  await api('/referentiels/articles/T001/codes-barres', { method: 'POST', body: { code_barres: '96385074', description: 'lot de 6' } });
  await assert.rejects(
    api('/referentiels/articles/T002/codes-barres', { method: 'POST', body: { code_barres: '96385074' } }),
    e => e.statut === 409
  );
  const fiche = await api('/referentiels/articles/T001');
  assert.equal(fiche.codes_barres_secondaires.length, 1);
  assert.equal(fiche.conditions_achat.length, 2);
});

test('fiche article : photos, articles liés, suggestion de position', { skip: !actif }, async () => {
  // Photo (téléversement binaire brut)
  const rep = await fetch(`${B}/referentiels/articles/T001/photos`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + jeton, 'Content-Type': 'image/png', 'X-Nom-Fichier': 'photo.png' },
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
  });
  assert.equal(rep.ok, true);
  const photos = await api('/referentiels/articles/T001/photos');
  assert.equal(photos.length, 1);

  // Article lié de type variante
  await api('/referentiels/articles/T001/liens', {
    method: 'POST', body: { article_lie_code: 'T002', type_lien: 'variante', description: 'parfum différent' }
  });
  const fiche = await api('/referentiels/articles/T001');
  assert.equal(fiche.liens.length, 1);
  assert.equal(fiche.photos.length, 1);
  // Le lien apparaît aussi côté article lié (sens entrant)
  const fiche2 = await api('/referentiels/articles/T002');
  assert.equal(fiche2.liens.length, 1);

  // Suggestion de position depuis un libellé
  const suggestions = await api('/referentiels/suggestion-position?libelle=' + encodeURIComponent('Riz blanchi parfumé'));
  assert.ok(suggestions.length >= 1);
  assert.ok(suggestions[0].code.startsWith('100630'), `suggestion attendue dans le riz blanchi, obtenu ${suggestions[0].code}`);
});

test('M2-05 et M5-11/12 : écart de liquidation, comparaison des clés, simulation de variation', { skip: !actif }, async () => {
  const dossiers = await api('/dossiers');
  const id = dossiers.find(d => d.reference === 'TEST-001').id;

  const ecarts = await api(`/dossiers/${id}/ecart-liquidation`);
  assert.equal(ecarts.length, 2);
  assert.ok(ecarts[0].total_simule > 0);

  const cles = await api(`/dossiers/${id}/comparaison-cles`);
  assert.equal(cles.lignes.length, 2);
  // Les taux effectifs différant fortement entre riz (cat. 1) et savon (cat. 3),
  // la clé unique doit produire un écart non nul
  assert.ok(cles.ecart_max_pct > 0);

  const variation = await api(`/dossiers/${id}/simulation-variation`, {
    method: 'POST', body: { fret_pct: 50 }
  });
  assert.equal(variation.lignes.length, 2);
  for (const l of variation.lignes) assert.ok(l.cout_unitaire_simule > l.cout_unitaire_actuel);
});

test('M5-06 : TVA rémanente lorsque le prorata de déduction est inférieur à 100 %', { skip: !actif }, async () => {
  const dossiers = await api('/dossiers');
  const id = dossiers.find(d => d.reference === 'TEST-001').id;
  const avant = await api(`/dossiers/${id}/calculer`, { method: 'POST' });
  await api('/admin/parametres', { method: 'POST', body: { cle: 'prorata_deduction', valeur: '80' } });
  const apres = await api(`/dossiers/${id}/calculer`, { method: 'POST' });
  // 20 % de la TVA bascule de la créance vers le coût
  assert.ok(apres.totaux.cout_total > avant.totaux.cout_total);
  assert.ok(apres.totaux.taxes_creance < avant.totaux.taxes_creance);
  const difference = apres.totaux.cout_total - avant.totaux.cout_total;
  const baisseCreance = avant.totaux.taxes_creance - apres.totaux.taxes_creance;
  assert.ok(Math.abs(difference - baisseCreance) <= 2, 'le transfert créance vers coût doit être symétrique');
  await api('/admin/parametres', { method: 'POST', body: { cle: 'prorata_deduction', valeur: '100' } });
  await api(`/dossiers/${id}/calculer`, { method: 'POST' });
});

test('M11-09 : export complet des données', { skip: !actif }, async () => {
  const exportation = await api('/admin/export-complet');
  assert.ok(exportation.tables.articles.length >= 2);
  assert.ok(exportation.tables.codes_taxes.length >= 8);
  assert.ok(Object.keys(exportation.tables).length >= 25);
});

test('référentiel : modification en masse, suppressions gardées', { skip: !actif }, async () => {
  // Modification en masse : reclassement de famille + sensibilité
  await api('/referentiels/familles', { method: 'POST', body: { code: 'NOUVELLE', libelle: 'Nouvelle famille' } });
  const lot = await api('/referentiels/articles-modifier-lot', {
    method: 'POST',
    body: { codes: ['T001', 'T002'], champs: { famille_code: 'NOUVELLE', sensibilite_prix: 'elevee' } }
  });
  assert.equal(lot.modifies, 2);
  const fiche = await api('/referentiels/articles/T001');
  assert.equal(fiche.famille_code, 'NOUVELLE');
  assert.equal(fiche.sensibilite_prix, 'elevee');
  // Le changement est tracé dans l'historique
  assert.ok(fiche.historique.some(h => h.champ === 'famille_code' && h.source === 'modification_lot'));

  // Suppression d'une famille avec articles : refusée
  await assert.rejects(
    api('/referentiels/familles/NOUVELLE', { method: 'DELETE' }),
    e => e.statut === 409
  );
  // Après reclassement, la suppression passe
  await api('/referentiels/articles-modifier-lot', {
    method: 'POST', body: { codes: ['T001', 'T002'], champs: { famille_code: 'EPICERIE' } }
  });
  await api('/referentiels/familles/NOUVELLE', { method: 'DELETE' });

  // Suppression d'un article utilisé dans un dossier : refusée avec le détail des usages
  await assert.rejects(
    api('/referentiels/articles/T001', { method: 'DELETE' }),
    e => e.statut === 409 && e.data.usages && e.data.usages.dossier_lignes > 0
  );
  // Un article jamais utilisé se supprime
  await api('/referentiels/articles', { method: 'POST', body: { code_interne: 'TEMP1', libelle: 'Article temporaire' } });
  await api('/referentiels/articles/TEMP1', { method: 'DELETE' });
  await assert.rejects(api('/referentiels/articles/TEMP1'), e => e.statut === 404);

  // Suppression d'un fournisseur référencé : refusée
  await assert.rejects(
    api('/referentiels/fournisseurs/TEST', { method: 'DELETE' }),
    e => e.statut === 409
  );
});

test('nomenclature TEC : base préchargée et résolution hiérarchique', { skip: !actif }, async () => {
  // La base préchargée compte les 97 chapitres et les positions détaillées
  const positions = await api('/douane/positions');
  assert.ok(positions.length >= 250, `attendu >= 250 positions préchargées, obtenu ${positions.length}`);

  // Position exacte présente : niveau exact
  const exacte = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '1006309000' }
  });
  assert.equal(exacte.position.niveau, 'exact');
  assert.equal(exacte.position.taux_dd, 10);

  // Position à 10 chiffres inconnue : repli sur la sous-position 1905 (biscuits, 20 %)
  const repli = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '1905321100' }
  });
  assert.equal(repli.position.niveau, 'approche');
  assert.equal(repli.position.code, '1905');
  assert.equal(repli.position.taux_dd, 20);
  assert.equal(repli.lignes.find(l => l.code === 'DD').montant, 200000);

  // Repli au niveau chapitre : code inconnu du chapitre 84 (machines, 5 %)
  const chapitre = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '8477591234' }
  });
  assert.equal(chapitre.position.niveau, 'approche');
  assert.equal(chapitre.position.code, '84');
  assert.equal(chapitre.position.taux_dd, 5);

  // Une position exacte saisie prime sur le niveau approché
  await api('/douane/positions', {
    method: 'POST', body: { code: '1905321100', libelle: 'Gaufres et gaufrettes enrobées', taux_dd: 20, categorie: 'Cat. 3' }
  });
  const apres = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '1905321100' }
  });
  assert.equal(apres.position.niveau, 'exact');

  // Les niveaux de repli sont administrables (code court accepté)
  await api('/douane/positions', {
    method: 'POST', body: { code: '9702', libelle: 'Gravures et estampes originales', taux_dd: 5 }
  });

  // Les exonérations s'appliquent sur le code demandé, même en résolution approchée
  await api('/douane/exonerations', {
    method: 'POST', body: { position_prefixe: '84', origine: '', code_taxe: 'DD', taux_applique: 0, commentaire: 'test biens équipement' }
  });
  const exoneree = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '8477591234' }
  });
  assert.equal(exoneree.lignes.find(l => l.code === 'DD').montant, 0);
});

test('fiscalité Sénégal : accises par produit, TCI, exonérations TVA, règle la plus spécifique', { skip: !actif }, async () => {
  // Bière : accise 40 % et TVA assise sur la cascade incluant l'accise
  const biere = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '2203001000' }
  });
  const accBiere = biere.lignes.find(l => l.code === 'ACC');
  assert.equal(accBiere.taux, 40);
  assert.ok(accBiere.regle_appliquee, 'la règle appliquée doit être restituée');
  const tvaBiere = biere.lignes.find(l => l.code === 'TVA');
  assert.ok(tvaBiere.base > 1000000 + accBiere.montant - 1, 'la base TVA doit inclure l’accise');

  // PROMAD : 2 % de la valeur en douane (taux des déclarations réelles), dans la base TVA
  const promadBiere = biere.lignes.find(l => l.code === 'PROMAD');
  assert.equal(promadBiere.taux, 2);
  assert.equal(promadBiere.montant, 20000);
  assert.ok(tvaBiere.base >= 1000000 + accBiere.montant + promadBiere.montant - 1,
    'la base TVA doit inclure le PROMAD');

  // Boisson gazeuse : accise 5 % (règle 2202 plus spécifique que rien)
  const soda = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '2202990000' }
  });
  assert.equal(soda.lignes.find(l => l.code === 'ACC').taux, 5);

  // Cigarettes : accise 65 %
  const tabac = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '2402209000' }
  });
  assert.equal(tabac.lignes.find(l => l.code === 'ACC').taux, 65);

  // Sucre : TCI 10 %
  const sucre = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '1701999000' }
  });
  assert.equal(sucre.lignes.find(l => l.code === 'TCI').taux, 10);
  assert.equal(sucre.lignes.find(l => l.code === 'TCI').montant, 100000);

  // Riz : TVA exonérée (créance TVA nulle), droits de douane 10 % maintenus
  const riz = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '1006309000' }
  });
  assert.equal(riz.lignes.find(l => l.code === 'TVA').taux, 0);
  assert.equal(riz.lignes.find(l => l.code === 'DD').taux, 10);

  // Médicaments (préfixe chapitre 30) : TVA exonérée
  const medicament = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '3004909000' }
  });
  assert.equal(medicament.lignes.find(l => l.code === 'TVA').taux, 0);

  // Huile de palme brute (151110) : hors accise corps gras, contrairement à la margarine (1517)
  const huileBrute = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '1511101000' }
  });
  assert.equal(huileBrute.lignes.find(l => l.code === 'ACC').taux, 0);
  const margarine = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '1517100000' }
  });
  assert.equal(margarine.lignes.find(l => l.code === 'ACC').taux, 15);

  // Origine communautaire : droit de douane à 0 pour un produit ivoirien, mais l'accise demeure
  const cafeIvoirien = await api('/douane/simulation', {
    method: 'POST', body: { valeur_en_douane: 1000000, position_tarifaire: '0901210000', origine: 'CI' }
  });
  assert.equal(cafeIvoirien.lignes.find(l => l.code === 'DD').taux, 0);
  assert.equal(cafeIvoirien.lignes.find(l => l.code === 'ACC').taux, 5);
});

test('lot 4 : documentation API disponible sans jeton', { skip: !actif }, async () => {
  const rep = await fetch(`${B}/docs`);
  assert.equal(rep.ok, true);
  const spec = await rep.json();
  assert.ok(Object.keys(spec.chemins).length > 40);
});
