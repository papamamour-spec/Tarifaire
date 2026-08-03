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

test('lot 4 : documentation API disponible sans jeton', { skip: !actif }, async () => {
  const rep = await fetch(`${B}/docs`);
  assert.equal(rep.ok, true);
  const spec = await rep.json();
  assert.ok(Object.keys(spec.chemins).length > 40);
});
