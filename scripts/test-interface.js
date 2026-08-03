'use strict';
/*
 * Test d'interface en vrai navigateur : connexion, ouverture de la fiche article par clic,
 * fiche fournisseur, onglets, absence de tirets cadratins, déconnexion, absence d'erreur CSP.
 * Prérequis : serveur lancé (PORT 3400 par défaut, variable BASE), playwright-core installé
 * et un Chromium local (variable CHROMIUM, ex. /opt/pw-browsers/chromium-1194/chrome-linux/chrome).
 * Usage : CHROMIUM=/chemin/chrome node scripts/test-interface.js
 */
const { chromium } = require('playwright-core');

(async () => {
  const executablePath = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const navigateur = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const page = await navigateur.newPage();
  const erreursConsole = [];
  page.on('console', m => { if (m.type() === 'error') erreursConsole.push(m.text()); });
  page.on('pageerror', e => erreursConsole.push('pageerror: ' + e.message));

  const B = process.env.BASE || 'http://localhost:3400';
  let ok = 0, ko = 0;
  const verif = (nom, cond) => { if (cond) { ok++; console.log('  OK ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom); } };

  // 1. Connexion
  await page.goto(B);
  await page.fill('#c-email', 'admin@demo.sn');
  await page.fill('#c-mdp', 'admin123');
  await page.click('#btn-connexion');
  await page.waitForSelector('nav.lateral', { timeout: 8000 });
  verif('connexion réussie', await page.locator('h1').first().textContent() !== null);
  // Le compte de démonstration est redirigé vers Mon compte (mot de passe à changer) : on va au tableau de bord
  await page.click('a.item:has-text("Tableau de bord")');
  await page.waitForSelector('details.guide', { timeout: 8000 });
  verif('guide de démarrage visible sur le tableau de bord', await page.locator('details.guide').count() === 1);

  // 2. Navigation vers le référentiel et ouverture d'une fiche article par clic sur la ligne
  await page.click('a.item:has-text("Référentiel")');
  await page.waitForSelector('#a-liste table', { timeout: 8000 });
  const lignesArticles = await page.locator('#a-liste a[href^="#/article/"]').count();
  verif('liste des articles affichée (' + lignesArticles + ' liens)', lignesArticles > 0);
  await page.locator('#a-liste a[href^="#/article/"]').first().click();
  await page.waitForSelector('#fa-code', { timeout: 8000 });
  const codeArticle = await page.inputValue('#fa-code');
  verif('FICHE ARTICLE ouverte par le lien de la ligne (' + codeArticle + ')', codeArticle.length > 0);
  verif('bloc fournisseurs de l\'article présent', await page.locator('#fa-zone-fournisseurs').count() === 1);

  // 3. Onglet fournisseurs : bouton Modifier (fiche fournisseur)
  await page.click('a.item:has-text("Référentiel")');
  await page.waitForSelector('.onglets', { timeout: 8000 });
  await page.click('.onglets button[data-o="fournisseurs"]');
  await page.waitForSelector('#fo-code', { timeout: 8000 });
  const nbFournisseurs = await page.locator('button:has-text("Modifier")').count();
  if (nbFournisseurs > 0) {
    await page.locator('button:has-text("Modifier")').first().click();
    await page.waitForTimeout(400);
    verif('FICHE FOURNISSEUR pré-remplie par le bouton Modifier', (await page.inputValue('#fo-code')).length > 0);
  } else {
    // Créer un fournisseur puis vérifier le bouton
    await page.fill('#fo-code', 'UITEST');
    await page.fill('#fo-nom', 'Fournisseur test interface');
    await page.click('#fo-enregistrer');
    await page.waitForSelector('button:has-text("Modifier")', { timeout: 8000 });
    await page.locator('button:has-text("Modifier")').first().click();
    await page.waitForTimeout(400);
    verif('FICHE FOURNISSEUR créée puis pré-remplie par Modifier', (await page.inputValue('#fo-code')).length > 0);
  }

  // 4. Dossiers : clic sur une ligne
  await page.click('a.item:has-text("Dossiers")');
  await page.waitForSelector('table', { timeout: 8000 });
  const lignesDossiers = await page.locator('tr.cliquable').count();
  if (lignesDossiers > 0) {
    await page.locator('tr.cliquable').first().click();
    await page.waitForSelector('.onglets', { timeout: 8000 });
    verif('détail de dossier ouvert par clic', (await page.locator('h1').first().textContent()).includes('Dossier'));
  }

  // 5. Onglets tarification (boutons inline dedans)
  await page.click('a.item:has-text("Tarification")');
  await page.waitForSelector('.onglets', { timeout: 8000 });
  await page.click('.onglets button[data-o="tarifs"]');
  await page.waitForTimeout(700);
  verif('onglet tarifs et règle de validation affichés', await page.locator('#rg-marque').count() === 1);

  // 6. Aucun tiret cadratin visible
  const corps = await page.locator('body').innerText();
  verif('aucun tiret cadratin dans la page', !corps.includes('—'));

  // 7. Déconnexion
  await page.click('#btn-deconnexion');
  await page.waitForSelector('#c-email', { timeout: 8000 });
  verif('BOUTON SE DÉCONNECTER fonctionne (retour à la connexion)', await page.locator('#c-email').count() === 1);

  // 8. Erreurs console (CSP, JS)
  const erreursCsp = erreursConsole.filter(e => /Content Security Policy|Refused to execute/i.test(e));
  verif('aucune erreur CSP dans la console', erreursCsp.length === 0);
  if (erreursConsole.length) console.log('  console:', erreursConsole.slice(0, 5));

  await navigateur.close();
  console.log(`\nRésultat : ${ok} OK, ${ko} ÉCHEC`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('ERREUR FATALE:', e.message); process.exit(1); });
