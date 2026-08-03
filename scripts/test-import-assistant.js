'use strict';
/* Test navigateur de l'assistant d'import avec le fichier réel de l'utilisateur (entêtes Carrefour). */
const { chromium } = require('playwright-core');

const FICHIER = [
  'Numéro de facture\tRayon\tArticle\tCode EAN\tDésignation Article\tCode pays\tPays Origine\tN° Commande\tQuantité facturée\tUnité\tPCB\tNbre Colis\tPoids net\tPoids brut\tUnité de poids\tVolume\tUnité vol.\tPrix de vente\tFrais log.\tTotal hors frais log.\tTotal avec frais log.\tNomenclature Douanière',
  '90027095\t20\t1580\t3,24541E+12\tKG Jambon de Bayonne Fermier Label Rouge IGP REFLETS DE FRANCE\tFR\tUnion Européenne - France\tEDK FRAIS MARITIME 002\t3\tKG\t1\t3\t22,155\t24,371\tKG\t0,032\tM3\t18,304\t4,06\t405,53\t409,59\t210198190',
  '90027095\t20\t2845\t3245390001238\t800G Fromage à Raclette REFLETS DE FRANCE\tFR\tUnion Européenne - France\tEDK FRAIS MARITIME 002\t12\t/PC\t6\t2\t9,6\t10\tKG\t0,037\tM3\t12,255\t1,47\t147,06\t148,53\t406908690',
  '90027095\t22\t3362\t4,00826E+12\t200G Noix De Cajou Nature Sans Sel Ajouté Vegan SEEBERGER\tIN\tInde\tEDK FRAIS MARITIME 002\t216\t/PC\t12\t18\t43,2\t44,28\tKG\t0,19\tM3\t3,799\t8,21\t820,58\t828,79\t8013200'
].join('\n');

(async () => {
  const navigateur = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await navigateur.newPage();
  page.on('pageerror', e => console.log('  pageerror:', e.message));
  const B = process.env.BASE || 'http://localhost:3400';
  let ok = 0, ko = 0;
  const verif = (nom, cond) => { if (cond) { ok++; console.log('  OK ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom); } };

  await page.goto(B);
  await page.fill('#c-email', 'admin@demo.sn');
  await page.fill('#c-mdp', 'admin123');
  await page.click('#btn-connexion');
  await page.waitForSelector('nav.lateral', { timeout: 8000 });

  await page.click('a.item:has-text("Référentiel")');
  await page.waitForSelector('#a-import', { timeout: 8000 });
  await page.click('#a-import');
  await page.waitForSelector('#ai-texte', { timeout: 8000 });
  await page.fill('#ai-texte', FICHIER);
  await page.click('#ai-analyser');
  await page.waitForSelector('#ai-map-code_interne', { timeout: 8000 });

  // Le mappage automatique doit avoir reconnu les colonnes Carrefour
  verif('Article -> code_interne', await page.locator('#ai-map-code_interne option:checked').textContent() === 'Article');
  verif('Code EAN -> code_barres', await page.locator('#ai-map-code_barres option:checked').textContent() === 'Code EAN');
  verif('Désignation -> libellé', (await page.locator('#ai-map-libelle option:checked').textContent()).includes('Désignation'));
  verif('Rayon -> famille', await page.locator('#ai-map-famille option:checked').textContent() === 'Rayon');
  verif('PCB -> unités par carton', await page.locator('#ai-map-unites_par_carton option:checked').textContent() === 'PCB');
  verif('Nomenclature Douanière -> position', (await page.locator('#ai-map-position_tarifaire option:checked').textContent()).includes('Nomenclature'));
  verif('Code pays -> origine', (await page.locator('#ai-map-origine option:checked').textContent()).includes('pays'));
  verif('alerte EAN corrompus affichée', (await page.locator('#ai-apercu').innerText()).includes('Excel'));

  await page.click('#ai-importer');
  await page.waitForSelector('#ai-rapport .message.ok', { timeout: 10000 });
  const rapport = await page.locator('#ai-rapport').innerText();
  console.log('  rapport:', rapport.split('\n')[0]);
  verif('3 articles importés sans rejet', /3 article\(s\) créé\(s\)/.test(rapport) && /0 rejet/.test(rapport));

  // Vérifier l'article 2845 : EAN valide conservé, position complétée à 10 chiffres, poids par carton dérivé
  await page.goto(B + '/#/article/2845');
  await page.waitForSelector('#fa-code', { timeout: 8000 });
  verif('fiche 2845 : EAN conservé', await page.inputValue('#fa-cb') === '3245390001238');
  verif('fiche 2845 : position complétée à 10 chiffres', await page.inputValue('#fa-position') === '4069086900');
  verif('fiche 2845 : colisage PCB = 6', await page.inputValue('#fa-upc') === '6');
  verif('fiche 2845 : poids brut carton dérivé = 5 kg (10 kg / 2 colis)', await page.inputValue('#fa-pbc') === '5');
  verif('fiche 2845 : origine FR', await page.inputValue('#fa-origine') === 'FR');

  // L'article 1580 (EAN corrompu) doit exister sans code barres
  await page.goto(B + '/#/article/1580');
  await page.waitForSelector('#fa-code', { timeout: 8000 });
  verif('fiche 1580 : importée avec EAN corrompu vidé', await page.inputValue('#fa-cb') === '');

  // Mémorisation : réouvrir l'import et vérifier le message "correspondance retrouvée"
  await page.goto(B + '/#/articles');
  await page.waitForSelector('#a-import', { timeout: 8000 });
  await page.click('#a-import');
  await page.fill('#ai-texte', FICHIER);
  await page.click('#ai-analyser');
  await page.waitForSelector('#ai-mapping .message', { timeout: 8000 });
  verif('correspondance mémorisée (F-M10-04)', (await page.locator('#ai-mapping .message').first().innerText()).includes('retrouvée'));

  await navigateur.close();
  console.log(`\nRésultat : ${ok} OK, ${ko} ÉCHEC`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('ERREUR FATALE:', e.message); process.exit(1); });
