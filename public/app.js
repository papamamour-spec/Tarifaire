'use strict';
/* Tarifaire · application web (page unique, sans dépendance externe). */

/* ---------------------------------- Socle ---------------------------------- */
const etat = {
  token: localStorage.getItem('tarifaire_token') || null,
  utilisateur: JSON.parse(localStorage.getItem('tarifaire_utilisateur') || 'null')
};

async function api(chemin, options = {}) {
  const opts = { headers: { 'Content-Type': 'application/json' }, ...options };
  if (etat.token) opts.headers.Authorization = 'Bearer ' + etat.token;
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const rep = await fetch('/api' + chemin, opts);
  if (rep.status === 401) { deconnexion(); throw new Error('Session expirée'); }
  const data = await rep.json().catch(() => ({}));
  if (!rep.ok) { const e = new Error(data.erreur || 'Erreur ' + rep.status); e.data = data; e.statut = rep.status; throw e; }
  return data;
}

async function telecharger(chemin, nomFichier) {
  const rep = await fetch('/api' + chemin, { headers: { Authorization: 'Bearer ' + etat.token } });
  if (!rep.ok) { alert('Téléchargement impossible'); return; }
  const blob = await rep.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nomFichier; a.click();
  URL.revokeObjectURL(url);
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n, dec = 0) {
  if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '-';
  return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fcfa(n) { return n === null || n === undefined ? '-' : fmt(n) + ' F'; }
function dateFr(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : '-'; }
function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function coche(id) { const e = document.getElementById(id); return e ? e.checked : false; }

function message(conteneurId, type, texte) {
  const c = document.getElementById(conteneurId);
  if (c) c.innerHTML = `<div class="message ${type}">${esc(texte)}</div>`;
}

function deconnexion() {
  etat.token = null; etat.utilisateur = null;
  localStorage.removeItem('tarifaire_token');
  localStorage.removeItem('tarifaire_utilisateur');
  rendre();
}

/* ------------------- Assistant d'import avec correspondance des colonnes (F-M10-04) ------------------- */

// Analyse un collage tableur : détecte le séparateur (tabulation prioritaire : collage Excel), gère les guillemets.
function analyserTableur(texte) {
  const premiere = texte.slice(0, texte.indexOf('\n') === -1 ? texte.length : texte.indexOf('\n'));
  let sep = '\t';
  if (!premiere.includes('\t')) sep = (premiere.split(';').length >= premiere.split(',').length) ? ';' : ',';
  const lignes = [];
  let ligne = [], champ = '', guillemets = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (guillemets) {
      if (c === '"') { if (texte[i + 1] === '"') { champ += '"'; i++; } else guillemets = false; }
      else champ += c;
    } else if (c === '"') guillemets = true;
    else if (c === sep) { ligne.push(champ); champ = ''; }
    else if (c === '\n') { ligne.push(champ); champ = ''; if (ligne.some(v => v.trim() !== '')) lignes.push(ligne); ligne = []; }
    else if (c !== '\r') champ += c;
  }
  ligne.push(champ);
  if (ligne.some(v => v.trim() !== '')) lignes.push(ligne);
  if (!lignes.length) return { entetes: [], lignes: [] };
  return { entetes: lignes[0].map(h => h.trim()), lignes: lignes.slice(1) };
}

function normaliserEntete(h) {
  return String(h).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Nettoyages de valeurs propres aux fichiers réels
function nettoyerEan(v) {
  const s = String(v || '').trim();
  if (/^\d+[,.]\d+e\+?\d+$/i.test(s)) return { valeur: '', corrompu: true }; // notation scientifique Excel : chiffres perdus
  const chiffres = s.replace(/\D/g, '');
  return { valeur: chiffres, corrompu: false };
}
function nettoyerPosition(v) {
  const chiffres = String(v || '').replace(/\D/g, '');
  if (!chiffres) return '';
  if (chiffres.length >= 10) return chiffres.slice(0, 10);
  if (chiffres.length >= 6) return chiffres.padEnd(10, '0'); // nomenclature à 6-9 chiffres complétée à droite
  return '';
}
function nombreFr(v) {
  if (v === null || v === undefined || String(v).trim() === '') return '';
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : '';
}

/*
 * Champs cibles par type d'import. `syn` : noms de colonnes reconnus automatiquement
 * (normalisés). `aux` : champ intermédiaire servant aux dérivations, non exporté tel quel.
 */
const CIBLES_IMPORT = {
  articles: [
    { cle: 'code_interne', libelle: 'Code interne *', oblig: true, syn: ['code interne', 'article', 'code article', 'reference', 'ref', 'code', 'no article', 'numero article'] },
    { cle: 'code_barres', libelle: 'Code barres EAN', syn: ['code barres', 'code ean', 'ean', 'ean13', 'gencod', 'code barre', 'codes barres'] },
    { cle: 'libelle', libelle: 'Libellé *', oblig: true, syn: ['libelle', 'designation', 'designation article', 'nom', 'description', 'libelle article'] },
    { cle: 'famille', libelle: 'Famille', syn: ['famille', 'rayon', 'departement', 'categorie'] },
    { cle: 'fournisseur', libelle: 'Fournisseur', syn: ['fournisseur', 'code fournisseur'] },
    { cle: 'reference_fournisseur', libelle: 'Réf. fournisseur', syn: ['reference fournisseur', 'ref fournisseur'] },
    { cle: 'unites_par_carton', libelle: 'Unités par carton', syn: ['unites par carton', 'pcb', 'colisage', 'uc'] },
    { cle: 'nb_colis', libelle: 'Nombre de colis (dérivation)', aux: true, syn: ['nbre colis', 'nb colis', 'nombre de colis', 'colis'] },
    { cle: 'quantite_aux', libelle: 'Quantité (dérivation)', aux: true, syn: ['quantite facturee', 'quantite', 'qte facturee', 'qte'] },
    { cle: 'poids_net_total', libelle: 'Poids net de la ligne (dérivation)', aux: true, syn: ['poids net'] },
    { cle: 'poids_brut_total', libelle: 'Poids brut de la ligne (dérivation)', aux: true, syn: ['poids brut'] },
    { cle: 'volume_total', libelle: 'Volume de la ligne (dérivation)', aux: true, syn: ['volume', 'volume m3', 'vol'] },
    { cle: 'poids_brut_carton', libelle: 'Poids brut par carton (kg)', syn: ['poids brut carton', 'poids carton'] },
    { cle: 'volume_carton', libelle: 'Volume par carton (m³)', syn: ['volume carton'] },
    { cle: 'position_tarifaire', libelle: 'Position tarifaire / nomenclature', syn: ['position tarifaire', 'nomenclature douaniere', 'nomenclature', 'code sh', 'hs code', 'position', 'code douanier'] },
    { cle: 'origine', libelle: 'Origine (code pays)', syn: ['origine', 'code pays', 'pays origine', 'pays'] },
    { cle: 'taux_tva_vente', libelle: 'TVA vente (%)', syn: ['taux tva vente', 'taux tva', 'tva'] },
    { cle: 'statut', libelle: 'Statut', syn: ['statut'] }
  ],
  facture: [
    { cle: 'code_barres', libelle: 'Code barres EAN', syn: ['code barres', 'code ean', 'ean', 'ean13', 'gencod', 'code barre'] },
    { cle: 'code_interne', libelle: 'Code interne', syn: ['code interne', 'article', 'code article', 'reference', 'ref', 'code', 'no article'] },
    { cle: 'libelle', libelle: 'Libellé', syn: ['libelle', 'designation', 'designation article', 'nom', 'description'] },
    { cle: 'quantite', libelle: 'Quantité *', oblig: true, syn: ['quantite', 'quantite facturee', 'qte', 'qte facturee'] },
    { cle: 'prix_unitaire', libelle: 'Prix unitaire *', oblig: true, syn: ['prix unitaire', 'prix de vente', 'prix achat', 'pu', 'prix', 'prix unitaire ht'] },
    { cle: 'nb_cartons', libelle: 'Nombre de colis', syn: ['nbre colis', 'nb colis', 'nombre de colis', 'colis'] },
    { cle: 'poids_brut', libelle: 'Poids brut de la ligne (kg)', syn: ['poids brut', 'poids'] },
    { cle: 'volume', libelle: 'Volume de la ligne (m³)', syn: ['volume', 'volume m3', 'vol'] },
    { cle: 'declaration_rang', libelle: 'N° article de déclaration', syn: ['declaration rang', 'rang declaration', 'decl'] }
  ]
};

function autoMapper(entetes, cibles, type) {
  // Correspondance mémorisée pour cette signature de fichier (F-M10-04)
  const signature = entetes.map(normaliserEntete).join('|');
  const memoire = JSON.parse(localStorage.getItem('tarifaire_mappings') || '{}');
  if (memoire[type + '|' + signature]) return { mapping: memoire[type + '|' + signature], memorise: true };
  const normalises = entetes.map(normaliserEntete);
  const mapping = {};
  for (const cible of cibles) {
    let indice = -1;
    for (const s of cible.syn) {
      indice = normalises.indexOf(s);
      if (indice !== -1) break;
    }
    if (indice === -1) indice = normalises.findIndex(n => cible.syn.some(s => n.includes(s) && s.length > 3));
    if (indice !== -1 && !Object.values(mapping).includes(indice)) mapping[cible.cle] = indice;
  }
  return { mapping, memorise: false };
}

function memoriserMapping(entetes, type, mapping) {
  const signature = entetes.map(normaliserEntete).join('|');
  const memoire = JSON.parse(localStorage.getItem('tarifaire_mappings') || '{}');
  memoire[type + '|' + signature] = mapping;
  localStorage.setItem('tarifaire_mappings', JSON.stringify(memoire));
}

/*
 * Transforme les lignes source en enregistrements canoniques.
 * Dérivations : poids/volume par carton depuis les totaux de ligne et le nombre de colis,
 * unités par carton depuis quantité et colis, EAN corrompus signalés, positions complétées à 10 chiffres.
 */
function transformerLignes(type, lignes, mapping) {
  const avertissements = { ean_corrompus: 0, positions_completees: 0 };
  const enregistrements = lignes.map(l => {
    const v = cle => (mapping[cle] !== undefined && mapping[cle] !== null && mapping[cle] !== '' ? String(l[mapping[cle]] ?? '').trim() : '');
    const e = {};
    if (type === 'articles') {
      e.code_interne = v('code_interne');
      const ean = nettoyerEan(v('code_barres'));
      if (ean.corrompu) avertissements.ean_corrompus++;
      e.code_barres = ean.valeur;
      e.libelle = v('libelle');
      e.famille = v('famille');
      e.fournisseur = v('fournisseur');
      e.reference_fournisseur = v('reference_fournisseur');
      const nbColis = nombreFr(v('nb_colis'));
      const quantite = nombreFr(v('quantite_aux'));
      e.unites_par_carton = nombreFr(v('unites_par_carton')) ||
        (nbColis && quantite ? Math.round(quantite / nbColis) : '');
      e.poids_brut_carton = nombreFr(v('poids_brut_carton')) ||
        (nbColis && nombreFr(v('poids_brut_total')) ? Math.round(nombreFr(v('poids_brut_total')) / nbColis * 1000) / 1000 : '');
      e.poids_net_unitaire = (quantite && nombreFr(v('poids_net_total')))
        ? Math.round(nombreFr(v('poids_net_total')) / quantite * 1000) / 1000 : '';
      e.volume_carton = nombreFr(v('volume_carton')) ||
        (nbColis && nombreFr(v('volume_total')) ? Math.round(nombreFr(v('volume_total')) / nbColis * 100000) / 100000 : '');
      const brut = String(v('position_tarifaire')).replace(/\D/g, '');
      e.position_tarifaire = nettoyerPosition(v('position_tarifaire'));
      if (e.position_tarifaire && brut.length < 10) avertissements.positions_completees++;
      const origine = v('origine').toUpperCase();
      e.origine = /^[A-Z]{2}$/.test(origine) ? origine : '';
      e.taux_tva_vente = nombreFr(v('taux_tva_vente'));
      e.statut = v('statut') || 'actif';
      e.longueur_carton = ''; e.largeur_carton = ''; e.hauteur_carton = '';
    } else {
      const ean = nettoyerEan(v('code_barres'));
      if (ean.corrompu) avertissements.ean_corrompus++;
      e.code_barres = ean.valeur;
      e.code_interne = v('code_interne');
      e.libelle = v('libelle');
      e.quantite = nombreFr(v('quantite'));
      e.prix_unitaire = nombreFr(v('prix_unitaire'));
      e.nb_cartons = nombreFr(v('nb_cartons'));
      e.poids_brut = nombreFr(v('poids_brut'));
      e.volume = nombreFr(v('volume'));
      e.declaration_rang = nombreFr(v('declaration_rang'));
    }
    return e;
  });
  return { enregistrements, avertissements };
}

function enregistrementsVersCsv(enregistrements, colonnes) {
  const echapper = x => /[";\n]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : String(x);
  return [colonnes.join(';')]
    .concat(enregistrements.map(e => colonnes.map(c => echapper(e[c] ?? '')).join(';')))
    .join('\n');
}

/*
 * Monte l'assistant dans `conteneur`. `type` : articles | facture.
 * `envoyer(csvCanonique)` est appelé à la validation et doit retourner le rapport d'import.
 */
function monterAssistantImport({ conteneur, type, envoyer, note }) {
  const cibles = CIBLES_IMPORT[type];
  conteneur.innerHTML = `
    <p class="petite-note">${note || ''} Collez votre fichier tel quel (export Excel, CSV, tableur) : l'assistant reconnaît les colonnes, même avec d'autres noms (Rayon, PCB, Code EAN, Nomenclature Douanière…), et mémorise votre correspondance pour la prochaine fois.</p>
    <textarea id="ai-texte" placeholder="Collez ici le contenu du fichier, entêtes comprises…"></textarea>
    <div class="actions-page"><button id="ai-analyser">Analyser le fichier</button></div>
    <div id="ai-mapping"></div>
    <div id="ai-rapport"></div>`;
  const zoneMapping = conteneur.querySelector('#ai-mapping');
  const zoneRapport = conteneur.querySelector('#ai-rapport');

  conteneur.querySelector('#ai-analyser').onclick = () => {
    const { entetes, lignes } = analyserTableur(conteneur.querySelector('#ai-texte').value);
    if (!entetes.length || !lignes.length) {
      zoneRapport.innerHTML = '<div class="message erreur">Aucune donnée détectée : collez le fichier avec sa ligne d\'entêtes.</div>';
      return;
    }
    const { mapping, memorise } = autoMapper(entetes, cibles, type);
    const rendreApercu = () => {
      const mappingActuel = {};
      cibles.forEach(c => {
        const sel = zoneMapping.querySelector(`#ai-map-${c.cle}`);
        if (sel && sel.value !== '') mappingActuel[c.cle] = Number(sel.value);
      });
      const { enregistrements, avertissements } = transformerLignes(type, lignes.slice(0, 3), mappingActuel);
      const colonnesApercu = cibles.filter(c => !c.aux).map(c => c.cle);
      zoneMapping.querySelector('#ai-apercu').innerHTML = `
        <h3>Aperçu des 3 premières lignes transformées</h3>
        <div class="table-defilante"><table>
          <tr>${colonnesApercu.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
          ${enregistrements.map(e => `<tr>${colonnesApercu.map(c => `<td>${esc(e[c] ?? '')}</td>`).join('')}</tr>`).join('')}
        </table></div>
        ${avertissements.ean_corrompus ? `<div class="message erreur">Codes EAN en notation scientifique (« 3,24541E+12 ») : Excel a détruit ces codes, ils seront importés vides. Pour les conserver, formatez la colonne EAN en « Texte » dans Excel avant de copier.</div>` : ''}`;
      return mappingActuel;
    };
    zoneMapping.innerHTML = `
      ${memorise ? '<div class="message ok">Correspondance retrouvée : ce format de fichier a déjà été importé.</div>'
        : '<div class="message info">Colonnes reconnues automatiquement. Vérifiez puis ajustez si besoin ; votre choix sera mémorisé.</div>'}
      <div class="ligne-champs">
        ${cibles.map(c => `<label class="champ">${esc(c.libelle)}<select id="ai-map-${c.cle}">
          <option value="">(ignorer)</option>
          ${entetes.map((h, i) => `<option value="${i}" ${mapping[c.cle] === i ? 'selected' : ''}>${esc(h)}</option>`).join('')}
        </select></label>`).join('')}
      </div>
      <div id="ai-apercu"></div>
      <div class="actions-page"><button id="ai-importer">Importer ${lignes.length} ligne(s)</button></div>`;
    zoneMapping.querySelectorAll('select').forEach(s => s.onchange = rendreApercu);
    rendreApercu();
    zoneMapping.querySelector('#ai-importer').onclick = async () => {
      const mappingActuel = rendreApercu();
      const manquantes = cibles.filter(c => c.oblig && mappingActuel[c.cle] === undefined);
      if (manquantes.length) {
        zoneRapport.innerHTML = `<div class="message erreur">Colonnes obligatoires non associées : ${manquantes.map(c => esc(c.libelle)).join(', ')}.</div>`;
        return;
      }
      memoriserMapping(entetes, type, mappingActuel);
      const { enregistrements, avertissements } = transformerLignes(type, lignes, mappingActuel);
      const colonnes = cibles.filter(c => !c.aux).map(c => c.cle);
      try {
        zoneRapport.innerHTML = '<div class="message info">Import en cours…</div>';
        const rapport = await envoyer(enregistrementsVersCsv(enregistrements, colonnes));
        zoneRapport.innerHTML = `<div class="message ok">${esc(rapport)}</div>
          ${avertissements.ean_corrompus ? `<div class="message erreur">${avertissements.ean_corrompus} code(s) EAN corrompu(s) par Excel importé(s) sans code barres : complétez-les depuis les fiches articles.</div>` : ''}
          ${avertissements.positions_completees ? `<div class="message info">${avertissements.positions_completees} nomenclature(s) douanière(s) complétée(s) à 10 chiffres (zéros à droite) : vérifiez-les dans Douane & fiscalité.</div>` : ''}`;
      } catch (e) { zoneRapport.innerHTML = `<div class="message erreur">${esc(e.message)}</div>`; }
    };
  };
}

/* ---------------------------------- Routeur ---------------------------------- */
const routes = {
  '': vueTableau, 'tableau': vueTableau, 'articles': vueArticles, 'article': vueFicheArticle,
  'douane': vueDouane, 'dossiers': vueDossiers, 'dossier': vueDossierDetail,
  'tarification': vueTarification, 'veille': vueVeille, 'marges': vueMarges,
  'admin': vueAdmin, 'compte': vueCompte
};

window.addEventListener('hashchange', rendre);

function naviguer(hash) { location.hash = hash; }

function rendre() {
  const app = document.getElementById('app');
  if (!etat.token) { vueConnexion(app); return; }
  const [route, ...args] = location.hash.replace(/^#\/?/, '').split('/');
  const vue = routes[route] || vueTableau;
  const menu = [
    ['tableau', '📊 Tableau de bord'],
    ['articles', '📦 Référentiel'],
    ['douane', '🛃 Douane & fiscalité'],
    ['dossiers', "🚢 Dossiers d'importation"],
    ['tarification', '💰 Tarification'],
    ['veille', '🔎 Veille concurrentielle'],
    ['marges', '📈 Marge réalisée'],
    ['admin', '⚙️ Administration'],
    ['compte', '👤 Mon compte']
  ];
  app.innerHTML = `
    <nav class="lateral">
      <div class="logo">TARIFAIRE<small>Prix de revient &amp; politique tarifaire · UEMOA</small></div>
      ${menu.map(([r, l]) => `<a class="item ${route === r || (route === '' && r === 'tableau') || (route === 'article' && r === 'articles') || (route === 'dossier' && r === 'dossiers') ? 'actif' : ''}" href="#/${r}">${l}${r === 'compte' ? ' <span id="badge-notifs"></span>' : ''}</a>`).join('')}
      <div class="pied">
        <div>${esc(etat.utilisateur?.nom || '')}<br><span class="badge gris">${esc(etat.utilisateur?.role || '')}</span></div>
        <button class="secondaire petit" id="btn-deconnexion">Se déconnecter</button>
      </div>
    </nav>
    <main class="contenu" id="page">Chargement…</main>`;
  document.getElementById('btn-deconnexion').addEventListener('click', deconnexion);
  vue(document.getElementById('page'), args).catch(e => {
    document.getElementById('page').innerHTML = `<div class="message erreur">${esc(e.message)}</div>`;
  });
  majBadgeNotifications();
}

async function majBadgeNotifications() {
  try {
    const notifs = await api('/compte/notifications');
    const nonLues = notifs.filter(n => !n.lue).length;
    const badge = document.getElementById('badge-notifs');
    if (badge) badge.innerHTML = nonLues ? `<span class="badge rouge">${nonLues}</span>` : '';
  } catch { /* silencieux */ }
}

/* ---------------------------------- Connexion ---------------------------------- */
function vueConnexion(app) {
  app.innerHTML = `
    <div class="plein-ecran">
      <div class="boite-connexion">
        <h1>Tarifaire</h1>
        <p class="sous-titre">Du coût de revient débarqué au prix en rayon</p>
        <div id="msg-connexion"></div>
        <label class="champ">Courriel<input id="c-email" type="email" autocomplete="username" value=""></label>
        <label class="champ">Mot de passe<input id="c-mdp" type="password" autocomplete="current-password"></label>
        <label class="champ" id="c-2fa-champ" style="display:none">Code de double authentification<input id="c-2fa" inputmode="numeric" maxlength="6" placeholder="6 chiffres"></label>
        <button id="btn-connexion">Se connecter</button>
        <p class="petite-note">Compte de démonstration initial : admin@demo.sn / admin123</p>
      </div>
    </div>`;
  const soumettre = async () => {
    try {
      const r = await api('/connexion', {
        method: 'POST',
        body: { email: val('c-email'), mot_de_passe: val('c-mdp'), code_2fa: val('c-2fa') || undefined }
      });
      etat.token = r.token; etat.utilisateur = r.utilisateur;
      localStorage.setItem('tarifaire_token', r.token);
      localStorage.setItem('tarifaire_utilisateur', JSON.stringify(r.utilisateur));
      rendre();
      if (r.utilisateur.doit_changer_mdp) {
        naviguer('#/compte');
      }
    } catch (e) {
      if (e.data && e.data.exige_2fa) {
        document.getElementById('c-2fa-champ').style.display = '';
        document.getElementById('c-2fa').focus();
        message('msg-connexion', 'info', 'Saisissez le code de votre application d’authentification.');
      } else message('msg-connexion', 'erreur', e.message);
    }
  };
  document.getElementById('btn-connexion').onclick = soumettre;
  app.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') soumettre(); }));
}

/* ---------------------------------- Tableau de bord ---------------------------------- */
async function vueTableau(page) {
  const [tb, analyse, fournisseurs] = await Promise.all([
    api('/pilotage/tableau-de-bord'), api('/pilotage/analyse-dossiers'), api('/referentiels/fournisseurs')]);
  const statuts = Object.fromEntries(tb.dossiers_par_statut.map(x => [x.statut, x.n]));
  const tarifs = Object.fromEntries(tb.tarifs_par_statut.map(x => [x.statut, x.n]));

  // Guide de démarrage : accompagne les nouveaux utilisateurs jusqu'au premier prix publié
  const etapes = [
    { fait: fournisseurs.length > 0, titre: 'Créer vos fournisseurs', detail: 'Référentiel > Fournisseurs, ou en un clic depuis une fiche article', lien: '#/articles' },
    { fait: tb.articles.total > 0, titre: 'Créer ou importer vos articles', detail: 'Référentiel > bouton Importer (CSV) ou + Nouvel article', lien: '#/articles' },
    { fait: (statuts.ouvert || 0) + (statuts.cloture || 0) + (statuts.receptionne || 0) + (statuts.declare || 0) + (statuts.embarque || 0) + (statuts.revise || 0) + (statuts.titres_obtenus || 0) > 0, titre: 'Ouvrir votre premier dossier d\'importation', detail: 'Facture fournisseur, coûts, déclaration en douane', lien: '#/dossiers' },
    { fait: tb.coefficient_moyen !== null, titre: 'Calculer le coût de revient débarqué', detail: 'Dans le dossier, onglet Coût de revient > Calculer', lien: '#/dossiers' },
    { fait: (tarifs.publie || 0) > 0, titre: 'Proposer et publier vos prix', detail: 'Tarification > Proposer des prix, puis publier', lien: '#/tarification' },
    { fait: tb.releves_30j.mois > 0, titre: 'Lancer la veille concurrentielle', detail: 'Saisir ou importer des relevés de prix', lien: '#/veille' }
  ];
  const faites = etapes.filter(e => e.fait).length;
  const guideOuvert = faites < etapes.length;

  page.innerHTML = `
    <h1>Tableau de bord</h1>
    <p class="sous-titre">Vue d'ensemble du référentiel, des coûts et de la politique tarifaire</p>
    <details class="carte guide" ${guideOuvert ? 'open' : ''}>
      <summary><b>🚀 Bien démarrer</b> · ${faites}/${etapes.length} étape(s) franchie(s)${faites === etapes.length ? ' · bravo, la chaîne complète est en place !' : ''}</summary>
      <ol class="guide-liste">
        ${etapes.map(e => `<li class="${e.fait ? 'fait' : ''}">
          <span class="coche">${e.fait ? '✅' : '⬜'}</span>
          <a href="${e.lien}"><b>${e.titre}</b></a>
          <span class="petite-note">${e.detail}</span>
        </li>`).join('')}
      </ol>
      <p class="petite-note">La chaîne de valeur : référentiel → dossier d'importation → coût de revient débarqué → coût de mise en rayon → prix par format → veille. Chaque donnée saisie une fois est réutilisée partout.</p>
    </details>
    <div class="grille kpi">
      <div class="carte"><div class="valeur">${fmt(tb.articles.actifs)}</div><div class="libelle">Articles actifs (${fmt(tb.articles.total)} au total)</div></div>
      <div class="carte"><div class="valeur">${fmt(tb.completude.taux, 1)} %</div><div class="libelle">Complétude du référentiel (poids, volume, colisage, position)</div></div>
      <div class="carte"><div class="valeur">${fcfa(tb.creance_tva)}</div><div class="libelle">Créances sur l'État (TVA import + acomptes liquidés)</div></div>
      <div class="carte"><div class="valeur ${tb.references_marge_negative > 0 ? 'alerte-rouge' : ''}">${fmt(tb.references_marge_negative)}</div><div class="libelle">Tarifs en marge négative</div></div>
      <div class="carte"><div class="valeur">${tb.coefficient_moyen ? fmt(tb.coefficient_moyen, 3) : '-'}</div><div class="libelle">Coefficient de revient moyen</div></div>
      <div class="carte"><div class="valeur">${tb.taux_effectif_bornes && tb.taux_effectif_bornes.mini !== null ? fmt(tb.taux_effectif_bornes.mini, 1) + ' → ' + fmt(tb.taux_effectif_bornes.maxi, 1) + ' %' : '-'}</div><div class="libelle">Taux effectif de droits et taxes (mini → maxi)</div></div>
      <div class="carte"><div class="valeur">${fmt(tb.releves_30j.mois)}</div><div class="libelle">Relevés concurrents sur 30 jours (${fmt(tb.releves_30j.non_apparies)} à apparier)</div></div>
      <div class="carte"><div class="valeur ${tb.doublons_codes_barres > 0 ? 'alerte-rouge' : ''}">${fmt(tb.doublons_codes_barres)}</div><div class="libelle">Doublons de codes barres</div></div>
      <div class="carte"><div class="valeur">${fmt(statuts.ouvert || 0)} / ${fmt(statuts.cloture || 0)}</div><div class="libelle">Dossiers ouverts / clôturés</div></div>
      <div class="carte"><div class="valeur">${fmt(tarifs.publie || 0)}</div><div class="libelle">Tarifs publiés (${fmt(tarifs.propose || 0)} en attente)</div></div>
    </div>
    <h2>Derniers dossiers d'importation</h2>
    <div class="table-defilante"><table>
      <tr><th>Référence</th><th>Statut</th><th class="num">Lignes</th><th class="num">Valeur d'achat</th><th class="num">Coût total</th><th class="num">Coefficient</th><th class="num">Taux effectif</th></tr>
      ${analyse.map(d => `<tr class="cliquable" onclick="naviguer('#/dossier/${d.id}')">
        <td><a href="#/dossier/${d.id}"><b>${esc(d.reference)}</b></a></td><td>${badgeStatutDossier(d.statut)}</td>
        <td class="num">${fmt(d.nb_lignes)}</td><td class="num">${fcfa(d.valeur_achat)}</td>
        <td class="num">${fcfa(d.cout_total)}</td><td class="num">${d.coefficient ? fmt(d.coefficient, 3) : '-'}</td>
        <td class="num">${d.te_min !== null && d.te_min !== undefined ? fmt(d.te_min, 1) + ' → ' + fmt(d.te_max, 1) + ' %' : '-'}</td>
      </tr>`).join('') || '<tr><td colspan="7">Aucun dossier. Créez votre premier dossier d\'importation.</td></tr>'}
    </table></div>`;
}

function badgeStatutDossier(s) {
  const map = {
    ouvert: ['bleu', 'Ouvert'], titres_obtenus: ['bleu', 'Titres obtenus'], embarque: ['orange', 'Embarqué'],
    declare: ['orange', 'Déclaré'], receptionne: ['vert', 'Réceptionné'], cloture: ['gris', 'Clôturé'], revise: ['rouge', 'Révisé']
  };
  const [cl, lib] = map[s] || ['gris', s];
  return `<span class="badge ${cl}">${lib}</span>`;
}

/* ---------------------------------- Référentiel article ---------------------------------- */
async function vueArticles(page) {
  page.innerHTML = `
    <h1>Référentiel</h1>
    <p class="sous-titre">Socle de la plateforme : toute imprécision se propage au coût et à la marge</p>
    <div class="onglets">
      <button data-o="articles" class="actif">Articles</button>
      <button data-o="fournisseurs">Fournisseurs</button>
      <button data-o="familles">Familles</button>
    </div>
    <div id="ref-contenu"></div>`;
  const onglets = page.querySelectorAll('.onglets button');
  onglets.forEach(b => b.onclick = () => { onglets.forEach(x => x.classList.remove('actif')); b.classList.add('actif'); afficherRef(b.dataset.o); });

  async function afficherRef(o) {
    const conteneur = document.getElementById('ref-contenu');
    if (o === 'articles') return afficherOngletArticles(conteneur);
    if (o === 'fournisseurs') return afficherOngletFournisseurs(conteneur, () => afficherRef('fournisseurs'));
    if (o === 'familles') return afficherOngletFamilles(conteneur, () => afficherRef('familles'));
  }
  await afficherRef('articles');
}

async function afficherOngletFournisseurs(conteneur, recharger) {
  const fournisseurs = await api('/referentiels/fournisseurs');
  conteneur.innerHTML = `
    <div class="carte">
      <h3>Ajouter ou modifier un fournisseur <span class="petite-note">(saisir un code existant pour modifier)</span></h3>
      <div class="ligne-champs">
        <label class="champ">Code *<input id="fo-code" placeholder="CHIMEX" style="width:110px"></label>
        <label class="champ">Nom *<input id="fo-nom" style="min-width:220px"></label>
        <label class="champ">Pays (code)<input id="fo-pays" maxlength="2" style="width:70px" placeholder="CN"></label>
        <label class="champ">Devise<input id="fo-devise" value="XOF" style="width:80px"></label>
        <label class="champ">Incoterm par défaut<input id="fo-incoterm" placeholder="FOB" style="width:90px"></label>
        <label class="champ">Contact<input id="fo-contact" style="min-width:200px" placeholder="courriel ou téléphone"></label>
        <label><input type="checkbox" id="fo-actif" checked> Actif</label>
        <button id="fo-enregistrer">Enregistrer</button>
      </div>
      <div id="fo-msg"></div>
    </div>
    <div class="table-defilante"><table>
      <tr><th>Code</th><th>Nom</th><th>Pays</th><th>Devise</th><th>Incoterm</th><th>Contact</th><th>Actif</th><th class="num">Articles rattachés</th><th></th></tr>
      ${fournisseurs.map(f => `<tr>
        <td><b>${esc(f.code)}</b></td><td>${esc(f.nom)}</td><td>${esc(f.pays || '')}</td>
        <td>${esc(f.devise)}</td><td>${esc(f.incoterm_defaut || '')}</td><td>${esc(f.contact || '')}</td>
        <td>${f.actif ? '<span class="badge vert">oui</span>' : '<span class="badge rouge">non</span>'}</td>
        <td class="num" id="fo-nb-${esc(f.code)}">…</td>
        <td style="white-space:nowrap">
          <button class="petit secondaire" onclick="editerFournisseur('${esc(f.code)}')">Modifier</button>
          <button class="petit danger" onclick="supprFournisseur('${esc(f.code)}')">✕</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="9">Aucun fournisseur. Créez le premier avec le formulaire ci-dessus.</td></tr>'}
    </table></div>`;
  window.supprFournisseur = async code => {
    if (!confirm(`Supprimer le fournisseur ${code} ? (refusé s'il est référencé ; préférez la désactivation)`)) return;
    try { await api('/referentiels/fournisseurs/' + encodeURIComponent(code), { method: 'DELETE' }); recharger(); }
    catch (e) { message('fo-msg', 'erreur', e.message); }
  };
  // Nombre d'articles rattachés (conditions d'achat) par fournisseur
  api('/referentiels/conditions-achat').then(conditions => {
    const compte = {};
    for (const c of conditions) {
      (compte[c.fournisseur_code] = compte[c.fournisseur_code] || new Set()).add(c.article_code);
    }
    for (const f of fournisseurs) {
      const cellule = document.getElementById('fo-nb-' + f.code);
      if (cellule) cellule.textContent = compte[f.code] ? compte[f.code].size : 0;
    }
  }).catch(() => {});
  window.editerFournisseur = code => {
    const f = fournisseurs.find(x => x.code === code);
    if (!f) return;
    document.getElementById('fo-code').value = f.code;
    document.getElementById('fo-nom').value = f.nom;
    document.getElementById('fo-pays').value = f.pays || '';
    document.getElementById('fo-devise').value = f.devise;
    document.getElementById('fo-incoterm').value = f.incoterm_defaut || '';
    document.getElementById('fo-contact').value = f.contact || '';
    document.getElementById('fo-actif').checked = !!f.actif;
    document.getElementById('fo-code').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  document.getElementById('fo-enregistrer').onclick = async () => {
    try {
      await api('/referentiels/fournisseurs', {
        method: 'POST',
        body: { code: val('fo-code'), nom: val('fo-nom'), pays: val('fo-pays').toUpperCase(), devise: val('fo-devise').toUpperCase() || 'XOF', incoterm_defaut: val('fo-incoterm').toUpperCase(), contact: val('fo-contact'), actif: coche('fo-actif') }
      });
      recharger();
    } catch (e) { message('fo-msg', 'erreur', e.message); }
  };
}

async function afficherOngletFamilles(conteneur, recharger) {
  const familles = await api('/referentiels/familles');
  conteneur.innerHTML = `
    <div class="carte">
      <h3>Ajouter ou modifier une famille</h3>
      <div class="ligne-champs">
        <label class="champ">Code *<input id="fa2-code" style="width:120px"></label>
        <label class="champ">Libellé *<input id="fa2-libelle" style="min-width:220px"></label>
        <label class="champ">Famille parente<select id="fa2-parent"><option value="">aucune</option>${familles.map(f => `<option value="${esc(f.code)}">${esc(f.code)}</option>`).join('')}</select></label>
        <label class="champ">Marge cible (%)<input id="fa2-marge" type="number" step="0.1"></label>
        <label class="champ">Démarque (%)<input id="fa2-demarque" type="number" step="0.1"></label>
        <button id="fa2-enregistrer">Enregistrer</button>
      </div>
      <div id="fa2-msg"></div>
    </div>
    <div class="table-defilante"><table>
      <tr><th>Code</th><th>Libellé</th><th>Parente</th><th class="num">Marge cible</th><th class="num">Démarque</th><th class="num">Articles</th><th></th></tr>
      ${familles.map(f => `<tr>
        <td><b>${esc(f.code)}</b></td><td>${esc(f.libelle)}</td><td>${esc(f.parent_code || '')}</td>
        <td class="num">${f.marge_cible !== null ? fmt(f.marge_cible, 1) + ' %' : '-'}</td>
        <td class="num">${f.demarque_taux !== null ? fmt(f.demarque_taux, 1) + ' %' : '-'}</td>
        <td class="num" id="fa2-nb-${esc(f.code)}"></td>
        <td style="white-space:nowrap">
          <button class="petit secondaire" onclick="editerFamille('${esc(f.code)}')">Modifier</button>
          <button class="petit danger" onclick="supprFamille('${esc(f.code)}')">✕</button>
        </td>
      </tr>`).join('')}
    </table></div>
    <p class="petite-note">Le code d'une famille est immuable (il est référencé par les articles et les politiques). Pour renommer, modifiez le libellé ; les articles se reclassent en masse depuis l'onglet Articles.</p>`;
  api('/referentiels/articles?taille=200&page=1').then(r => {
    const compte = {};
    for (const a of (r.articles || [])) compte[a.famille_code] = (compte[a.famille_code] || 0) + 1;
    for (const f of familles) {
      const cellule = document.getElementById('fa2-nb-' + f.code);
      if (cellule) cellule.textContent = compte[f.code] || 0;
    }
  }).catch(() => {});
  window.editerFamille = code => {
    const f = familles.find(x => x.code === code);
    if (!f) return;
    document.getElementById('fa2-code').value = f.code;
    document.getElementById('fa2-libelle').value = f.libelle;
    document.getElementById('fa2-parent').value = f.parent_code || '';
    document.getElementById('fa2-marge').value = f.marge_cible ?? '';
    document.getElementById('fa2-demarque').value = f.demarque_taux ?? '';
    document.getElementById('fa2-code').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  window.supprFamille = async code => {
    if (!confirm(`Supprimer la famille ${code} ? (refusé si des articles y sont rattachés)`)) return;
    try { await api('/referentiels/familles/' + encodeURIComponent(code), { method: 'DELETE' }); recharger(); }
    catch (e) { message('fa2-msg', 'erreur', e.message); }
  };
  document.getElementById('fa2-enregistrer').onclick = async () => {
    try {
      await api('/referentiels/familles', {
        method: 'POST',
        body: { code: val('fa2-code'), libelle: val('fa2-libelle'), parent_code: val('fa2-parent'), marge_cible: val('fa2-marge'), demarque_taux: val('fa2-demarque') }
      });
      recharger();
    } catch (e) { message('fa2-msg', 'erreur', e.message); }
  };
}

async function afficherOngletArticles(page) {
  page.innerHTML = `
    <div class="actions-page">
      <input id="a-recherche" placeholder="Code, code barres, libellé, position…" style="width:280px">
      <label><input type="checkbox" id="a-incomplets"> Données manquantes uniquement</label>
      <button id="a-chercher">Rechercher</button>
      <button class="secondaire" onclick="naviguer('#/article/nouveau')">+ Nouvel article</button>
      <button class="secondaire" id="a-export">Exporter (CSV)</button>
      <button class="secondaire" id="a-import">Importer (CSV)</button>
    </div>
    <div id="a-zone-import"></div>
    <div id="a-liste">Chargement…</div>`;

  async function charger() {
    const q = new URLSearchParams();
    if (val('a-recherche')) q.set('q', val('a-recherche'));
    if (coche('a-incomplets')) q.set('incomplets', '1');
    const articles = await api('/referentiels/articles?' + q.toString());
    const familles = await api('/referentiels/familles');
    document.getElementById('a-liste').innerHTML = `
      <div class="carte" id="a-lot" style="display:none">
        <h3>Modifier la sélection (<span id="a-lot-nb">0</span> article(s))</h3>
        <div class="ligne-champs">
          <label class="champ">Famille<select id="lot-famille"><option value="">(inchangée)</option>${familles.map(f => `<option value="${esc(f.code)}">${esc(f.code)} · ${esc(f.libelle)}</option>`).join('')}</select></label>
          <label class="champ">Statut<select id="lot-statut"><option value="">(inchangé)</option><option value="actif">Actif</option><option value="en_creation">En création</option><option value="en_arret">En arrêt</option><option value="arrete">Arrêté</option><option value="saisonnier">Saisonnier</option></select></label>
          <label class="champ">TVA vente (%)<input id="lot-tva" type="number" step="0.1" placeholder="(inchangée)" style="width:100px"></label>
          <label class="champ">Marge cible (%)<input id="lot-marge" type="number" step="0.1" placeholder="(inchangée)" style="width:100px"></label>
          <label class="champ">Sensibilité prix<select id="lot-sensibilite"><option value="">(inchangée)</option><option value="elevee">Élevée</option><option value="moyenne">Moyenne</option><option value="faible">Faible</option></select></label>
          <label class="champ">Origine (pays)<input id="lot-origine" maxlength="2" placeholder="(inchangée)" style="width:80px"></label>
          <button id="lot-appliquer">Appliquer aux articles cochés</button>
        </div>
        <div id="lot-msg"></div>
      </div>
      <div class="table-defilante"><table>
        <tr><th><input type="checkbox" id="a-tout"></th><th>Code</th><th>Code barres</th><th>Libellé</th><th>Famille</th><th class="num">Colisage</th>
        <th class="num">Poids carton</th><th class="num">Volume</th><th class="num">Densité</th><th>UP</th>
        <th>Position</th><th class="num">Taux eff.</th><th>Complétude</th></tr>
        ${articles.map(a => `<tr>
          <td><input type="checkbox" class="a-coche" value="${esc(a.code_interne)}"></td>
          <td><a href="#/article/${encodeURIComponent(a.code_interne)}"><b>${esc(a.code_interne)}</b></a></td><td>${esc(a.code_barres || '')}</td><td><a href="#/article/${encodeURIComponent(a.code_interne)}">${esc(a.libelle)}</a></td>
          <td>${esc(a.famille_code || '')}</td><td class="num">${fmt(a.unites_par_carton)}</td>
          <td class="num">${a.poids_brut_carton ? fmt(a.poids_brut_carton, 2) + ' kg' : '-'}</td>
          <td class="num">${a.volume_carton ? fmt(a.volume_carton, 4) + ' m³' : '-'}</td>
          <td class="num">${a.densite ? fmt(a.densite) : '-'}</td>
          <td>${a.indicateur_up ? `<span class="badge ${a.indicateur_up === 'poids' ? 'bleu' : 'orange'}">${a.indicateur_up}</span>` : '-'}</td>
          <td>${esc(a.position_tarifaire || '')}</td>
          <td class="num">${a.taux_effectif_constate ? fmt(a.taux_effectif_constate, 1) + ' %' : '-'}</td>
          <td>${a.complet ? '<span class="badge vert">complète</span>' : `<span class="badge rouge" title="${esc(a.donnees_manquantes.join(', '))}">${a.donnees_manquantes.length} manquante(s)</span>`}</td>
        </tr>`).join('') || '<tr><td colspan="13">Aucun article.</td></tr>'}
      </table></div>
      <p class="petite-note">${articles.length} article(s) affiché(s) · limite 500. Cochez des articles pour les modifier en masse (famille, statut, TVA…).</p>`;

    // Barre de modification en masse : apparaît dès qu'un article est coché
    const majBarreLot = () => {
      const coches = document.querySelectorAll('.a-coche:checked');
      document.getElementById('a-lot').style.display = coches.length ? '' : 'none';
      document.getElementById('a-lot-nb').textContent = coches.length;
    };
    document.getElementById('a-tout').onchange = e => {
      document.querySelectorAll('.a-coche').forEach(c => c.checked = e.target.checked);
      majBarreLot();
    };
    document.querySelectorAll('.a-coche').forEach(c => c.onchange = majBarreLot);
    document.getElementById('lot-appliquer').onclick = async () => {
      const codes = [...document.querySelectorAll('.a-coche:checked')].map(c => c.value);
      if (!codes.length) return;
      const champs = {
        famille_code: val('lot-famille'), statut: val('lot-statut'), taux_tva_vente: val('lot-tva'),
        marge_cible: val('lot-marge'), sensibilite_prix: val('lot-sensibilite'), origine: val('lot-origine').toUpperCase()
      };
      if (!Object.values(champs).some(v => v !== '')) {
        message('lot-msg', 'erreur', 'Choisissez au moins un champ à modifier.');
        return;
      }
      try {
        const r = await api('/referentiels/articles-modifier-lot', { method: 'POST', body: { codes, champs } });
        message('lot-msg', 'ok', `${r.modifies} article(s) modifié(s). Les changements sont tracés dans l'historique de chaque fiche.`);
        setTimeout(charger, 1200);
      } catch (e) { message('lot-msg', 'erreur', e.message); }
    };
  }
  document.getElementById('a-chercher').onclick = charger;
  document.getElementById('a-recherche').addEventListener('keydown', e => { if (e.key === 'Enter') charger(); });
  document.getElementById('a-export').onclick = () => telecharger('/referentiels/articles-export/csv', 'referentiel_articles.csv');
  document.getElementById('a-import').onclick = () => {
    const zone = document.getElementById('a-zone-import');
    zone.innerHTML = '<div class="carte"><h3>Import du référentiel</h3><div id="a-assistant"></div></div>';
    monterAssistantImport({
      conteneur: zone.querySelector('#a-assistant'),
      type: 'articles',
      note: 'Formats acceptés : Annexe B du CDC ou tout export (facture fournisseur, liste de colisage…).',
      envoyer: async csv => {
        const r = await api('/referentiels/articles-import/csv', { method: 'POST', body: { contenu: csv, confirmer: true } });
        charger();
        let compte = `${r.crees} article(s) créé(s), ${r.modifies} modifié(s), ${r.rejets.length} rejet(s).`;
        if (r.rejets.length) compte += ' Premiers rejets : ' + r.rejets.slice(0, 5).map(x => `ligne ${x.ligne} (${x.motif})`).join(' ; ');
        if (r.avertissements && r.avertissements.length) compte += ` ${r.avertissements.length} avertissement(s) : codes barres invalides importés sans code.`;
        return compte;
      }
    });
  };
  await charger();
}

async function vueFicheArticle(page, args) {
  const code = decodeURIComponent(args[0] || 'nouveau');
  const nouveau = code === 'nouveau';
  let a = {};
  if (!nouveau) a = await api('/referentiels/articles/' + encodeURIComponent(code));
  const [familles, fournisseurs] = await Promise.all([api('/referentiels/familles'), api('/referentiels/fournisseurs')]);

  const champ = (id, libelle, valeur, type = 'text', attrs = '') =>
    `<label class="champ">${libelle}<input id="${id}" type="${type}" value="${esc(valeur ?? '')}" ${attrs}></label>`;
  const sel = (id, libelle, options, valeur) =>
    `<label class="champ">${libelle}<select id="${id}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(valeur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;

  page.innerHTML = `
    <h1>${nouveau ? 'Nouvel article' : esc(a.libelle)}</h1>
    <p class="sous-titre">${nouveau ? '' : 'Code ' + esc(a.code_interne) + (a.complet ? '' : ' · <span class="badge rouge">données manquantes : ' + esc((a.donnees_manquantes || []).join(', ')) + '</span>')}</p>
    <div id="fa-msg"></div>
    <div class="carte">
      <h3>Identification</h3>
      <div class="ligne-champs">
        ${champ('fa-code', 'Code interne *', a.code_interne, 'text', nouveau ? '' : 'readonly')}
        ${champ('fa-cb', 'Code barres (EAN/UPC)', a.code_barres)}
        ${champ('fa-libelle', 'Libellé long *', a.libelle, 'text', 'style="min-width:300px"')}
        ${champ('fa-libelle-court', 'Libellé court (caisse)', a.libelle_court)}
        ${sel('fa-famille', 'Famille', [['', '-']].concat(familles.map(f => [f.code, f.code + ' · ' + f.libelle])), a.famille_code)}
        ${champ('fa-marque', 'Marque', a.marque)}
        ${sel('fa-type-marque', 'Type de marque', [['', '-'], ['nationale', 'Marque nationale'], ['propre', 'Marque propre'], ['premier_prix', 'Premier prix']], a.type_marque)}
        ${sel('fa-statut', 'Statut', [['en_creation', 'En création'], ['actif', 'Actif'], ['en_arret', 'En arrêt'], ['arrete', 'Arrêté'], ['saisonnier', 'Saisonnier']], a.statut || 'actif')}
        ${sel('fa-fournisseur', 'Fournisseur principal', [['', '-']].concat(fournisseurs.map(f => [f.code, f.code + ' · ' + f.nom])), a.fournisseur_code)}
        ${champ('fa-ref-fourn', 'Référence fournisseur', a.reference_fournisseur)}
      </div>
    </div>
    <div class="carte">
      <h3>Logistique <span class="petite-note">- volume calculé depuis les dimensions, densité et unité payante déduites</span></h3>
      <div class="ligne-champs">
        ${champ('fa-upc', 'Unités / carton', a.unites_par_carton, 'number')}
        ${champ('fa-pnu', 'Poids net unitaire (kg)', a.poids_net_unitaire, 'number', 'step="0.001"')}
        ${champ('fa-pbc', 'Poids brut carton (kg)', a.poids_brut_carton, 'number', 'step="0.001"')}
        ${champ('fa-long', 'Longueur carton (cm)', a.longueur_carton, 'number', 'step="0.1"')}
        ${champ('fa-larg', 'Largeur carton (cm)', a.largeur_carton, 'number', 'step="0.1"')}
        ${champ('fa-haut', 'Hauteur carton (cm)', a.hauteur_carton, 'number', 'step="0.1"')}
        ${champ('fa-vol', 'Volume carton (m³)', a.volume_carton, 'number', 'step="0.00001"')}
      </div>
      ${!nouveau && a.densite ? `<p>Densité : <b>${fmt(a.densite)} kg/m³</b> · l'unité payante retenue pour le fret est le <span class="badge ${a.indicateur_up === 'poids' ? 'bleu' : 'orange'}">${a.indicateur_up}</span></p>` : ''}
    </div>
    <div class="carte">
      <h3>Douane &amp; fiscalité</h3>
      <div class="ligne-champs">
        ${champ('fa-position', 'Position tarifaire (10 chiffres)', a.position_tarifaire)}
        <button class="secondaire petit" id="fa-suggerer" title="Propose des positions d'après le libellé de l'article">Suggérer d'après le libellé</button>
        ${champ('fa-origine', 'Origine (code pays)', a.origine, 'text', 'maxlength="2" style="width:70px"')}
        ${champ('fa-tva', 'TVA à la vente (%)', a.taux_tva_vente ?? 18, 'number', 'step="0.1"')}
      </div>
      <div id="fa-suggestions"></div>
      ${a.taux_effectif_constate ? `<p>Taux effectif de droits et taxes constaté sur dossiers : <b>${fmt(a.taux_effectif_constate, 1)} %</b></p>` : ''}
    </div>
    <div class="carte">
      <h3>Commercial</h3>
      <div class="ligne-champs">
        ${champ('fa-marge', 'Marge cible (%, surcharge famille)', a.marge_cible, 'number', 'step="0.1"')}
        ${sel('fa-role', "Rôle dans l'assortiment", [['', '-'], ['appel', "Produit d'appel"], ['marge', 'Produit de marge'], ['gamme', 'Produit de gamme']], a.role_assortiment)}
        ${sel('fa-sensibilite', 'Sensibilité prix', [['', '-'], ['elevee', 'Élevée'], ['moyenne', 'Moyenne'], ['faible', 'Faible']], a.sensibilite_prix)}
        ${sel('fa-arbitrage', "Mode d'arbitrage prix", [['', 'Selon politique'], ['marge', 'Marge prioritaire'], ['marche', 'Marché prioritaire'], ['encadre', 'Encadré'], ['alignement', 'Alignement strict'], ['manuel', 'Manuel']], a.mode_arbitrage)}
      </div>
    </div>
    <div class="actions-page">
      <button id="fa-enregistrer">Enregistrer</button>
      <button class="secondaire" onclick="naviguer('#/articles')">Retour à la liste</button>
      ${!nouveau ? '<button class="danger" id="fa-supprimer" title="Refusé si l\'article est utilisé dans un dossier, un tarif, un relevé ou une vente">Supprimer l\'article</button>' : ''}
    </div>
    ${!nouveau ? `
    <div class="carte" id="fa-zone-fournisseurs">
      <h3>Fournisseurs de l'article <span class="petite-note">- plusieurs fournisseurs possibles, un principal (F-M1-08) ; comparaison au meilleur prix converti (F-M3-07)</span></h3>
      <div id="fa-comparaison">Chargement…</div>
      <h3>Rattacher un fournisseur (nouvelle condition d'achat)</h3>
      <div class="ligne-champs">
        <label class="champ">Fournisseur<select id="ca-fournisseur">${fournisseurs.map(f => `<option value="${esc(f.code)}">${esc(f.code)} · ${esc(f.nom)}</option>`).join('')}</select></label>
        <label class="champ">Prix d'achat *<input id="ca-prix" type="number" step="0.0001" style="width:110px"></label>
        <label class="champ">Devise<input id="ca-devise" value="XOF" style="width:70px"></label>
        <label class="champ">Remise (%)<input id="ca-remise" type="number" step="0.1" value="0" style="width:80px"></label>
        <label class="champ">Incoterm<input id="ca-incoterm" placeholder="FOB" style="width:80px"></label>
        <label class="champ">Date d'effet<input id="ca-date" type="date"></label>
        <button id="ca-ajouter">Rattacher</button>
        <button class="secondaire" id="ca-nouveau-fournisseur">+ Nouveau fournisseur</button>
      </div>
      <div id="ca-nouveau-zone"></div>
      <div id="ca-msg"></div>
    </div>
    <div class="deux-colonnes">
      <div class="carte">
        <h3>Codes barres secondaires <span class="petite-note">- lot, unité consommateur, appariements (F-M1-12)</span></h3>
        <div class="table-defilante"><table>
          <tr><th>Code barres</th><th>Description</th><th></th></tr>
          <tr><td><b>${esc(a.code_barres || '-')}</b></td><td>Code principal</td><td></td></tr>
          ${(a.codes_barres_secondaires || []).map(cb => `<tr><td>${esc(cb.code_barres)}</td><td>${esc(cb.description || '')}</td>
            <td><button class="petit danger" onclick="supprCodeBarres('${esc(cb.code_barres)}')">✕</button></td></tr>`).join('')}
        </table></div>
        <div class="ligne-champs" style="margin-top:8px">
          <label class="champ">Code barres<input id="cb-nouveau" placeholder="EAN 8/13 ou UPC"></label>
          <label class="champ">Description<input id="cb-description" placeholder="lot de 6, carton…"></label>
          <button class="petit" id="cb-ajouter">Ajouter</button>
        </div>
        <div id="cb-msg"></div>
      </div>
      <div class="carte">
        <h3>Historique des modifications</h3>
        ${(a.historique || []).length ? `<div class="table-defilante" style="max-height:300px;overflow-y:auto"><table>
          <tr><th>Date</th><th>Champ</th><th>Avant</th><th>Après</th><th>Source</th></tr>
          ${a.historique.map(h => `<tr><td>${dateFr(h.date_modif)}</td><td>${esc(h.champ)}</td><td>${esc(h.ancienne_valeur ?? '')}</td><td>${esc(h.nouvelle_valeur ?? '')}</td><td><span class="badge ${h.source === 'dossier' ? 'orange' : 'gris'}">${esc(h.source)}</span></td></tr>`).join('')}
        </table></div>` : '<p class="petite-note">Aucune modification tracée.</p>'}
      </div>
    </div>
    <div class="deux-colonnes">
      <div class="carte">
        <h3>Photos et fiches techniques <span class="petite-note">(F-M1-13)</span></h3>
        <div id="fa-photos" class="ligne-champs"></div>
        <div class="actions-page"><button class="petit secondaire" id="fa-photo-ajouter">⬆ Ajouter une photo ou un document</button></div>
      </div>
      <div class="carte">
        <h3>Articles liés <span class="petite-note">- lot, unité consommateur, remplacement, variante (F-M1-12, F-M1-15)</span></h3>
        <div class="table-defilante"><table>
          <tr><th>Type</th><th>Article</th><th>Précision</th><th></th></tr>
          ${(a.liens || []).map(l => `<tr>
            <td><span class="badge bleu">${esc(l.type_lien)}</span> ${l.sens === 'entrant' ? '<span class="petite-note">(lié depuis)</span>' : ''}</td>
            <td><a href="#/article/${encodeURIComponent(l.sens === 'entrant' ? l.article_code : l.article_lie_code)}">${esc(l.sens === 'entrant' ? l.article_code : l.article_lie_code)}</a><br>
              <span class="petite-note">${esc(l.article_lie_libelle || '')}</span></td>
            <td>${esc(l.description || '')}</td>
            <td>${l.sens === 'sortant' ? `<button class="petit danger" onclick="supprLien(${l.id})">✕</button>` : ''}</td>
          </tr>`).join('') || '<tr><td colspan="4">Aucun article lié.</td></tr>'}
        </table></div>
        <div class="ligne-champs" style="margin-top:8px">
          <label class="champ">Type<select id="li-type">
            <option value="variante">Variante (taille, couleur, parfum)</option>
            <option value="lot">Lot</option>
            <option value="uvc">Unité de vente consommateur</option>
            <option value="remplacement">Article de remplacement</option></select></label>
          <label class="champ">Code article lié<input id="li-code"></label>
          <label class="champ">Précision<input id="li-description" placeholder="ex. parfum vanille, lot de 6"></label>
          <button class="petit" id="li-ajouter">Lier</button>
        </div>
        <div id="li-msg"></div>
      </div>
    </div>` : ''}`;

  document.getElementById('fa-enregistrer').onclick = async () => {
    try {
      await api('/referentiels/articles', {
        method: 'POST',
        body: {
          code_interne: val('fa-code'), code_barres: val('fa-cb'), libelle: val('fa-libelle'),
          libelle_court: val('fa-libelle-court'), famille_code: val('fa-famille'), marque: val('fa-marque'),
          type_marque: val('fa-type-marque'), statut: val('fa-statut'), fournisseur_code: val('fa-fournisseur'),
          reference_fournisseur: val('fa-ref-fourn'), unites_par_carton: val('fa-upc'),
          poids_net_unitaire: val('fa-pnu'), poids_brut_carton: val('fa-pbc'),
          longueur_carton: val('fa-long'), largeur_carton: val('fa-larg'), hauteur_carton: val('fa-haut'),
          volume_carton: val('fa-vol'), position_tarifaire: val('fa-position'), origine: val('fa-origine'),
          taux_tva_vente: val('fa-tva'), marge_cible: val('fa-marge'), role_assortiment: val('fa-role'),
          sensibilite_prix: val('fa-sensibilite'), mode_arbitrage: val('fa-arbitrage')
        }
      });
      message('fa-msg', 'ok', 'Article enregistré.');
      if (nouveau) naviguer('#/article/' + encodeURIComponent(val('fa-code')));
    } catch (e) { message('fa-msg', 'erreur', e.message); }
  };

  if (nouveau) return;

  document.getElementById('fa-supprimer').onclick = async () => {
    if (!confirm(`Supprimer définitivement l'article ${code} ? Cette action est refusée s'il est utilisé quelque part.`)) return;
    try {
      await api('/referentiels/articles/' + encodeURIComponent(code), { method: 'DELETE' });
      naviguer('#/articles');
    } catch (e) {
      message('fa-msg', 'erreur', e.message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  /* --------- Fournisseurs de l'article : comparaison, principal, rattachement --------- */
  async function chargerComparaison() {
    const zone = document.getElementById('fa-comparaison');
    const r = await api(`/referentiels/articles/${encodeURIComponent(code)}/comparaison-fournisseurs`);
    if (!r.comparaison.length) {
      zone.innerHTML = '<p class="petite-note">Aucun fournisseur rattaché. Utilisez le formulaire ci-dessous : le premier rattaché devient automatiquement le fournisseur principal.</p>';
      return;
    }
    const meilleur = r.comparaison.find(c => c.prix_net_xof !== null);
    zone.innerHTML = `<div class="table-defilante"><table>
      <tr><th>Fournisseur</th><th>Pays</th><th class="num">Prix</th><th class="num">Remise</th><th class="num">Prix net</th>
      <th class="num">Équivalent F CFA</th><th>Incoterm</th><th>Date d'effet</th><th>Principal</th><th></th></tr>
      ${r.comparaison.map(c => `<tr ${meilleur && c.id === meilleur.id ? 'style="background:var(--vert-ok-fond)"' : ''}>
        <td><b>${esc(c.fournisseur_code)}</b><br><span class="petite-note">${esc(c.fournisseur_nom)}</span></td>
        <td>${esc(c.pays || '')}</td>
        <td class="num">${fmt(c.prix_achat, 4)} ${esc(c.devise)}</td>
        <td class="num">${fmt(c.remise_pct, 1)} %</td>
        <td class="num">${fmt(c.prix_net_devise, 4)} ${esc(c.devise)}</td>
        <td class="num">${c.prix_net_xof !== null ? `<b>${fcfa(c.prix_net_xof)}</b>${meilleur && c.id === meilleur.id ? ' <span class="badge vert">meilleur prix</span>' : ''}` : '<span class="badge orange" title="Saisir le cours de la devise dans Administration > Taux de change">cours ' + esc(c.devise) + ' inconnu</span>'}</td>
        <td>${esc(c.incoterm || '')}</td>
        <td>${dateFr(c.date_effet)}</td>
        <td>${c.principal ? '<span class="badge vert">principal</span>' : `<button class="petit secondaire" onclick="definirPrincipal('${esc(c.fournisseur_code)}')">Définir principal</button>`}</td>
        <td><button class="petit danger" onclick="supprCondition(${c.id})" title="Supprimer cette condition">✕</button></td>
      </tr>`).join('')}
    </table></div>`;
  }
  window.definirPrincipal = async fc => {
    try {
      await api(`/referentiels/articles/${encodeURIComponent(code)}/fournisseur-principal`, { method: 'POST', body: { fournisseur_code: fc } });
      message('ca-msg', 'ok', `${fc} est désormais le fournisseur principal.`);
      chargerComparaison();
    } catch (e) { message('ca-msg', 'erreur', e.message); }
  };
  window.supprCondition = async cid => {
    await api(`/referentiels/conditions-achat/${cid}`, { method: 'DELETE' });
    chargerComparaison();
  };
  document.getElementById('ca-ajouter').onclick = async () => {
    try {
      await api('/referentiels/conditions-achat', {
        method: 'POST',
        body: { fournisseur_code: val('ca-fournisseur'), article_code: code, prix_achat: val('ca-prix'), devise: val('ca-devise').toUpperCase() || 'XOF', remise_pct: val('ca-remise'), incoterm: val('ca-incoterm').toUpperCase(), date_effet: val('ca-date') || null }
      });
      message('ca-msg', 'ok', 'Fournisseur rattaché avec sa condition d\'achat.');
      document.getElementById('ca-prix').value = '';
      chargerComparaison();
    } catch (e) { message('ca-msg', 'erreur', e.message); }
  };
  // Création rapide d'un fournisseur sans quitter la fiche
  document.getElementById('ca-nouveau-fournisseur').onclick = () => {
    document.getElementById('ca-nouveau-zone').innerHTML = `
      <div class="carte" style="background:var(--vert-clair)">
        <div class="ligne-champs">
          <label class="champ">Code *<input id="nf-code" style="width:110px"></label>
          <label class="champ">Nom *<input id="nf-nom" style="min-width:200px"></label>
          <label class="champ">Pays<input id="nf-pays" maxlength="2" style="width:60px"></label>
          <label class="champ">Devise<input id="nf-devise" value="XOF" style="width:70px"></label>
          <button class="petit" id="nf-creer">Créer et sélectionner</button>
        </div>
      </div>`;
    document.getElementById('nf-creer').onclick = async () => {
      try {
        await api('/referentiels/fournisseurs', {
          method: 'POST',
          body: { code: val('nf-code'), nom: val('nf-nom'), pays: val('nf-pays').toUpperCase(), devise: val('nf-devise').toUpperCase() || 'XOF' }
        });
        const select = document.getElementById('ca-fournisseur');
        const codeF = val('nf-code').toUpperCase();
        select.insertAdjacentHTML('beforeend', `<option value="${esc(codeF)}">${esc(codeF)} · ${esc(val('nf-nom'))}</option>`);
        select.value = codeF;
        document.getElementById('ca-devise').value = val('nf-devise').toUpperCase() || 'XOF';
        document.getElementById('ca-nouveau-zone').innerHTML = '';
        message('ca-msg', 'ok', `Fournisseur ${codeF} créé et sélectionné : saisissez le prix pour le rattacher.`);
      } catch (e) { message('ca-msg', 'erreur', e.message); }
    };
  };

  /* --------- Suggestion de position tarifaire (F-M1-14) --------- */
  document.getElementById('fa-suggerer').onclick = async () => {
    const libelle = val('fa-libelle');
    if (!libelle) { message('fa-suggestions', 'erreur', 'Saisissez d\'abord le libellé.'); return; }
    const suggestions = await api('/referentiels/suggestion-position?libelle=' + encodeURIComponent(libelle));
    if (!suggestions.length) {
      message('fa-suggestions', 'info', 'Aucune position proche trouvée dans la nomenclature. Enrichissez la nomenclature dans Douane & fiscalité.');
      return;
    }
    document.getElementById('fa-suggestions').innerHTML = `
      <div class="message info">Positions proches du libellé (cliquer pour retenir) :<br>
      ${suggestions.map(s => `<button class="petit secondaire" style="margin:3px" onclick="retenirPosition('${esc(s.code)}')">
        ${esc(s.code)} · ${esc(s.libelle)} (DD ${fmt(s.taux_dd, 1)} %${s.pertinence ? ', pertinence ' + fmt(Number(s.pertinence) * 100, 0) + ' %' : ''})</button>`).join('')}</div>`;
  };
  window.retenirPosition = codePos => {
    document.getElementById('fa-position').value = codePos;
    document.getElementById('fa-suggestions').innerHTML = '';
  };

  /* --------- Photos (F-M1-13) : chargées avec le jeton puis affichées en aperçu --------- */
  async function chargerPhotos() {
    const zone = document.getElementById('fa-photos');
    const photos = a.photos || [];
    if (!photos.length) { zone.innerHTML = '<p class="petite-note">Aucune photo ni fiche technique.</p>'; return; }
    zone.innerHTML = '';
    for (const p of photos) {
      const bloc = document.createElement('div');
      bloc.style.cssText = 'text-align:center;max-width:140px';
      if (p.type_mime.startsWith('image/')) {
        const rep = await fetch(`/api/referentiels/photos/${p.id}`, { headers: { Authorization: 'Bearer ' + etat.token } });
        const url = URL.createObjectURL(await rep.blob());
        bloc.innerHTML = `<img src="${url}" style="max-width:130px;max-height:130px;border-radius:6px;border:1px solid var(--bord)"><br>`;
      } else {
        bloc.innerHTML = `<span style="font-size:34px">📄</span><br>`;
      }
      bloc.innerHTML += `<span class="petite-note">${esc(p.nom_fichier)}</span><br>
        <button class="petit secondaire" onclick="telecharger('/referentiels/photos/${p.id}','${esc(p.nom_fichier)}')">Ouvrir</button>
        <button class="petit danger" onclick="supprPhoto(${p.id})">✕</button>`;
      zone.appendChild(bloc);
    }
  }
  window.supprPhoto = async pid => {
    await api(`/referentiels/photos/${pid}`, { method: 'DELETE' });
    rendre();
  };
  window.telecharger = telecharger;
  document.getElementById('fa-photo-ajouter').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.jpg,.jpeg,.png,.webp,.pdf';
    input.onchange = async () => {
      const fichier = input.files[0];
      if (!fichier) return;
      if (fichier.size > 5 * 1024 * 1024) { alert('Fichier trop volumineux (5 Mo maximum).'); return; }
      const rep = await fetch(`/api/referentiels/articles/${encodeURIComponent(code)}/photos`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + etat.token,
          'Content-Type': fichier.type || 'application/octet-stream',
          'X-Nom-Fichier': encodeURIComponent(fichier.name)
        },
        body: fichier
      });
      if (rep.ok) rendre();
      else alert('Échec du téléversement : ' + ((await rep.json().catch(() => ({}))).erreur || rep.status));
    };
    input.click();
  };
  chargerPhotos();

  /* --------- Articles liés (F-M1-12, F-M1-15) --------- */
  window.supprLien = async lid => {
    await api(`/referentiels/liens/${lid}`, { method: 'DELETE' });
    rendre();
  };
  document.getElementById('li-ajouter').onclick = async () => {
    try {
      await api(`/referentiels/articles/${encodeURIComponent(code)}/liens`, {
        method: 'POST',
        body: { article_lie_code: val('li-code'), type_lien: val('li-type'), description: val('li-description') }
      });
      rendre();
    } catch (e) { message('li-msg', 'erreur', e.message); }
  };

  /* --------- Codes barres secondaires --------- */
  window.supprCodeBarres = async cb => {
    await api(`/referentiels/articles/${encodeURIComponent(code)}/codes-barres/${encodeURIComponent(cb)}`, { method: 'DELETE' });
    rendre();
  };
  document.getElementById('cb-ajouter').onclick = async () => {
    try {
      await api(`/referentiels/articles/${encodeURIComponent(code)}/codes-barres`, {
        method: 'POST', body: { code_barres: val('cb-nouveau'), description: val('cb-description') }
      });
      rendre();
    } catch (e) { message('cb-msg', 'erreur', e.message); }
  };

  await chargerComparaison();
}

/* ---------------------------------- Douane ---------------------------------- */
async function vueDouane(page) {
  page.innerHTML = `
    <h1>Référentiel douanier et fiscal</h1>
    <p class="sous-titre">Nomenclature TEC UEMOA, codes taxes paramétrables, simulateur de liquidation</p>
    <div class="onglets">
      <button data-o="simulateur" class="actif">Simulateur</button>
      <button data-o="positions">Positions tarifaires</button>
      <button data-o="taxes">Codes taxes</button>
      <button data-o="exonerations">Exonérations</button>
    </div>
    <div id="d-contenu"></div>`;
  const onglets = page.querySelectorAll('.onglets button');
  onglets.forEach(b => b.onclick = () => { onglets.forEach(x => x.classList.remove('actif')); b.classList.add('actif'); afficher(b.dataset.o); });

  async function afficher(o) {
    const c = document.getElementById('d-contenu');
    if (o === 'simulateur') {
      c.innerHTML = `
        <div class="carte">
          <h3>Simulation de liquidation (reproduction du calcul de la Douane)</h3>
          <div class="ligne-champs">
            <label class="champ">Valeur en douane (F CFA)<input id="s-vd" type="number" value="1000000"></label>
            <label class="champ">Position tarifaire<input id="s-pos" placeholder="10 chiffres"></label>
            <label class="champ">Origine (code pays)<input id="s-ori" maxlength="2" style="width:70px"></label>
            <label class="champ">À la date du<input id="s-date" type="date" title="Recalcul aux taux en vigueur à cette date"></label>
            <button id="s-lancer">Simuler</button>
          </div>
          <div id="s-resultat"></div>
        </div>`;
      document.getElementById('s-lancer').onclick = async () => {
        try {
          const r = await api('/douane/simulation', { method: 'POST', body: { valeur_en_douane: val('s-vd'), position_tarifaire: val('s-pos'), origine: val('s-ori'), date: val('s-date') || null } });
          document.getElementById('s-resultat').innerHTML = `
            ${r.position ? (r.position.niveau === 'approche'
              ? `<div class="message info">Position ${esc(r.position.code_demande)} absente du référentiel : taux repris du niveau supérieur <b>${esc(r.position.code)}</b> · ${esc(r.position.libelle)} (droit de douane ${fmt(r.position.taux_dd, 1)} %). Saisissez la position exacte ou importez le tarif officiel pour affiner.</div>`
              : `<p>Position <b>${esc(r.position.code)}</b> · ${esc(r.position.libelle)} (droit de douane ${fmt(r.position.taux_dd, 1)} %)</p>`)
              : '<p class="message info">Position inconnue du référentiel : droit de douane à 0 %, seules les taxes à taux fixe sont calculées.</p>'}
            <div class="table-defilante"><table>
              <tr><th>Taxe</th><th class="num">Base</th><th class="num">Taux</th><th class="num">Montant</th><th>Traitement</th></tr>
              ${r.lignes.map(l => `<tr><td>${esc(l.code)} · ${esc(l.libelle)}</td><td class="num">${fcfa(l.base)}</td><td class="num">${fmt(l.taux, 2)} %</td><td class="num">${fcfa(l.montant)}</td>
                <td>${l.traitement === 'cout' ? '<span class="badge orange">coût, incorporé au stock</span>' : '<span class="badge vert">créance sur l\'État</span>'}</td></tr>`).join('')}
              <tr><td><b>Total liquidé</b></td><td></td><td></td><td class="num"><b>${fcfa(r.total)}</b></td><td></td></tr>
              <tr><td>dont coût (capitalisé)</td><td></td><td></td><td class="num">${fcfa(r.total_cout)}</td><td></td></tr>
              <tr><td>dont créance sur l'État</td><td></td><td></td><td class="num">${fcfa(r.total_creance)}</td><td></td></tr>
            </table></div>
            <p><b>Taux effectif (coût / valeur en douane) : ${fmt(r.taux_effectif, 2)} %</b></p>`;
        } catch (e) { message('s-resultat', 'erreur', e.message); }
      };
    } else if (o === 'positions') {
      const positions = await api('/douane/positions');
      c.innerHTML = `
        <div class="message info">Base préchargée : les 97 chapitres du système harmonisé avec le taux dominant du TEC CEDEAO/UEMOA et environ 200 positions détaillées pour la grande distribution. Une position absente est automatiquement rattachée au niveau supérieur (sous-position puis chapitre). Taux indicatifs : le tarif officiel des Douanes prime, importez-le ci-dessous (code;libelle;categorie;taux_dd) ou saisissez la position exacte, qui l'emportera toujours sur le niveau approché.</div>`;
      c.innerHTML += `
        <div class="carte">
          <h3>Ajouter / modifier une position</h3>
          <div class="ligne-champs">
            <label class="champ">Code (10 chiffres)<input id="p-code"></label>
            <label class="champ">Libellé<input id="p-libelle" style="min-width:260px"></label>
            <label class="champ">Catégorie TEC<select id="p-cat">
              <option value="Cat. 0">Cat. 0 (0 %)</option><option value="Cat. 1">Cat. 1 (5 %)</option>
              <option value="Cat. 2">Cat. 2 (10 %)</option><option value="Cat. 3" selected>Cat. 3 (20 %)</option>
              <option value="Cat. 4">Cat. 4 (35 %)</option></select></label>
            <label class="champ">Taux DD (%)<input id="p-taux" type="number" step="0.1" value="20"></label>
            <button id="p-ajouter">Enregistrer</button>
          </div>
          <div id="p-msg"></div>
        </div>
        <div class="table-defilante"><table>
          <tr><th>Code</th><th>Libellé</th><th>Catégorie</th><th class="num">Droit de douane</th><th>Date d'effet</th></tr>
          ${positions.map(p => `<tr><td>${esc(p.code)}</td><td>${esc(p.libelle)}</td><td>${esc(p.categorie || '')}</td><td class="num">${fmt(p.taux_dd, 1)} %</td><td>${dateFr(p.date_effet)}</td></tr>`).join('')}
        </table></div>`;
      document.getElementById('p-ajouter').onclick = async () => {
        try {
          await api('/douane/positions', { method: 'POST', body: { code: val('p-code'), libelle: val('p-libelle'), categorie: val('p-cat'), taux_dd: val('p-taux') } });
          afficher('positions');
        } catch (e) { message('p-msg', 'erreur', e.message); }
      };
    } else if (o === 'taxes') {
      const taxes = await api('/douane/taxes');
      c.innerHTML = `
        <div class="message info">La distinction coût / créance sur l'État est portée par le paramétrage de chaque taxe · règle la plus critique de la plateforme (CDC §6.3). La base est exprimée en composants : VD (valeur en douane) et codes des taxes déjà calculées, séparés par « + ».</div>
        <div class="table-defilante"><table>
          <tr><th class="num">Ordre</th><th>Code</th><th>Libellé</th><th class="num">Taux</th><th>Base de calcul</th><th>Traitement</th><th>Actif</th></tr>
          ${taxes.map(t => `<tr><td class="num">${t.ordre}</td><td><b>${esc(t.code)}</b></td><td>${esc(t.libelle)}</td>
            <td class="num">${t.taux_depuis_position ? '<span class="badge bleu">taux de la position</span>' : fmt(t.taux, 2) + ' %'}</td>
            <td><code>${esc(t.base_composants)}</code></td>
            <td>${t.traitement === 'cout' ? '<span class="badge orange">coût</span>' : '<span class="badge vert">créance</span>'}</td>
            <td>${t.actif ? 'oui' : 'non'}</td></tr>`).join('')}
        </table></div>
        ${etat.utilisateur.role === 'admin' ? `
        <div class="carte"><h3>Ajouter / modifier une taxe</h3>
          <div class="ligne-champs">
            <label class="champ">Code<input id="t-code"></label>
            <label class="champ">Libellé<input id="t-libelle" style="min-width:220px"></label>
            <label class="champ">Ordre<input id="t-ordre" type="number" value="9"></label>
            <label class="champ">Taux (%)<input id="t-taux" type="number" step="0.01"></label>
            <label class="champ">Base (ex. VD+DD)<input id="t-base" value="VD"></label>
            <label class="champ">Traitement<select id="t-traitement"><option value="cout">Coût (stock)</option><option value="creance">Créance sur l'État</option></select></label>
            <label><input type="checkbox" id="t-position"> Taux issu de la position (DD)</label>
            <button id="t-ajouter">Enregistrer</button>
          </div><div id="t-msg"></div>
        </div>` : ''}`;
      const btn = document.getElementById('t-ajouter');
      if (btn) btn.onclick = async () => {
        try {
          await api('/douane/taxes', { method: 'POST', body: { code: val('t-code'), libelle: val('t-libelle'), ordre: val('t-ordre'), taux: val('t-taux'), base_composants: val('t-base'), traitement: val('t-traitement'), taux_depuis_position: coche('t-position') } });
          afficher('taxes');
        } catch (e) { message('t-msg', 'erreur', e.message); }
      };
    } else if (o === 'exonerations') {
      const [exos, taxes] = await Promise.all([api('/douane/exonerations'), api('/douane/taxes')]);
      c.innerHTML = `
        <div class="message info">Une exonération remplace le taux d'une taxe pour une origine et/ou un préfixe de position (ex. origine UEMOA : droit de douane à 0 %).</div>
        <div class="table-defilante"><table>
          <tr><th>Préfixe position</th><th>Origine</th><th>Taxe</th><th class="num">Taux appliqué</th><th>Commentaire</th><th></th></tr>
          ${exos.map(x => `<tr><td>${esc(x.position_prefixe) || '<i>toutes</i>'}</td><td>${esc(x.origine) || '<i>toutes</i>'}</td><td>${esc(x.code_taxe)}</td>
            <td class="num">${fmt(x.taux_applique, 2)} %</td><td>${esc(x.commentaire || '')}</td>
            <td><button class="petit danger" onclick="supprimerExo(${x.id})">Supprimer</button></td></tr>`).join('') || '<tr><td colspan="6">Aucune exonération.</td></tr>'}
        </table></div>
        <div class="carte"><h3>Ajouter une exonération</h3>
          <div class="ligne-champs">
            <label class="champ">Préfixe de position<input id="e-prefixe" placeholder="ex. 1006"></label>
            <label class="champ">Origine (pays)<input id="e-origine" maxlength="2" style="width:70px" placeholder="CI"></label>
            <label class="champ">Taxe<select id="e-taxe">${taxes.map(t => `<option value="${esc(t.code)}">${esc(t.code)}</option>`).join('')}</select></label>
            <label class="champ">Taux appliqué (%)<input id="e-taux" type="number" step="0.01" value="0"></label>
            <label class="champ">Commentaire<input id="e-com" style="min-width:200px"></label>
            <button id="e-ajouter">Ajouter</button>
          </div><div id="e-msg"></div>
        </div>`;
      window.supprimerExo = async id => { await api('/douane/exonerations/' + id, { method: 'DELETE' }); afficher('exonerations'); };
      document.getElementById('e-ajouter').onclick = async () => {
        try {
          await api('/douane/exonerations', { method: 'POST', body: { position_prefixe: val('e-prefixe'), origine: val('e-origine'), code_taxe: val('e-taxe'), taux_applique: val('e-taux'), commentaire: val('e-com') } });
          afficher('exonerations');
        } catch (e) { message('e-msg', 'erreur', e.message); }
      };
    }
  }
  await afficher('simulateur');
}

/* ---------------------------------- Dossiers ---------------------------------- */
async function vueDossiers(page) {
  const [dossiers, fournisseurs] = await Promise.all([api('/dossiers'), api('/referentiels/fournisseurs')]);
  page.innerHTML = `
    <h1>Dossiers d'importation</h1>
    <p class="sous-titre">Objet central : de la commande à la clôture, toutes les pièces et tous les coûts s'y rattachent</p>
    <div class="carte">
      <h3>Nouveau dossier</h3>
      <div class="ligne-champs">
        <label class="champ">Référence *<input id="do-ref" placeholder="IMP-2026-001"></label>
        <label class="champ">Libellé<input id="do-libelle" style="min-width:220px"></label>
        <label class="champ">Fournisseur<select id="do-fourn"><option value="">-</option>${fournisseurs.map(f => `<option value="${esc(f.code)}">${esc(f.nom)}</option>`).join('')}</select></label>
        <label class="champ">Devise facture<input id="do-devise" value="XOF" style="width:80px"></label>
        <label class="champ">Taux de change → F CFA<input id="do-tc" type="number" step="0.0001" value="1"></label>
        <label class="champ">Incoterm<input id="do-incoterm" placeholder="FOB / CIF…" style="width:90px"></label>
        <label class="champ">Poids total BL (kg)<input id="do-poids" type="number" step="0.1"></label>
        <label class="champ">Volume total BL (m³)<input id="do-volume" type="number" step="0.01"></label>
        <button id="do-creer">Créer le dossier</button>
      </div>
      <div id="do-msg"></div>
    </div>
    <div class="table-defilante"><table>
      <tr><th>Référence</th><th>Libellé</th><th>Fournisseur</th><th>Statut</th><th class="num">Lignes</th><th class="num">Total facture (devise)</th><th>Créé le</th></tr>
      ${dossiers.map(d => `<tr class="cliquable" onclick="naviguer('#/dossier/${d.id}')">
        <td><a href="#/dossier/${d.id}"><b>${esc(d.reference)}</b></a></td><td>${esc(d.libelle || '')}</td><td>${esc(d.fournisseur_nom || '')}</td>
        <td>${badgeStatutDossier(d.statut)}</td><td class="num">${fmt(d.nb_lignes)}</td>
        <td class="num">${fmt(d.total_devise, 2)} ${esc(d.devise)}</td><td>${dateFr(d.date_creation)}</td></tr>`).join('') || '<tr><td colspan="7">Aucun dossier.</td></tr>'}
    </table></div>`;
  document.getElementById('do-creer').onclick = async () => {
    try {
      const r = await api('/dossiers', {
        method: 'POST',
        body: { reference: val('do-ref'), libelle: val('do-libelle'), fournisseur_code: val('do-fourn'), devise: val('do-devise'), taux_change: val('do-tc'), incoterm: val('do-incoterm'), poids_total: val('do-poids'), volume_total: val('do-volume') }
      });
      naviguer('#/dossier/' + r.id);
    } catch (e) { message('do-msg', 'erreur', e.message); }
  };
}

async function vueDossierDetail(page, args) {
  const id = args[0];
  const d = await api('/dossiers/' + id);
  const statuts = [['ouvert', 'Ouvert'], ['titres_obtenus', 'Titres obtenus'], ['embarque', 'Embarqué'], ['declare', 'Déclaré'], ['receptionne', 'Réceptionné'], ['cloture', 'Clôturé'], ['revise', 'Révisé']];
  page.innerHTML = `
    <h1>Dossier ${esc(d.reference)} ${badgeStatutDossier(d.statut)}</h1>
    <p class="sous-titre">${esc(d.libelle || '')} · ${esc(d.fournisseur_nom || 'fournisseur non renseigné')} · devise ${esc(d.devise)} (taux ${fmt(d.taux_change, 4)})
      ${d.poids_total ? ' · poids BL ' + fmt(d.poids_total) + ' kg' : ''}${d.volume_total ? ' · volume BL ' + fmt(d.volume_total, 2) + ' m³' : ''}</p>
    <div class="actions-page">
      <span class="petite-note">Faire avancer le statut :</span>
      ${statuts.map(([s, l]) => `<button class="petit ${d.statut === s ? '' : 'secondaire'}" onclick="changerStatut(${id},'${s}')">${l}</button>`).join('')}
    </div>
    <div id="dd-msg"></div>
    <div class="onglets">
      <button data-o="lignes" class="actif">Lignes de facture (${d.lignes.length})</button>
      <button data-o="couts">Coûts accessoires (${d.couts.length})</button>
      <button data-o="declaration">Déclaration en douane (${d.declaration.length})</button>
      <button data-o="pieces">Pièces (${d.pieces.length})</button>
      <button data-o="resultats">Coût de revient (${d.resultats.length})</button>
    </div>
    <div id="dd-contenu"></div>`;

  window.changerStatut = async (did, s) => {
    try { await api(`/dossiers/${did}/statut`, { method: 'POST', body: { statut: s } }); rendre(); }
    catch (e) { message('dd-msg', 'erreur', e.message); }
  };
  const onglets = page.querySelectorAll('.onglets button');
  onglets.forEach(b => b.onclick = () => { onglets.forEach(x => x.classList.remove('actif')); b.classList.add('actif'); afficher(b.dataset.o); });

  function afficher(o) {
    const c = document.getElementById('dd-contenu');
    if (o === 'lignes') {
      c.innerHTML = `
        <div class="table-defilante"><table>
          <tr><th class="num">Rang</th><th>Article</th><th>Code barres</th><th>Libellé</th><th class="num">Quantité</th><th class="num">Cartons</th>
          <th class="num">PU (${esc(d.devise)})</th><th class="num">Montant</th><th class="num">Poids (kg)</th><th class="num">Volume (m³)</th><th class="num">Décl. n°</th><th></th></tr>
          ${d.lignes.map(l => `<tr>
            <td class="num">${l.rang}</td>
            <td>${l.article_code ? esc(l.article_code) : '<span class="badge rouge">non apparié</span>'}</td>
            <td>${esc(l.code_barres || '')}</td><td>${esc(l.libelle || l.article_libelle || '')}</td>
            <td class="num">${fmt(l.quantite)}</td><td class="num">${fmt(l.nb_cartons)}</td>
            <td class="num">${fmt(l.prix_unitaire_devise, 2)}</td><td class="num">${fmt(l.montant_devise, 2)}</td>
            <td class="num">${l.poids_brut !== null ? fmt(l.poids_brut, 1) : '<span class="estime">estimé</span>'}</td>
            <td class="num">${l.volume !== null ? fmt(l.volume, 3) : '<span class="estime">estimé</span>'}</td>
            <td class="num">${l.declaration_rang ?? '<span class="badge rouge">-</span>'}</td>
            <td><button class="petit danger" onclick="supprLigne(${l.id})">✕</button></td>
          </tr>`).join('') || '<tr><td colspan="12">Aucune ligne. Importez la facture fournisseur ou saisissez les lignes.</td></tr>'}
        </table></div>
        <div class="carte">
          <h3>Ajouter une ligne</h3>
          <div class="ligne-champs">
            <label class="champ">Code barres ou code article<input id="l-code"></label>
            <label class="champ">Libellé<input id="l-libelle"></label>
            <label class="champ">Quantité<input id="l-qte" type="number"></label>
            <label class="champ">Cartons<input id="l-cartons" type="number"></label>
            <label class="champ">PU (${esc(d.devise)})<input id="l-pu" type="number" step="0.0001"></label>
            <label class="champ">Poids (kg)<input id="l-poids" type="number" step="0.1"></label>
            <label class="champ">Volume (m³)<input id="l-volume" type="number" step="0.001"></label>
            <label class="champ">Décl. n°<input id="l-decl" type="number" style="width:70px"></label>
            <button id="l-ajouter">Ajouter</button>
          </div>
        </div>
        <div class="carte">
          <h3>Importer la facture fournisseur · appariement automatique par code barres</h3>
          <div class="actions-page">
            <label><input type="checkbox" id="l-remplacer"> Remplacer les lignes existantes</label>
            <button class="secondaire" id="l-rattacher">Rattacher automatiquement à la déclaration</button>
          </div>
          <div id="l-assistant"></div>
          <div id="l-msg"></div>
        </div>`;
      monterAssistantImport({
        conteneur: document.getElementById('l-assistant'),
        type: 'facture',
        note: 'Facture fournisseur ou liste de colisage, quel que soit le format des colonnes.',
        envoyer: async csv => {
          const r = await api(`/dossiers/${id}/lignes-import/csv`, {
            method: 'POST', body: { contenu: csv, remplacer: coche('l-remplacer') }
          });
          setTimeout(rendre, 1600);
          return `${r.importees} ligne(s) importée(s), ${r.appariees} appariée(s) au référentiel, ${r.non_appariees} sans correspondance, ${r.rejets.length} rejet(s).`;
        }
      });
      window.supprLigne = async lid => { await api(`/dossiers/${id}/lignes/${lid}`, { method: 'DELETE' }); rendre(); };
      document.getElementById('l-ajouter').onclick = async () => {
        try {
          const code = val('l-code');
          await api(`/dossiers/${id}/lignes`, {
            method: 'POST',
            body: { code_barres: /^\d{8,13}$/.test(code) ? code : null, article_code: /^\d{8,13}$/.test(code) ? null : code || null, libelle: val('l-libelle'), quantite: val('l-qte'), nb_cartons: val('l-cartons'), prix_unitaire_devise: val('l-pu'), poids_brut: val('l-poids'), volume: val('l-volume'), declaration_rang: val('l-decl') }
          });
          rendre();
        } catch (e) { message('l-msg', 'erreur', e.message); }
      };
      document.getElementById('l-rattacher').onclick = async () => {
        const r = await api(`/dossiers/${id}/rattacher-auto`, { method: 'POST' });
        message('l-msg', 'ok', `${r.rattachees} ligne(s) rattachée(s) par position tarifaire.`);
        setTimeout(rendre, 1000);
      };
    } else if (o === 'couts') {
      const cles = [['valeur', 'Valeur'], ['poids', 'Poids'], ['volume', 'Volume'], ['unite_payante', 'Unité payante'], ['colis', 'Colis'], ['quantite', 'Quantité']];
      c.innerHTML = `
        <div class="message info">Chaque nature de coût porte sa propre clé de répartition, reflétant sa cause réelle (CDC §1.3). Le fret maritime doit être réparti à l'<b>unité payante</b>.</div>
        <div class="actions-page">
          <button class="secondaire" id="co-provisions">Proposer des provisions (barèmes appris des dossiers clôturés)</button>
        </div>
        <div id="co-prov-zone"></div>
        <div class="table-defilante"><table>
          <tr><th>Nature</th><th>Libellé</th><th class="num">Montant</th><th>Devise</th><th class="num">Taux</th><th>Clé de répartition</th><th>Capitalisable</th><th>Provision</th><th></th></tr>
          ${d.couts.map(x => `<tr><td>${esc(x.nature)}</td><td>${esc(x.libelle || '')}</td><td class="num">${fmt(x.montant, 2)}</td>
            <td>${esc(x.devise)}</td><td class="num">${fmt(x.taux_change, 4)}</td>
            <td><span class="badge bleu">${esc(x.cle_repartition)}</span></td>
            <td>${x.capitalisable ? '<span class="badge orange">coût du stock</span>' : '<span class="badge gris">charge de période</span>'}</td>
            <td>${x.provision ? 'oui' : ''}</td>
            <td><button class="petit danger" onclick="supprCout(${x.id})">✕</button></td></tr>`).join('') || '<tr><td colspan="9">Aucun coût accessoire saisi.</td></tr>'}
        </table></div>
        <div class="carte"><h3>Ajouter un coût</h3>
          <div class="ligne-champs">
            <label class="champ">Nature<select id="co-nature">
              <option value="fret">Fret principal</option><option value="assurance">Assurance</option>
              <option value="logistique_amont">Prestations logistiques amont</option>
              <option value="transitaire">Honoraires transitaire / manutention</option>
              <option value="transport_local">Transport port → entrepôt</option>
              <option value="surestaries">Surestaries / magasinage pénalisant</option>
              <option value="financier">Frais financiers</option><option value="autre">Autre</option></select></label>
            <label class="champ">Libellé<input id="co-libelle" style="min-width:200px"></label>
            <label class="champ">Montant<input id="co-montant" type="number" step="0.01"></label>
            <label class="champ">Devise<input id="co-devise" value="XOF" style="width:70px"></label>
            <label class="champ">Taux → F CFA<input id="co-tc" type="number" step="0.0001" value="1"></label>
            <label class="champ">Clé<select id="co-cle">${cles.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
            <label><input type="checkbox" id="co-cap" checked> Capitalisable</label>
            <label><input type="checkbox" id="co-prov"> Provision (barème)</label>
            <button id="co-ajouter">Ajouter</button>
          </div><div id="co-msg"></div>
          <p class="petite-note">Clés recommandées : fret → unité payante ; assurance, transitaire → valeur ; logistique amont → colis ; surestaries → non capitalisable.</p>
        </div>`;
      window.supprCout = async cid => { await api(`/dossiers/${id}/couts/${cid}`, { method: 'DELETE' }); rendre(); };
      document.getElementById('co-provisions').onclick = async () => {
        const propositions = await api(`/dossiers/${id}/provisions-proposees`);
        const zone = document.getElementById('co-prov-zone');
        if (!propositions.length) {
          zone.innerHTML = '<div class="message info">Aucune provision à proposer : soit toutes les natures habituelles sont déjà saisies, soit aucun dossier clôturé n\'a encore alimenté les barèmes.</div>';
          return;
        }
        zone.innerHTML = `
          <div class="carte"><h3>Provisions proposées</h3>
          <div class="table-defilante"><table>
            <tr><th>Nature</th><th>Barème</th><th class="num">Assiette</th><th class="num">Montant proposé</th><th>Appris sur</th></tr>
            ${propositions.map(p => `<tr><td>${esc(p.nature)}</td>
              <td>${fmt(p.valeur_bareme, 3)} ${p.mode === 'pct_valeur' ? '% de la valeur' : 'F par ' + esc(p.cle_repartition)}</td>
              <td class="num">${fmt(p.assiette, 2)}</td><td class="num"><b>${fcfa(p.montant_propose)}</b></td>
              <td class="petite-note">${p.nb_dossiers_appris} dossier(s), dernier : ${esc(p.dernier_dossier || '')}</td></tr>`).join('')}
          </table></div>
          <div class="actions-page"><button id="co-prov-appliquer">Appliquer ces provisions</button></div></div>`;
        document.getElementById('co-prov-appliquer').onclick = async () => {
          const r = await api(`/dossiers/${id}/provisions-appliquer`, { method: 'POST' });
          alert(`${r.creees} provision(s) ajoutée(s) au dossier. Elles seront extournées à la saisie des factures réelles.`);
          rendre();
        };
      };
      document.getElementById('co-ajouter').onclick = async () => {
        try {
          const nature = val('co-nature');
          await api(`/dossiers/${id}/couts`, {
            method: 'POST',
            body: { nature, libelle: val('co-libelle'), montant: val('co-montant'), devise: val('co-devise'), taux_change: val('co-tc'), cle_repartition: val('co-cle'), capitalisable: coche('co-cap'), provision: coche('co-prov') }
          });
          rendre();
        } catch (e) { message('co-msg', 'erreur', e.message); }
      };
    } else if (o === 'declaration') {
      c.innerHTML = `
        <div class="actions-page">
          <button id="de-liquider">Liquider (simulation)</button>
          <button class="secondaire" id="de-ecart" title="Mesure la qualité de la simulation face aux montants retenus (F-M2-05)">Écart simulé / réel</button>
          <span class="petite-note">La simulation reproduit le calcul de la Douane. Les montants réels saisis priment toujours.</span>
        </div>
        <div id="de-msg"></div>
        <div id="de-ecart-zone"></div>
        ${d.declaration.map(a => {
          const taxes = a.taxes || [];
          const totalCout = taxes.reduce((s, t) => s + Number(t.montant), 0);
          return `<div class="carte">
            <h3>Article n°${a.rang} · position ${esc(a.position_tarifaire)} ${a.origine ? '(origine ' + esc(a.origine) + ')' : ''}</h3>
            <p>${esc(a.designation || '')} · valeur CAF déclarée : <b>${fcfa(a.valeur_caf)}</b>${a.poids_brut ? ' · poids ' + fmt(a.poids_brut) + ' kg' : ''}</p>
            ${taxes.length ? `<div class="table-defilante"><table>
              <tr><th>Taxe</th><th class="num">Base</th><th class="num">Taux</th><th class="num">Montant</th><th>Source</th><th class="num">Montant réel</th></tr>
              ${taxes.map(t => `<tr><td>${esc(t.code_taxe)}</td><td class="num">${fcfa(t.base)}</td><td class="num">${fmt(t.taux, 2)} %</td>
                <td class="num">${fcfa(t.montant)}</td>
                <td>${t.origine_montant === 'reel' ? '<span class="badge vert">réel</span>' : '<span class="badge gris">simulé</span>'}</td>
                <td class="num"><input type="number" style="width:110px" id="reel-${a.id}-${esc(t.code_taxe)}" value="${t.origine_montant === 'reel' ? t.montant : ''}" placeholder="saisir"></td></tr>`).join('')}
              <tr><td><b>Total liquidé</b></td><td></td><td></td><td class="num"><b>${fcfa(totalCout)}</b></td><td></td><td class="num"><button class="petit" onclick="saisirReels(${a.id})">Enregistrer les montants réels</button></td></tr>
            </table></div>` : '<p class="petite-note">Aucune liquidation : cliquez sur « Liquider (simulation) » ou saisissez les montants réels.</p>'}
            <button class="petit danger" onclick="supprDecl(${a.id})">Supprimer l'article</button>
          </div>`;
        }).join('') || '<p class="petite-note">Aucun article de déclaration.</p>'}
        <div class="carte"><h3>Ajouter un article de déclaration</h3>
          <div class="ligne-champs">
            <label class="champ">Position tarifaire *<input id="de-pos" placeholder="10 chiffres"></label>
            <label class="champ">Désignation<input id="de-des" style="min-width:220px"></label>
            <label class="champ">Origine<input id="de-ori" maxlength="2" style="width:70px"></label>
            <label class="champ">Valeur CAF (F CFA)<input id="de-caf" type="number"></label>
            <label class="champ">Poids brut (kg)<input id="de-poids" type="number" step="0.1"></label>
            <button id="de-ajouter">Ajouter</button>
          </div>
        </div>
        <div class="carte"><h3>Importer la déclaration (CSV)</h3>
          <p class="petite-note">Colonnes : rang;position_tarifaire;designation;origine;valeur_caf;poids_brut</p>
          <textarea id="de-csv"></textarea>
          <div class="actions-page"><button id="de-importer">Importer</button></div>
        </div>`;
      window.supprDecl = async daId => { await api(`/dossiers/${id}/declaration/${daId}`, { method: 'DELETE' }); rendre(); };
      window.saisirReels = async daId => {
        const inputs = document.querySelectorAll(`[id^="reel-${daId}-"]`);
        const taxes = [];
        inputs.forEach(i => {
          const codeTaxe = i.id.split('-').slice(2).join('-');
          if (i.value !== '') taxes.push({ code_taxe: codeTaxe, montant: i.value });
        });
        if (!taxes.length) { message('de-msg', 'erreur', 'Aucun montant réel saisi.'); return; }
        await api(`/dossiers/${id}/declaration/${daId}/taxes-reelles`, { method: 'POST', body: { taxes } });
        message('de-msg', 'ok', 'Montants réels enregistrés : ils priment désormais sur la simulation.');
        setTimeout(rendre, 900);
      };
      document.getElementById('de-ecart').onclick = async () => {
        const ecarts = await api(`/dossiers/${id}/ecart-liquidation`);
        document.getElementById('de-ecart-zone').innerHTML = `
          <div class="carte"><h3>Écart entre liquidation simulée et montants retenus (F-M2-05)</h3>
          <div class="table-defilante"><table>
            <tr><th>Décl.</th><th>Position</th><th class="num">Total simulé</th><th class="num">Total retenu</th><th class="num">Écart</th><th class="num">Écart %</th></tr>
            ${ecarts.map(x => `<tr><td>n°${x.rang}</td><td>${esc(x.position_tarifaire)}</td>
              <td class="num">${fcfa(x.total_simule)}</td><td class="num">${fcfa(x.total_retenu)}</td>
              <td class="num">${fcfa(x.ecart_total)}</td>
              <td class="num"><span class="badge ${Math.abs(x.ecart_pct || 0) > 3 ? 'rouge' : 'vert'}">${x.ecart_pct !== null ? fmt(x.ecart_pct, 1) + ' %' : '-'}</span></td></tr>`).join('') || '<tr><td colspan="6">Aucun article de déclaration.</td></tr>'}
          </table></div>
          <p class="petite-note">Un écart durable signale un barème de taux à mettre à jour ou une divergence de classement tarifaire (F-M2-09).</p></div>`;
      };
      document.getElementById('de-liquider').onclick = async () => {
        try {
          const r = await api(`/dossiers/${id}/liquider`, { method: 'POST' });
          message('de-msg', 'ok', `${r.articles_liquides} article(s) liquidé(s) par simulation.`);
          setTimeout(rendre, 900);
        } catch (e) { message('de-msg', 'erreur', e.message); }
      };
      document.getElementById('de-ajouter').onclick = async () => {
        try {
          await api(`/dossiers/${id}/declaration`, { method: 'POST', body: { position_tarifaire: val('de-pos'), designation: val('de-des'), origine: val('de-ori'), valeur_caf: val('de-caf'), poids_brut: val('de-poids') } });
          rendre();
        } catch (e) { message('de-msg', 'erreur', e.message); }
      };
      document.getElementById('de-importer').onclick = async () => {
        try {
          const r = await api(`/dossiers/${id}/declaration-import/csv`, { method: 'POST', body: { contenu: val('de-csv') } });
          message('de-msg', 'ok', `${r.importes} article(s) importé(s), ${r.rejets.length} rejet(s).`);
          setTimeout(rendre, 1000);
        } catch (e) { message('de-msg', 'erreur', e.message); }
      };
    } else if (o === 'pieces') {
      const types = ['Bon de commande', 'Facture fournisseur', 'Liste de colisage', 'Titres préalables', 'Connaissement', 'Facture de fret', 'Facture prestation logistique', "Note de prime d'assurance", 'Déclaration en douane', 'Quittance de liquidation', 'Facture du transitaire local', 'Procès-verbal de réception'];
      c.innerHTML = `
        <div class="table-defilante"><table>
          <tr><th>Type de pièce</th><th>Référence</th><th>Date</th><th class="num">Montant</th><th>Devise</th><th>Commentaire</th><th></th></tr>
          ${d.pieces.map(p => `<tr><td>${esc(p.type_piece)}</td><td>${esc(p.reference || '')}</td><td>${dateFr(p.date_piece)}</td>
            <td class="num">${fmt(p.montant, 2)}</td><td>${esc(p.devise || '')}</td><td>${esc(p.commentaire || '')}</td>
            <td style="white-space:nowrap">
              ${p.a_fichier ? `<button class="petit secondaire" onclick="telechargerPiece(${p.id})">📄 Télécharger</button>` : `<button class="petit secondaire" onclick="televerserPiece(${p.id})">⬆ Document</button>`}
              <button class="petit danger" onclick="supprPiece(${p.id})">✕</button>
            </td></tr>`).join('') || '<tr><td colspan="7">Aucune pièce rattachée.</td></tr>'}
        </table></div>
        <div class="carte"><h3>Rattacher une pièce</h3>
          <div class="ligne-champs">
            <label class="champ">Type<select id="pi-type">${types.map(t => `<option>${t}</option>`).join('')}</select></label>
            <label class="champ">Référence<input id="pi-ref"></label>
            <label class="champ">Date<input id="pi-date" type="date"></label>
            <label class="champ">Montant<input id="pi-montant" type="number" step="0.01"></label>
            <label class="champ">Devise<input id="pi-devise" value="XOF" style="width:70px"></label>
            <label class="champ">Commentaire<input id="pi-com" style="min-width:200px"></label>
            <button id="pi-ajouter">Rattacher</button>
          </div>
        </div>`;
      window.supprPiece = async pid => { await api(`/dossiers/${id}/pieces/${pid}`, { method: 'DELETE' }); rendre(); };
      // Téléversement du document numérisé de la pièce (F-M4-02)
      window.televerserPiece = pid => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf,.jpg,.jpeg,.png,.webp';
        input.onchange = async () => {
          const fichier = input.files[0];
          if (!fichier) return;
          if (fichier.size > 8 * 1024 * 1024) { alert('Fichier trop volumineux (8 Mo maximum).'); return; }
          const rep = await fetch(`/api/dossiers/${id}/pieces/${pid}/fichier`, {
            method: 'PUT',
            headers: {
              Authorization: 'Bearer ' + etat.token,
              'Content-Type': fichier.type || 'application/octet-stream',
              'X-Nom-Fichier': encodeURIComponent(fichier.name)
            },
            body: fichier
          });
          if (rep.ok) rendre();
          else alert('Échec du téléversement : ' + ((await rep.json().catch(() => ({}))).erreur || rep.status));
        };
        input.click();
      };
      window.telechargerPiece = pid => telecharger(`/dossiers/${id}/pieces/${pid}/fichier`, 'document');
      document.getElementById('pi-ajouter').onclick = async () => {
        await api(`/dossiers/${id}/pieces`, { method: 'POST', body: { type_piece: val('pi-type'), reference: val('pi-ref'), date_piece: val('pi-date') || null, montant: val('pi-montant'), devise: val('pi-devise'), commentaire: val('pi-com') } });
        rendre();
      };
    } else if (o === 'resultats') {
      c.innerHTML = `
        <div class="actions-page">
          <button id="r-calculer">Calculer le coût de revient débarqué</button>
          <button class="secondaire" id="r-reviser" title="Après ajout d'une facture tardive : recalcule et ventile l'ajustement entre stock restant et quantités vendues">Réviser (facture tardive)</button>
          <button class="secondaire" id="r-cles" title="Mesure l'enjeu des clés multiples face au traitement usuel des ERP">Clé unique vs clés multiples</button>
          <button class="secondaire" id="r-variation">Simuler une variation</button>
          <button class="secondaire" id="r-export">Exporter les coûts (CSV)</button>
          <button class="secondaire" id="r-ecritures">Écritures comptables (CSV)</button>
        </div>
        <div id="r-msg"></div>
        <div id="r-outils"></div>
        <div id="r-tableau">${tableauResultats(d.resultats)}</div>`;
      document.getElementById('r-cles').onclick = async () => {
        try {
          const r = await api(`/dossiers/${id}/comparaison-cles`);
          document.getElementById('r-outils').innerHTML = `
            <div class="carte"><h3>Enjeu des clés multiples (F-M5-11)</h3>
            <div class="message ${r.ecart_max_pct > 3 ? 'erreur' : 'info'}">${esc(r.enjeu)}</div>
            <div class="table-defilante"><table>
              <tr><th>Article</th><th class="num">Unitaire clés multiples</th><th class="num">Unitaire clé unique (valeur)</th><th class="num">Écart</th></tr>
              ${r.lignes.map(l => `<tr><td>${esc(l.article_code || l.libelle || '')}</td>
                <td class="num"><b>${fmt(l.cout_unitaire_cles_multiples, 2)}</b></td>
                <td class="num">${fmt(l.cout_unitaire_cle_unique, 2)}</td>
                <td class="num"><span class="badge ${Math.abs(l.ecart_pct) > 3 ? 'rouge' : 'gris'}">${l.ecart_pct > 0 ? '+' : ''}${fmt(l.ecart_pct, 1)} %</span></td></tr>`).join('')}
            </table></div></div>`;
        } catch (e) { message('r-msg', 'erreur', e.message); }
      };
      document.getElementById('r-variation').onclick = () => {
        document.getElementById('r-outils').innerHTML = `
          <div class="carte"><h3>Simulation d'une variation (F-M5-12)</h3>
          <div class="ligne-champs">
            <label class="champ">Fret (± %)<input id="sv-fret" type="number" step="1" value="10" style="width:80px"></label>
            <label class="champ">Cours de change (± %)<input id="sv-change" type="number" step="1" value="0" style="width:80px"></label>
            <label class="champ">Droits et taxes (± %)<input id="sv-droits" type="number" step="1" value="0" style="width:80px"></label>
            <button id="sv-lancer">Simuler</button>
          </div><div id="sv-resultat"></div></div>`;
        document.getElementById('sv-lancer').onclick = async () => {
          try {
            const r = await api(`/dossiers/${id}/simulation-variation`, {
              method: 'POST',
              body: { fret_pct: val('sv-fret'), change_pct: val('sv-change'), droits_pct: val('sv-droits') }
            });
            document.getElementById('sv-resultat').innerHTML = `
              <div class="table-defilante"><table>
                <tr><th>Article</th><th class="num">Coût unitaire actuel</th><th class="num">Coût simulé</th><th class="num">Variation</th></tr>
                ${r.lignes.map(l => `<tr><td>${esc(l.article_code || '')}</td>
                  <td class="num">${fmt(l.cout_unitaire_actuel, 2)}</td>
                  <td class="num"><b>${fmt(l.cout_unitaire_simule, 2)}</b></td>
                  <td class="num"><span class="badge ${l.variation_pct > 0 ? 'rouge' : 'vert'}">${l.variation_pct > 0 ? '+' : ''}${fmt(l.variation_pct, 1)} %</span></td></tr>`).join('')}
              </table></div>`;
          } catch (e) { message('r-msg', 'erreur', e.message); }
        };
      };
      document.getElementById('r-reviser').onclick = async () => {
        if (!d.resultats.length) { message('r-msg', 'erreur', 'Aucun calcul précédent : utilisez « Calculer » d\'abord.'); return; }
        try {
          const r = await api(`/dossiers/${id}/reviser`, { method: 'POST', body: {} });
          if (!r.revisions.length) {
            message('r-msg', 'info', 'Aucun écart de coût : rien à réviser.');
          } else {
            document.getElementById('r-msg').innerHTML = `
              <div class="message ok">${r.revisions.length} référence(s) révisée(s).</div>
              <div class="table-defilante"><table>
                <tr><th>Article</th><th class="num">Coût avant</th><th class="num">Coût après</th><th class="num">Écart unitaire</th><th class="num">Ajust. stock</th><th class="num">Ajust. charge</th></tr>
                ${r.revisions.map(x => `<tr><td>${esc(x.article_code || '-')}</td>
                  <td class="num">${fmt(x.cout_unitaire_avant, 2)}</td><td class="num">${fmt(x.cout_unitaire_apres, 2)}</td>
                  <td class="num"><span class="badge ${x.delta_unitaire > 0 ? 'rouge' : 'vert'}">${x.delta_unitaire > 0 ? '+' : ''}${fmt(x.delta_unitaire, 2)}</span></td>
                  <td class="num">${fcfa(x.ajustement_stock)}</td><td class="num">${fcfa(x.ajustement_charge)}</td></tr>`).join('')}
              </table></div>
              ${r.alertes_prix.length ? `<div class="message erreur"><b>${r.alertes_prix.length} tarif(s) publié(s) passent sous le plancher de marge</b> · la direction a été notifiée :<br>${r.alertes_prix.map(a => `${esc(a.article_code)} (${esc(a.format_code)}) : taux de marque ${fmt(a.taux_marque_apres_revision, 1)} %`).join('<br>')}</div>` : ''}`;
            const dd = await api('/dossiers/' + id);
            document.getElementById('r-tableau').innerHTML = tableauResultats(dd.resultats);
          }
        } catch (e) { message('r-msg', 'erreur', e.message); }
      };
      document.getElementById('r-calculer').onclick = async () => {
        try {
          const r = await api(`/dossiers/${id}/calculer`, { method: 'POST' });
          let html = `<div class="message ok">Calcul effectué. Coefficient moyen : <b>${fmt(r.totaux.coefficient_moyen, 3)}</b> · coût total ${fcfa(r.totaux.cout_total)} pour ${fcfa(r.totaux.valeur_achat)} d'achats. Créances sur l'État : ${fcfa(r.totaux.taxes_creance)}. ${r.articles_enrichis} fiche(s) article enrichie(s).</div>`;
          if (r.alertes.length) html += `<div class="message erreur"><b>Alertes :</b><br>${r.alertes.map(esc).join('<br>')}</div>`;
          if (r.charges_periode.length) html += `<div class="message info">Charges de période (non capitalisées) : ${r.charges_periode.map(x => esc(x.libelle || x.nature) + ' ' + fcfa(x.montant)).join(', ')}</div>`;
          document.getElementById('r-msg').innerHTML = html;
          const dd = await api('/dossiers/' + id);
          document.getElementById('r-tableau').innerHTML = tableauResultats(dd.resultats);
        } catch (e) { message('r-msg', 'erreur', e.message); }
      };
      document.getElementById('r-export').onclick = () => telecharger(`/dossiers/${id}/resultats-export/csv`, `cout_revient_${d.reference}.csv`);
      document.getElementById('r-ecritures').onclick = () => telecharger(`/dossiers/${id}/ecritures?format=csv`, `ecritures_${d.reference}.csv`);
    }
  }

  function tableauResultats(resultats) {
    if (!resultats.length) return '<p class="petite-note">Aucun calcul enregistré. Vérifiez les lignes, les coûts et la déclaration puis lancez le calcul.</p>';
    return `<div class="table-defilante"><table>
      <tr><th>Article</th><th class="num">Quantité</th><th class="num">Achat total</th><th class="num">Coût total</th>
      <th class="num">Coût unitaire</th><th class="num">Coefficient</th><th class="num">Taux effectif</th><th class="num">UP</th><th>Indicateur</th><th>Détail</th></tr>
      ${resultats.map(x => {
        const det = x.detail || {};
        return `<tr>
          <td>${esc(x.article_code || '-')}</td><td class="num">${fmt(x.quantite)}</td>
          <td class="num">${fcfa(x.prix_achat_total)}</td><td class="num">${fcfa(x.cout_total)}</td>
          <td class="num"><b>${fmt(x.cout_unitaire, 2)}</b></td>
          <td class="num">${fmt(x.coefficient, 3)}</td>
          <td class="num">${x.taux_effectif !== null ? fmt(x.taux_effectif, 1) + ' %' : '-'}</td>
          <td class="num">${fmt(x.unite_payante, 3)}</td>
          <td>${x.indicateur_up ? `<span class="badge ${x.indicateur_up === 'poids' ? 'bleu' : 'orange'}">${x.indicateur_up}</span>` : ''}${det.volume_estime ? ' <span class="estime">vol. estimé</span>' : ''}</td>
          <td><details><summary>composantes</summary><ul>
            ${(det.composantes || []).map(co => `<li>${esc(co.libelle)} : ${fcfa(co.montant)}${co.cle ? ' <code>' + esc(co.cle) + '</code>' : ''}${co.estime ? ' <span class="estime">(assiette estimée)</span>' : ''}</li>`).join('')}
            <li>TVA et acomptes en créance : ${fcfa(det.taxes_creance)}</li></ul></details></td>
        </tr>`;
      }).join('')}
    </table></div>`;
  }
  afficher('lignes');
}

/* ---------------------------------- Tarification ---------------------------------- */
async function vueTarification(page) {
  page.innerHTML = `
    <h1>Tarification</h1>
    <p class="sous-titre">Politique multi-formats, moteur de prix et circuit de publication</p>
    <div class="onglets">
      <button data-o="proposer" class="actif">Proposer des prix</button>
      <button data-o="tarifs">Tarifs &amp; validation</button>
      <button data-o="promotions">Promotions</button>
      <button data-o="controles">Contrôles de cohérence</button>
      <button data-o="politiques">Politiques</button>
      <button data-o="formats">Formats de magasin</button>
    </div>
    <div id="t-contenu"></div>`;
  const onglets = page.querySelectorAll('.onglets button');
  onglets.forEach(b => b.onclick = () => { onglets.forEach(x => x.classList.remove('actif')); b.classList.add('actif'); afficher(b.dataset.o); });

  async function afficher(o) {
    const c = document.getElementById('t-contenu');
    if (o === 'formats') {
      const formats = await api('/tarification/formats');
      c.innerHTML = `
        <div class="table-defilante"><table>
          <tr><th>Code</th><th>Libellé</th><th>Logistique aval</th><th class="num">Démarque</th><th class="num">Financement</th><th class="num">Rotation (j)</th><th>Arrondi</th></tr>
          ${formats.map(f => `<tr><td><b>${esc(f.code)}</b></td><td>${esc(f.libelle)}</td>
            <td>${fmt(f.logistique_aval_valeur, 2)} (${esc(f.logistique_aval_mode)})</td>
            <td class="num">${fmt(f.demarque_taux, 1)} %</td><td class="num">${fmt(f.taux_financement, 1)} %</td>
            <td class="num">${fmt(f.rotation_jours)}</td><td>${esc(f.arrondi_regle)} / pas ${fmt(f.arrondi_pas)}${f.terminaison ? ' / term. ' + esc(f.terminaison) : ''}</td></tr>`).join('')}
        </table></div>
        <div class="carte"><h3>Ajouter / modifier un format</h3>
          <div class="ligne-champs">
            <label class="champ">Code<input id="f-code"></label>
            <label class="champ">Libellé<input id="f-libelle"></label>
            <label class="champ">Mode logistique aval<select id="f-mode">
              <option value="pct_valeur">% du coût</option><option value="par_kg">F par kg</option>
              <option value="par_colis">F par carton</option><option value="par_m3">F par m³</option></select></label>
            <label class="champ">Valeur<input id="f-valeur" type="number" step="0.01"></label>
            <label class="champ">Démarque (%)<input id="f-demarque" type="number" step="0.1"></label>
            <label class="champ">Financement (%/an)<input id="f-financement" type="number" step="0.1"></label>
            <label class="champ">Rotation (jours)<input id="f-rotation" type="number"></label>
            <label class="champ">Arrondi<select id="f-arrondi"><option value="plus_proche">Au plus proche</option><option value="superieur">Supérieur</option><option value="inferieur">Inférieur</option><option value="aucun">Aucun</option></select></label>
            <label class="champ">Pas<input id="f-pas" type="number" value="25"></label>
            <label class="champ">Terminaison<input id="f-terminaison" placeholder="ex. 95" style="width:70px"></label>
            <button id="f-ajouter">Enregistrer</button>
          </div><div id="f-msg"></div>
        </div>`;
      document.getElementById('f-ajouter').onclick = async () => {
        try {
          await api('/tarification/formats', { method: 'POST', body: { code: val('f-code'), libelle: val('f-libelle'), logistique_aval_mode: val('f-mode'), logistique_aval_valeur: val('f-valeur'), demarque_taux: val('f-demarque'), taux_financement: val('f-financement'), rotation_jours: val('f-rotation'), arrondi_regle: val('f-arrondi'), arrondi_pas: val('f-pas'), terminaison: val('f-terminaison') } });
          afficher('formats');
        } catch (e) { message('f-msg', 'erreur', e.message); }
      };
    } else if (o === 'politiques') {
      const [pols, familles, formats] = await Promise.all([api('/tarification/politiques'), api('/referentiels/familles'), api('/tarification/formats')]);
      c.innerHTML = `
        <div class="message info">Résolution : le niveau le plus fin l'emporte · article &gt; famille+format &gt; famille &gt; format &gt; défaut (20 %).</div>
        <div class="table-defilante"><table>
          <tr><th>Famille</th><th>Format</th><th class="num">Taux de marque cible</th><th class="num">Plancher</th><th>Mode d'arbitrage</th><th class="num">Indice cible</th><th class="num">Encadrement</th><th></th></tr>
          ${pols.map(p => `<tr><td>${esc(p.famille_code || 'toutes')}</td><td>${esc(p.format_code || 'tous')}</td>
            <td class="num">${fmt(p.taux_marque_cible, 1)} %</td><td class="num">${fmt(p.taux_marque_plancher, 1)} %</td>
            <td><span class="badge bleu">${esc(p.mode_arbitrage)}</span></td>
            <td class="num">${p.indice_cible ? fmt(p.indice_cible, 1) : '-'}</td>
            <td class="num">${p.encadrement_pct ? '±' + fmt(p.encadrement_pct, 1) + ' %' : '-'}</td>
            <td><button class="petit danger" onclick="supprPol(${p.id})">✕</button></td></tr>`).join('') || '<tr><td colspan="8">Aucune politique : le défaut (marge 20 %) s\'applique.</td></tr>'}
        </table></div>
        <div class="carte"><h3>Ajouter / modifier une politique</h3>
          <div class="ligne-champs">
            <label class="champ">Famille<select id="po-famille"><option value="">toutes</option>${familles.map(f => `<option value="${esc(f.code)}">${esc(f.code)}</option>`).join('')}</select></label>
            <label class="champ">Format<select id="po-format"><option value="">tous</option>${formats.map(f => `<option value="${esc(f.code)}">${esc(f.code)}</option>`).join('')}</select></label>
            <label class="champ">Taux de marque cible (%)<input id="po-cible" type="number" step="0.1" value="20"></label>
            <label class="champ">Plancher (%)<input id="po-plancher" type="number" step="0.1" value="5"></label>
            <label class="champ">Mode<select id="po-mode">
              <option value="marge">Marge prioritaire</option><option value="marche">Marché prioritaire</option>
              <option value="encadre">Encadré</option><option value="alignement">Alignement strict</option>
              <option value="manuel">Manuel</option></select></label>
            <label class="champ">Indice cible (%)<input id="po-indice" type="number" step="0.1" placeholder="100"></label>
            <label class="champ">Encadrement (± %)<input id="po-encadrement" type="number" step="0.1" placeholder="5"></label>
            <button id="po-ajouter">Enregistrer</button>
          </div><div id="po-msg"></div>
        </div>`;
      window.supprPol = async pid => { await api('/tarification/politiques/' + pid, { method: 'DELETE' }); afficher('politiques'); };
      document.getElementById('po-ajouter').onclick = async () => {
        try {
          await api('/tarification/politiques', { method: 'POST', body: { famille_code: val('po-famille'), format_code: val('po-format'), taux_marque_cible: val('po-cible'), taux_marque_plancher: val('po-plancher'), mode_arbitrage: val('po-mode'), indice_cible: val('po-indice'), encadrement_pct: val('po-encadrement') } });
          afficher('politiques');
        } catch (e) { message('po-msg', 'erreur', e.message); }
      };
    } else if (o === 'proposer') {
      const [familles, formats] = await Promise.all([api('/referentiels/familles'), api('/tarification/formats')]);
      c.innerHTML = `
        <div class="carte">
          <h3>Générer des propositions <span class="petite-note">- coût de mise en rayon → marge cible → confrontation au marché</span></h3>
          <div class="ligne-champs">
            <label class="champ">Article (code, vide = tous)<input id="pr-article"></label>
            <label class="champ">Famille<select id="pr-famille"><option value="">toutes</option>${familles.map(f => `<option value="${esc(f.code)}">${esc(f.code)}</option>`).join('')}</select></label>
            <label class="champ">Formats<select id="pr-format"><option value="">tous</option>${formats.map(f => `<option value="${esc(f.code)}">${esc(f.code)}</option>`).join('')}</select></label>
            <button id="pr-lancer">Calculer les propositions</button>
          </div>
          <div id="pr-msg"></div>
        </div>
        <div id="pr-resultats"></div>`;
      document.getElementById('pr-lancer').onclick = async () => {
        try {
          message('pr-msg', 'info', 'Calcul en cours…');
          const body = {};
          if (val('pr-article')) body.article_code = val('pr-article');
          if (val('pr-famille')) body.famille_code = val('pr-famille');
          if (val('pr-format')) body.format_codes = [val('pr-format')];
          const r = await api('/tarification/proposer', { method: 'POST', body });
          window._propositions = r.propositions;
          document.getElementById('pr-msg').innerHTML = r.ignores_sans_cout ? `<div class="message info">${r.ignores_sans_cout} proposition(s) ignorée(s) : articles sans coût de revient calculé.</div>` : '';
          document.getElementById('pr-resultats').innerHTML = `
            <div class="actions-page"><button id="pr-enregistrer">Enregistrer les propositions cochées</button></div>
            <div class="table-defilante"><table>
              <tr><th><input type="checkbox" id="pr-tout" checked></th><th>Article</th><th>Format</th><th class="num">Coût débarqué</th>
              <th class="num">Coût mise en rayon</th><th class="num">Prix théorique</th><th class="num">Prix marché</th>
              <th class="num">Prix proposé TTC</th><th class="num">Taux de marque</th><th class="num">Indice</th><th>Contrainte</th><th>Alertes</th></tr>
              ${r.propositions.map((p, i) => `<tr>
                <td><input type="checkbox" class="pr-coche" data-i="${i}" checked></td>
                <td>${esc(p.article_code)}<br><span class="petite-note">${esc(p.libelle)}</span></td>
                <td>${esc(p.format_code)}</td>
                <td class="num">${fmt(p.cout_debarque, 1)}</td><td class="num">${fmt(p.cout_mise_en_rayon, 1)}</td>
                <td class="num">${fcfa(p.prix_ttc_theorique)}</td>
                <td class="num">${p.prix_marche ? fcfa(p.prix_marche) : '-'}</td>
                <td class="num"><b>${fcfa(p.prix_ttc_propose)}</b></td>
                <td class="num">${p.taux_marque !== null ? fmt(p.taux_marque, 1) + ' %' : '-'}</td>
                <td class="num">${p.indice_vs_marche ? fmt(p.indice_vs_marche, 1) : '-'}</td>
                <td><span class="badge ${p.contrainte === 'marge' ? 'bleu' : p.contrainte === 'marche' ? 'orange' : 'rouge'}">${esc(p.contrainte)}</span></td>
                <td>${p.alertes.map(a => `<span class="badge rouge">${esc(a)}</span>`).join(' ')}</td>
              </tr>`).join('') || '<tr><td colspan="12">Aucune proposition.</td></tr>'}
            </table></div>`;
          document.getElementById('pr-tout').onchange = e => document.querySelectorAll('.pr-coche').forEach(x => x.checked = e.target.checked);
          document.getElementById('pr-enregistrer').onclick = async () => {
            const choisis = [...document.querySelectorAll('.pr-coche:checked')].map(x => window._propositions[Number(x.dataset.i)]);
            if (!choisis.length) return;
            const rr = await api('/tarification/tarifs', {
              method: 'POST',
              body: { tarifs: choisis.map(p => ({ article_code: p.article_code, format_code: p.format_code, prix_ttc: p.prix_ttc_propose, cout_mise_en_rayon: p.cout_mise_en_rayon, taux_marque: p.taux_marque, contrainte: p.contrainte, alertes: p.alertes })) }
            });
            message('pr-msg', 'ok', `${rr.crees} proposition(s) enregistrée(s) · à valider dans l'onglet « Tarifs & validation ».`);
          };
        } catch (e) { message('pr-msg', 'erreur', e.message); }
      };
    } else if (o === 'tarifs') {
      const [tarifs, regle] = await Promise.all([api('/tarification/tarifs'), api('/tarification/regles-validation')]);
      const badge = s => ({ propose: 'bleu', a_valider: 'rouge', valide: 'orange', publie: 'vert', refuse: 'rouge', annule: 'gris', remplace: 'gris' }[s] || 'gris');
      const estDirection = etat.utilisateur.role === 'admin' || etat.utilisateur.role === 'direction';
      c.innerHTML = `
        <div class="carte">
          <h3>Règle de validation par seuils <span class="petite-note">- au-delà, la proposition passe en « a_valider » et exige la direction</span></h3>
          <div class="ligne-champs">
            <label class="champ">Taux de marque minimal (%)<input id="rg-marque" type="number" step="0.1" value="${regle && regle.taux_marque_min !== null ? esc(regle.taux_marque_min) : ''}"></label>
            <label class="champ">Écart max avec le tarif publié (%)<input id="rg-ecart" type="number" step="0.1" value="${regle && regle.ecart_prix_max_pct !== null ? esc(regle.ecart_prix_max_pct) : ''}"></label>
            <button id="rg-enregistrer" ${estDirection ? '' : 'disabled title="Rôle direction requis"'}>Enregistrer la règle</button>
          </div>
          <div id="rg-msg"></div>
        </div>
        <div class="actions-page">
          <button id="ta-publier" ${estDirection ? '' : 'disabled title="Rôle direction requis"'}>Publier la sélection</button>
          <button class="secondaire" id="ta-export">Exporter les tarifs publiés (CSV → ERP/caisse)</button>
          <button class="secondaire" id="ta-etiquettes" title="Étiquettes de rayon imprimables pour les tarifs publiés (F-M8-08)">🏷 Imprimer les étiquettes</button>
        </div>
        <div id="ta-msg"></div>
        <div class="table-defilante"><table>
          <tr><th></th><th>Article</th><th>Format</th><th class="num">Prix TTC</th><th class="num">Prix HT</th><th class="num">Taux de marque</th>
          <th>Contrainte</th><th>Statut</th><th>Date d'effet</th><th>Alerte</th><th>Auteur</th></tr>
          ${tarifs.map(t => `<tr>
            <td>${['propose', 'valide'].includes(t.statut) ? `<input type="checkbox" class="ta-coche" value="${t.id}">` : ''}</td>
            <td>${esc(t.article_code)}<br><span class="petite-note">${esc(t.article_libelle)}</span></td>
            <td>${esc(t.format_code)}</td><td class="num"><b>${fcfa(t.prix_ttc)}</b></td><td class="num">${fmt(t.prix_ht, 1)}</td>
            <td class="num">${t.taux_marque !== null ? fmt(t.taux_marque, 1) + ' %' : '-'}</td>
            <td>${t.contrainte ? `<span class="badge gris">${esc(t.contrainte)}</span>` : ''}</td>
            <td><span class="badge ${badge(t.statut)}">${esc(t.statut)}</span>
              ${t.statut === 'a_valider' && estDirection ? `<button class="petit" onclick="validerTarif(${t.id})">Valider</button>` : ''}</td>
            <td>${dateFr(t.date_effet)}</td>
            <td>${t.alerte ? `<span class="badge rouge" title="${esc(t.alerte)}">⚠</span>` : ''}</td>
            <td class="petite-note">${esc(t.auteur || '')}</td>
          </tr>`).join('') || '<tr><td colspan="11">Aucun tarif.</td></tr>'}
        </table></div>`;
      window.validerTarif = async tid => {
        await api(`/tarification/tarifs/${tid}/statut`, { method: 'POST', body: { statut: 'valide' } });
        afficher('tarifs');
      };
      document.getElementById('rg-enregistrer').onclick = async () => {
        try {
          await api('/tarification/regles-validation', { method: 'POST', body: { taux_marque_min: val('rg-marque'), ecart_prix_max_pct: val('rg-ecart') } });
          message('rg-msg', 'ok', 'Règle enregistrée : elle s\'applique aux prochaines propositions.');
        } catch (e) { message('rg-msg', 'erreur', e.message); }
      };
      document.getElementById('ta-export').onclick = () => telecharger('/tarification/tarifs-export/csv', 'tarifs_publies.csv');
      // Étiquettes de rayon (F-M8-08) : page imprimable générée côté client
      document.getElementById('ta-etiquettes').onclick = async () => {
        const publies = tarifs.filter(t => t.statut === 'publie');
        if (!publies.length) { message('ta-msg', 'erreur', 'Aucun tarif publié à imprimer.'); return; }
        const fen = window.open('', '_blank');
        fen.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Étiquettes de rayon</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 8mm; }
            .grille { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
            .etiquette { border: 1px solid #333; border-radius: 2mm; padding: 3mm; page-break-inside: avoid; }
            .libelle { font-size: 11px; min-height: 26px; font-weight: bold; }
            .prix { font-size: 26px; font-weight: 900; text-align: right; }
            .prix small { font-size: 11px; font-weight: normal; }
            .pied { display: flex; justify-content: space-between; font-size: 9px; color: #444; margin-top: 1mm; }
            @media print { .noprint { display: none; } }
          </style></head><body>
          <p class="noprint"><button onclick="window.print()">Imprimer</button> ${publies.length} étiquette(s) · format ${new Date().toLocaleDateString('fr-FR')}</p>
          <div class="grille">
          ${publies.map(t => `<div class="etiquette">
            <div class="libelle">${esc(t.article_libelle)}</div>
            <div class="prix">${fmt(t.prix_ttc)} <small>F CFA<br>TTC</small></div>
            <div class="pied"><span>${esc(t.article_code)} · ${esc(t.format_code)}</span><span>${esc(t.code_barres || '')}</span></div>
          </div>`).join('')}
          </div></body></html>`);
        fen.document.close();
      };
      document.getElementById('ta-publier').onclick = async () => {
        const ids = [...document.querySelectorAll('.ta-coche:checked')].map(x => Number(x.value));
        if (!ids.length) { message('ta-msg', 'erreur', 'Aucun tarif sélectionné.'); return; }
        try {
          const r = await api('/tarification/tarifs-publier-lot', { method: 'POST', body: { ids } });
          message('ta-msg', 'ok', `${r.publies} tarif(s) publié(s). Le tarif précédent de chaque article/format a été remplacé.`);
          setTimeout(() => afficher('tarifs'), 1200);
        } catch (e) { message('ta-msg', 'erreur', e.message); }
      };
    } else if (o === 'promotions') {
      const [promos, familles, formats] = await Promise.all([
        api('/tarification/promotions'), api('/referentiels/familles'), api('/tarification/formats')]);
      const badgeP = s => ({ prevue: 'bleu', active: 'vert', terminee: 'gris', annulee: 'rouge' }[s] || 'gris');
      c.innerHTML = `
        <div class="table-defilante"><table>
          <tr><th>Libellé</th><th>Cible</th><th>Format</th><th class="num">Remise</th><th>Période</th><th class="num">Marge min</th><th>Statut</th><th></th></tr>
          ${promos.map(p => `<tr>
            <td><b>${esc(p.libelle)}</b></td>
            <td>${p.article_code ? esc(p.article_code) + (p.article_libelle ? ' · ' + esc(p.article_libelle) : '') : 'famille ' + esc(p.famille_code || '')}</td>
            <td>${esc(p.format_code || 'tous')}</td>
            <td class="num">${fmt(p.taux_remise, 1)} %</td>
            <td>${dateFr(p.date_debut)} → ${dateFr(p.date_fin)}</td>
            <td class="num">${fmt(p.marge_min, 1)} %</td>
            <td><span class="badge ${badgeP(p.statut)}">${esc(p.statut)}</span></td>
            <td style="white-space:nowrap">
              <button class="petit secondaire" onclick="simulerPromo(${p.id})">Simuler la marge</button>
              ${p.statut === 'prevue' ? `<button class="petit" onclick="statutPromo(${p.id},'active')">Activer</button>` : ''}
              ${p.statut === 'active' ? `<button class="petit secondaire" onclick="statutPromo(${p.id},'terminee')">Terminer</button>` : ''}
            </td></tr>`).join('') || '<tr><td colspan="8">Aucune promotion.</td></tr>'}
        </table></div>
        <div id="pm-simulation"></div>
        <div class="carte"><h3>Nouvelle campagne promotionnelle</h3>
          <div class="ligne-champs">
            <label class="champ">Libellé<input id="pm-libelle" style="min-width:200px"></label>
            <label class="champ">Article (ou vide)<input id="pm-article"></label>
            <label class="champ">Famille (ou vide)<select id="pm-famille"><option value="">-</option>${familles.map(f => `<option value="${esc(f.code)}">${esc(f.code)}</option>`).join('')}</select></label>
            <label class="champ">Format<select id="pm-format"><option value="">tous</option>${formats.map(f => `<option value="${esc(f.code)}">${esc(f.code)}</option>`).join('')}</select></label>
            <label class="champ">Remise (%)<input id="pm-remise" type="number" step="0.1"></label>
            <label class="champ">Du<input id="pm-debut" type="date"></label>
            <label class="champ">Au<input id="pm-fin" type="date"></label>
            <label class="champ">Marge min acceptée (%)<input id="pm-marge" type="number" step="0.1" value="0"></label>
            <button id="pm-creer">Créer</button>
          </div><div id="pm-msg"></div>
        </div>`;
      window.statutPromo = async (pid, s) => { await api(`/tarification/promotions/${pid}/statut`, { method: 'POST', body: { statut: s } }); afficher('promotions'); };
      window.simulerPromo = async pid => {
        const r = await api(`/tarification/promotions/${pid}/simulation`);
        document.getElementById('pm-simulation').innerHTML = `
          <div class="carte"><h3>Marge pendant « ${esc(r.promotion.libelle)} » (${fmt(r.promotion.taux_remise, 1)} % de remise)</h3>
          ${r.marges_negatives ? `<div class="message erreur">${r.marges_negatives} référence(s) en marge NÉGATIVE pendant la promotion.</div>` : ''}
          ${r.alertes && !r.marges_negatives ? `<div class="message erreur">${r.alertes} référence(s) sous la marge minimale acceptée.</div>` : ''}
          <div class="table-defilante"><table>
            <tr><th>Article</th><th>Format</th><th class="num">Prix normal</th><th class="num">Prix promo</th><th class="num">Taux de marque promo</th></tr>
            ${r.lignes.map(l => `<tr><td>${esc(l.article_code)}<br><span class="petite-note">${esc(l.libelle)}</span></td>
              <td>${esc(l.format_code)}</td><td class="num">${fcfa(l.prix_normal)}</td><td class="num"><b>${fcfa(l.prix_promo)}</b></td>
              <td class="num">${l.taux_marque_promo !== null ? `<span class="badge ${l.marge_negative ? 'rouge' : l.sous_marge_min ? 'orange' : 'vert'}">${fmt(l.taux_marque_promo, 1)} %</span>` : '-'}</td></tr>`).join('') || '<tr><td colspan="5">Aucun tarif publié dans le périmètre de la promotion.</td></tr>'}
          </table></div></div>`;
      };
      document.getElementById('pm-creer').onclick = async () => {
        try {
          await api('/tarification/promotions', {
            method: 'POST',
            body: { libelle: val('pm-libelle'), article_code: val('pm-article'), famille_code: val('pm-famille'), format_code: val('pm-format'), taux_remise: val('pm-remise'), date_debut: val('pm-debut'), date_fin: val('pm-fin'), marge_min: val('pm-marge') }
          });
          afficher('promotions');
        } catch (e) { message('pm-msg', 'erreur', e.message); }
      };
    } else if (o === 'controles') {
      const formats = await api('/tarification/formats');
      c.innerHTML = `
        <div class="ligne-champs">
          <label class="champ">Format<select id="ct-format">${formats.map(f => `<option value="${esc(f.code)}" ${f.code === 'SUP' ? 'selected' : ''}>${esc(f.libelle)}</option>`).join('')}</select></label>
          <label class="champ">Écart max entre formats (%)<input id="ct-ecart" type="number" value="15" style="width:80px"></label>
          <button id="ct-lancer">Lancer les contrôles</button>
        </div>
        <div id="ct-resultats"></div>`;
      const lancer = async () => {
        const r = await api(`/tarification/controles?format=${val('ct-format')}&ecart_max=${val('ct-ecart')}`);
        const types = { prix_au_kilo: 'Prix au kilo croissant avec la taille', ordre_de_gamme: 'Ordre de gamme inversé', ecart_formats: 'Écart excessif entre formats' };
        document.getElementById('ct-resultats').innerHTML = `
          <div class="message ${r.anomalies.length ? 'erreur' : 'ok'}">${r.nb_tarifs_controles} tarif(s) contrôlé(s) · ${r.anomalies.length} anomalie(s).</div>
          ${r.anomalies.length ? `<div class="table-defilante"><table>
            <tr><th>Type</th><th>Anomalie</th></tr>
            ${r.anomalies.map(a => `<tr><td><span class="badge orange">${esc(types[a.type] || a.type)}</span></td><td>${esc(a.message)}</td></tr>`).join('')}
          </table></div>` : ''}`;
      };
      document.getElementById('ct-lancer').onclick = lancer;
      await lancer();
    }
  }
  await afficher('proposer');
}

/* ---------------------------------- Veille ---------------------------------- */
async function vueVeille(page) {
  page.innerHTML = `
    <h1>Veille concurrentielle</h1>
    <p class="sous-titre">Relevés terrain et imports, appariement par code barres, indices de prix</p>
    <div class="onglets">
      <button data-o="saisie" class="actif">Saisir un relevé</button>
      <button data-o="releves">Relevés</button>
      <button data-o="apparier">File d'appariement</button>
      <button data-o="import">Import (Annexe C)</button>
      <button data-o="indices">Indices &amp; alertes</button>
    </div>
    <div id="v-contenu"></div>`;
  const onglets = page.querySelectorAll('.onglets button');
  onglets.forEach(b => b.onclick = () => { onglets.forEach(x => x.classList.remove('actif')); b.classList.add('actif'); afficher(b.dataset.o); });

  async function afficher(o) {
    const c = document.getElementById('v-contenu');
    if (o === 'saisie') {
      const enseignes = await api('/veille/enseignes');
      const attente = fileHorsConnexion();
      c.innerHTML = `
        ${attente.length ? `<div class="message info">${attente.length} relevé(s) en attente de synchronisation. <button class="petit" id="rv-sync">Synchroniser maintenant</button></div>` : ''}
        <div class="carte">
          <h3>Relevé de prix concurrent <span class="petite-note">- fonctionne hors connexion, synchronisation au retour du réseau</span></h3>
          <div class="ligne-champs">
            <label class="champ">Code barres *<input id="rv-cb" placeholder="scanner ou saisir"></label>
            <button class="secondaire" id="rv-scanner" title="Lecture par la caméra">📷 Scanner</button>
            <label class="champ">Enseigne<select id="rv-enseigne">${enseignes.map(e => `<option value="${esc(e.code)}">${esc(e.nom)}</option>`).join('')}</select></label>
            <label class="champ">Point de relevé<input id="rv-point" placeholder="magasin / site"></label>
            <label class="champ">Prix TTC (F CFA) *<input id="rv-prix" type="number"></label>
            <label class="champ">Type<select id="rv-type"><option value="fond_de_rayon">Fond de rayon</option><option value="promotion">Promotion</option></select></label>
            <label class="champ">Disponibilité<select id="rv-dispo"><option value="disponible">Disponible</option><option value="rupture">Rupture</option><option value="non_reference">Non référencé</option></select></label>
            <label class="champ">Date<input id="rv-date" type="date"></label>
            <button id="rv-enregistrer">Enregistrer le relevé</button>
          </div>
          <div id="rv-scan-zone"></div>
          <div id="rv-msg"></div>
        </div>`;
      const btnSync = document.getElementById('rv-sync');
      if (btnSync) btnSync.onclick = async () => {
        const n = await synchroniserReleves();
        message('rv-msg', 'ok', `${n} relevé(s) synchronisé(s).`);
        setTimeout(() => afficher('saisie'), 900);
      };
      // Lecture du code barres par la caméra (F-M7-02), avec repli en saisie manuelle
      document.getElementById('rv-scanner').onclick = async () => {
        const zone = document.getElementById('rv-scan-zone');
        if (!('BarcodeDetector' in window)) {
          zone.innerHTML = '<div class="message info">Lecture caméra non prise en charge par ce navigateur : saisissez le code manuellement.</div>';
          return;
        }
        try {
          const flux = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          zone.innerHTML = '<video id="rv-video" autoplay playsinline style="max-width:100%;border-radius:8px"></video> <button class="petit danger" id="rv-stop">Arrêter</button>';
          const video = document.getElementById('rv-video');
          video.srcObject = flux;
          const detecteur = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
          let actif = true;
          const arreter = () => { actif = false; flux.getTracks().forEach(t => t.stop()); zone.innerHTML = ''; };
          document.getElementById('rv-stop').onclick = arreter;
          const boucle = async () => {
            if (!actif) return;
            try {
              const codes = await detecteur.detect(video);
              if (codes.length) {
                document.getElementById('rv-cb').value = codes[0].rawValue;
                arreter();
                document.getElementById('rv-prix').focus();
                return;
              }
            } catch { /* image pas encore prête */ }
            setTimeout(boucle, 300);
          };
          boucle();
        } catch (e) {
          zone.innerHTML = `<div class="message erreur">Caméra inaccessible : ${esc(e.message)}</div>`;
        }
      };
      document.getElementById('rv-enregistrer').onclick = async (ev, forcer = false) => {
        const corps = {
          code_barres: val('rv-cb'), enseigne_code: val('rv-enseigne'), point_de_releve: val('rv-point'),
          prix_ttc: val('rv-prix'), type_prix: val('rv-type'), disponibilite: val('rv-dispo'),
          date_releve: val('rv-date') || null, confirmer_aberrant: forcer
        };
        try {
          const r = await api('/veille/releves', { method: 'POST', body: corps });
          message('rv-msg', 'ok', r.apparie ? `Relevé enregistré et apparié à ${r.article_code}.` : 'Relevé enregistré · non apparié, à traiter dans la file d\'appariement.');
          document.getElementById('rv-cb').value = ''; document.getElementById('rv-prix').value = '';
        } catch (e) {
          if (e.statut === 409) {
            message('rv-msg', 'erreur', e.message + ' ');
            const b = document.createElement('button'); b.className = 'petit'; b.textContent = 'Confirmer malgré tout';
            b.onclick = () => document.getElementById('rv-enregistrer').onclick(null, true);
            document.getElementById('rv-msg').firstChild.appendChild(b);
          } else if (e.message === 'Failed to fetch') {
            // Hors connexion : mise en file locale, synchronisation différée (F-M7-01)
            const file = fileHorsConnexion();
            file.push({ ...corps, date_releve: corps.date_releve || new Date().toISOString().slice(0, 10) });
            localStorage.setItem('tarifaire_releves_attente', JSON.stringify(file));
            message('rv-msg', 'info', `Hors connexion : relevé mis en file (${file.length} en attente). Il sera synchronisé au retour du réseau.`);
            document.getElementById('rv-cb').value = ''; document.getElementById('rv-prix').value = '';
          } else message('rv-msg', 'erreur', e.message);
        }
      };
    } else if (o === 'releves') {
      const releves = await api('/veille/releves');
      c.innerHTML = `
        <div class="actions-page"><button class="secondaire" id="rl-export">Exporter (CSV)</button></div>
        <div class="table-defilante"><table>
          <tr><th>Date</th><th>Code barres</th><th>Article</th><th>Enseigne</th><th>Point</th><th class="num">Prix TTC</th><th>Type</th><th>Dispo</th><th>Source</th><th>Auteur</th></tr>
          ${releves.map(x => `<tr><td>${dateFr(x.date_releve)}</td><td>${esc(x.code_barres)}</td>
            <td>${x.article_code ? esc(x.article_code) : '<span class="badge rouge">non apparié</span>'}</td>
            <td>${esc(x.enseigne_nom || x.enseigne_code || '')}</td><td>${esc(x.point_de_releve || '')}</td>
            <td class="num"><b>${fcfa(x.prix_ttc)}</b></td>
            <td>${x.type_prix === 'promotion' ? '<span class="badge orange">promo</span>' : 'fond de rayon'}</td>
            <td>${esc(x.disponibilite || '')}</td><td>${esc(x.source)}</td><td class="petite-note">${esc(x.auteur || '')}</td></tr>`).join('') || '<tr><td colspan="10">Aucun relevé.</td></tr>'}
        </table></div>`;
      document.getElementById('rl-export').onclick = () => telecharger('/veille/releves-export/csv', 'releves_concurrents.csv');
    } else if (o === 'apparier') {
      const releves = await api('/veille/releves?non_apparies=1');
      c.innerHTML = `
        <div class="message info">Relevés dont le code barres n'a pas de correspondance : associez-les à un article. L'appariement validé est mémorisé pour les collectes suivantes.</div>
        <div class="table-defilante"><table>
          <tr><th>Date</th><th>Code barres</th><th>Enseigne</th><th class="num">Prix</th><th>Article à associer</th><th></th></tr>
          ${releves.map(x => `<tr><td>${dateFr(x.date_releve)}</td><td>${esc(x.code_barres)}</td>
            <td>${esc(x.enseigne_nom || '')}</td><td class="num">${fcfa(x.prix_ttc)}</td>
            <td><input id="ap-${x.id}" placeholder="code interne article"></td>
            <td><button class="petit" onclick="apparierReleve(${x.id})">Associer</button></td></tr>`).join('') || '<tr><td colspan="6">File vide : tous les relevés sont appariés.</td></tr>'}
        </table></div><div id="ap-msg"></div>`;
      window.apparierReleve = async rid => {
        try {
          await api(`/veille/releves/${rid}/apparier`, { method: 'POST', body: { article_code: val('ap-' + rid) } });
          afficher('apparier');
        } catch (e) { message('ap-msg', 'erreur', e.message); }
      };
    } else if (o === 'import') {
      c.innerHTML = `
        <div class="carte">
          <h3>Import de relevés (format Annexe C · panel, collecte en ligne ou terrain)</h3>
          <p class="petite-note">Colonnes : code_barres;enseigne;point_de_releve;date_releve;prix_ttc;type_prix;disponibilite;conditionnement;source;justificatif</p>
          <textarea id="vi-csv"></textarea>
          <div class="actions-page"><button id="vi-importer">Importer</button></div>
          <div id="vi-msg"></div>
        </div>`;
      document.getElementById('vi-importer').onclick = async () => {
        try {
          const r = await api('/veille/releves-import/csv', { method: 'POST', body: { contenu: val('vi-csv') } });
          message('vi-msg', 'ok', `${r.importes} relevé(s) importé(s), ${r.apparies} apparié(s) automatiquement, ${r.non_apparies} en file de validation, ${r.rejets.length} rejet(s).`);
        } catch (e) { message('vi-msg', 'erreur', e.message); }
      };
    } else if (o === 'indices') {
      const formats = await api('/tarification/formats');
      c.innerHTML = `
        <div class="ligne-champs">
          <label class="champ">Format de référence<select id="in-format">${formats.map(f => `<option value="${esc(f.code)}" ${f.code === 'SUP' ? 'selected' : ''}>${esc(f.libelle)}</option>`).join('')}</select></label>
          <label class="champ">Seuil d'alerte (%)<input id="in-seuil" type="number" value="10" style="width:80px"></label>
          <button id="in-charger">Actualiser</button>
        </div>
        <div id="in-resultats"></div>`;
      const charger = async () => {
        const [ind, al] = await Promise.all([
          api('/veille/indices?format=' + val('in-format')),
          api('/veille/alertes?seuil=' + val('in-seuil'))
        ]);
        document.getElementById('in-resultats').innerHTML = `
          <h2>Indice de prix par enseigne (base 100 = concurrent)</h2>
          <div class="grille kpi">
            ${ind.syntheses.map(s => `<div class="carte"><div class="valeur ${s.indice_moyen > 102 ? 'alerte-rouge' : ''}">${fmt(s.indice_moyen, 1)}${s.indice_pondere_ca !== null ? ` <span style="font-size:14px" title="Indice pondéré par le poids de chaque référence dans le chiffre d'affaires (90 jours)">(pondéré CA : ${fmt(s.indice_pondere_ca, 1)})</span>` : ''}</div>
              <div class="libelle">${esc(s.enseigne)} · ${s.nb_references} référence(s) comparée(s)</div></div>`).join('') || '<p class="petite-note">Aucune comparaison possible : publiez des tarifs et enregistrez des relevés appariés.</p>'}
          </div>
          <h2>Alertes d'écart concurrentiel (&gt; ${val('in-seuil')} %)</h2>
          <div class="table-defilante"><table>
            <tr><th>Article</th><th>Format</th><th class="num">Notre prix</th><th class="num">Concurrent</th><th class="num">Écart</th><th>Enseigne</th><th>Relevé le</th><th>Sensibilité</th></tr>
            ${al.map(x => `<tr><td>${esc(x.article_code)}<br><span class="petite-note">${esc(x.libelle)}</span></td>
              <td>${esc(x.format_code)}</td><td class="num">${fcfa(x.notre_prix)}</td><td class="num">${fcfa(x.prix_concurrent)}</td>
              <td class="num"><span class="badge ${Number(x.ecart_pct) > 0 ? 'rouge' : 'vert'}">${x.ecart_pct > 0 ? '+' : ''}${fmt(x.ecart_pct, 1)} %</span></td>
              <td>${esc(x.enseigne_code || '')}</td><td>${dateFr(x.date_releve)}</td>
              <td>${x.sensibilite_prix === 'elevee' ? '<span class="badge rouge">élevée</span>' : esc(x.sensibilite_prix || '')}</td></tr>`).join('') || '<tr><td colspan="8">Aucune alerte.</td></tr>'}
          </table></div>
          <h2>Détail des comparaisons</h2>
          <div class="table-defilante"><table>
            <tr><th>Article</th><th class="num">Notre prix</th><th>Enseigne</th><th class="num">Prix concurrent</th><th class="num">Indice</th><th>Fraîcheur</th></tr>
            ${ind.details.map(x => `<tr><td>${esc(x.code_interne)}<br><span class="petite-note">${esc(x.libelle)}</span></td>
              <td class="num">${fcfa(x.notre_prix)}</td><td>${esc(x.enseigne_nom || x.enseigne_code)}</td>
              <td class="num">${fcfa(x.prix_concurrent)}</td>
              <td class="num"><b>${fmt(x.indice, 1)}</b></td>
              <td>${Number(x.age_jours) > 45 ? `<span class="badge rouge">${x.age_jours} j · périmé</span>` : `<span class="badge vert">${x.age_jours} j</span>`}</td></tr>`).join('') || '<tr><td colspan="6">Aucune donnée.</td></tr>'}
          </table></div>`;
      };
      document.getElementById('in-charger').onclick = charger;
      await charger();
    }
  }
  await afficher('saisie');
}

/* ---------------------------------- Administration ---------------------------------- */
async function vueAdmin(page) {
  page.innerHTML = `
    <h1>Administration</h1>
    <p class="sous-titre">Utilisateurs, paramètres, taux de change et journal d'audit</p>
    <div class="onglets">
      <button data-o="utilisateurs" class="actif">Utilisateurs</button>
      <button data-o="parametres">Paramètres</button>
      <button data-o="change">Taux de change</button>
      <button data-o="journal">Journal d'audit</button>
    </div>
    <div id="ad-contenu"></div>`;
  const onglets = page.querySelectorAll('.onglets button');
  onglets.forEach(b => b.onclick = () => { onglets.forEach(x => x.classList.remove('actif')); b.classList.add('actif'); afficher(b.dataset.o); });

  async function afficher(o) {
    const c = document.getElementById('ad-contenu');
    if (o === 'utilisateurs') {
      let utilisateurs = [];
      try { utilisateurs = await api('/admin/utilisateurs'); }
      catch { c.innerHTML = '<div class="message erreur">Accès réservé aux administrateurs.</div>'; return; }
      const roles = ['enqueteur', 'lecture', 'acheteur', 'import', 'comptable', 'controle', 'direction', 'admin'];
      c.innerHTML = `
        <div class="table-defilante"><table>
          <tr><th>Courriel</th><th>Nom</th><th>Rôle</th><th>Actif</th><th>Créé le</th></tr>
          ${utilisateurs.map(u => `<tr><td>${esc(u.email)}</td><td>${esc(u.nom)}</td>
            <td><span class="badge bleu">${esc(u.role)}</span></td>
            <td>${u.actif ? '<span class="badge vert">oui</span>' : '<span class="badge rouge">non</span>'}</td>
            <td>${dateFr(u.cree_le)}</td></tr>`).join('')}
        </table></div>
        <div class="carte"><h3>Créer / modifier un utilisateur</h3>
          <div class="ligne-champs">
            <label class="champ">Courriel<input id="u-email" type="email"></label>
            <label class="champ">Nom<input id="u-nom"></label>
            <label class="champ">Rôle<select id="u-role">${roles.map(r2 => `<option value="${r2}">${r2}</option>`).join('')}</select></label>
            <label class="champ">Mot de passe<input id="u-mdp" type="password"></label>
            <label><input type="checkbox" id="u-actif" checked> Actif</label>
            <button id="u-enregistrer">Enregistrer</button>
          </div><div id="u-msg"></div>
          <p class="petite-note">Rôles : enqueteur (relevés uniquement) → lecture → acheteur → import → comptable → controle → direction → admin.</p>
        </div>`;
      document.getElementById('u-enregistrer').onclick = async () => {
        try {
          await api('/admin/utilisateurs', { method: 'POST', body: { email: val('u-email'), nom: val('u-nom'), role: val('u-role'), mot_de_passe: val('u-mdp'), actif: coche('u-actif') } });
          afficher('utilisateurs');
        } catch (e) { message('u-msg', 'erreur', e.message); }
      };
    } else if (o === 'parametres') {
      let params = [];
      try { params = await api('/admin/parametres'); }
      catch { c.innerHTML = '<div class="message erreur">Accès réservé aux administrateurs.</div>'; return; }
      c.innerHTML = `
        <div class="actions-page">
          <button class="secondaire" id="pa-export-complet" title="Réversibilité (F-M11-09) : toutes les données dans un format ouvert">⬇ Export complet des données (JSON)</button>
        </div>
        <div class="table-defilante"><table>
          <tr><th>Clé</th><th>Valeur</th></tr>
          ${params.map(p => `<tr><td><code>${esc(p.cle)}</code></td><td>${esc(p.valeur)}</td></tr>`).join('')}
        </table></div>
        <div class="carte"><h3>Définir un paramètre</h3>
          <div class="ligne-champs">
            <label class="champ">Clé<input id="pa-cle"></label>
            <label class="champ">Valeur<input id="pa-valeur"></label>
            <button id="pa-enregistrer">Enregistrer</button>
          </div><div id="pa-msg"></div>
          <p class="petite-note">Paramètres reconnus : <code>ratio_unite_payante</code> (tonnes pour 1 m³, défaut 1),
          <code>prorata_deduction</code> (fraction de TVA déductible en %, défaut 100 ; en dessous, la TVA rémanente est capitalisée),
          <code>devise_reference</code>, <code>entreprise</code>.</p>
        </div>`;
      document.getElementById('pa-export-complet').onclick = () => telecharger('/admin/export-complet', 'export_tarifaire_complet.json');
      document.getElementById('pa-enregistrer').onclick = async () => {
        try {
          await api('/admin/parametres', { method: 'POST', body: { cle: val('pa-cle'), valeur: val('pa-valeur') } });
          afficher('parametres');
        } catch (e) { message('pa-msg', 'erreur', e.message); }
      };
    } else if (o === 'change') {
      const taux = await api('/admin/taux-change');
      c.innerHTML = `
        <div class="message info">Parité fixe : 1 EUR = 655,957 F CFA. Saisir le cours en F CFA pour 1 unité de devise.</div>
        <div class="table-defilante"><table>
          <tr><th>Devise</th><th class="num">Cours (F CFA)</th><th>Date</th><th>Source</th></tr>
          ${taux.map(t => `<tr><td><b>${esc(t.devise)}</b></td><td class="num">${fmt(t.cours, 4)}</td><td>${dateFr(t.date_cours)}</td><td>${esc(t.source || '')}</td></tr>`).join('') || '<tr><td colspan="4">Aucun cours enregistré.</td></tr>'}
        </table></div>
        <div class="carte"><h3>Enregistrer un cours</h3>
          <div class="ligne-champs">
            <label class="champ">Devise<input id="tc-devise" placeholder="EUR / USD / CNY" style="width:100px"></label>
            <label class="champ">Cours (F CFA)<input id="tc-cours" type="number" step="0.0001"></label>
            <label class="champ">Date<input id="tc-date" type="date"></label>
            <label class="champ">Source<input id="tc-source" placeholder="BCEAO…"></label>
            <button id="tc-enregistrer">Enregistrer</button>
          </div><div id="tc-msg"></div>
        </div>`;
      document.getElementById('tc-enregistrer').onclick = async () => {
        try {
          await api('/admin/taux-change', { method: 'POST', body: { devise: val('tc-devise'), cours: val('tc-cours'), date_cours: val('tc-date') || null, source: val('tc-source') } });
          afficher('change');
        } catch (e) { message('tc-msg', 'erreur', e.message); }
      };
    } else if (o === 'journal') {
      let journal = [];
      try { journal = await api('/admin/journal'); }
      catch { c.innerHTML = '<div class="message erreur">Accès réservé (rôle comptable au minimum).</div>'; return; }
      c.innerHTML = `
        <div class="actions-page">
          <button class="secondaire" id="jr-verifier">Vérifier l'intégrité de la chaîne du journal</button>
          <span id="jr-verdict"></span>
        </div>
        <div class="table-defilante"><table>
          <tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Objet</th><th>Identifiant</th><th>Détail</th></tr>
          ${journal.map(j => `<tr><td>${new Date(j.date_action).toLocaleString('fr-FR')}</td><td>${esc(j.utilisateur || '')}</td>
            <td><span class="badge gris">${esc(j.action)}</span></td><td>${esc(j.objet_type)}</td>
            <td>${esc(j.objet_id || '')}</td><td class="petite-note">${esc(j.detail || '')}</td></tr>`).join('')}
        </table></div>`;
      document.getElementById('jr-verifier').onclick = async () => {
        const v = await api('/admin/journal-verification');
        document.getElementById('jr-verdict').innerHTML = v.integre
          ? `<span class="badge vert">chaîne intègre (${v.entrees_verifiees} entrées vérifiées)</span>`
          : `<span class="badge rouge">RUPTURE à l'entrée ${v.rupture_id} : ${esc(v.motif)}</span>`;
      };
    }
  }
  await afficher('utilisateurs');
}

/* ---------------------------------- Marge réalisée (lot 2) ---------------------------------- */
async function vueMarges(page) {
  page.innerHTML = `
    <h1>Marge réalisée</h1>
    <p class="sous-titre">Comparaison entre la marge théorique des tarifs publiés et la marge constatée sur les ventes remontées de l'ERP</p>
    <div class="carte">
      <h3>Importer les ventes (flux FE07)</h3>
      <p class="petite-note">Colonnes : code_barres (ou code_interne);point_de_vente;date_vente;quantite;ca_ttc</p>
      <textarea id="mv-csv" placeholder="Collez le CSV des ventes…"></textarea>
      <div class="actions-page"><button id="mv-importer">Importer les ventes</button></div>
      <div id="mv-msg"></div>
    </div>
    <div class="ligne-champs">
      <label class="champ">Depuis le<input id="mv-depuis" type="date"></label>
      <label class="champ">Famille<input id="mv-famille" placeholder="code famille"></label>
      <button id="mv-charger">Actualiser</button>
    </div>
    <div id="mv-resultats"></div>`;

  document.getElementById('mv-importer').onclick = async () => {
    try {
      const r = await api('/pilotage/ventes-import/csv', { method: 'POST', body: { contenu: val('mv-csv') } });
      message('mv-msg', 'ok', `${r.importees} ligne(s) de vente importée(s), ${r.rejets.length} rejet(s).`);
      if (r.rejets.length) document.getElementById('mv-msg').innerHTML +=
        '<ul>' + r.rejets.slice(0, 10).map(x => `<li>Ligne ${x.ligne} : ${esc(x.motif)}</li>`).join('') + '</ul>';
      charger();
    } catch (e) { message('mv-msg', 'erreur', e.message); }
  };

  async function charger() {
    const q = new URLSearchParams();
    if (val('mv-depuis')) q.set('depuis', val('mv-depuis'));
    if (val('mv-famille')) q.set('famille', val('mv-famille').toUpperCase());
    const r = await api('/pilotage/marge-realisee?' + q.toString());
    document.getElementById('mv-resultats').innerHTML = `
      <div class="grille kpi">
        <div class="carte"><div class="valeur">${fcfa(r.total.ca_ttc)}</div><div class="libelle">Chiffre d'affaires TTC</div></div>
        <div class="carte"><div class="valeur">${fcfa(r.total.marge_realisee)}</div><div class="libelle">Marge réalisée (références avec coût connu)</div></div>
        <div class="carte"><div class="valeur">${fmt(r.total.nb_references)}</div><div class="libelle">Références vendues (${fmt(r.total.sans_cout)} sans coût calculé)</div></div>
      </div>
      <div class="table-defilante"><table>
        <tr><th>Article</th><th>Famille</th><th class="num">Qté vendue</th><th class="num">CA TTC</th><th class="num">CUMP</th>
        <th class="num">Marge réalisée</th><th class="num">Taux réalisé</th><th class="num">Taux théorique</th><th class="num">Écart</th></tr>
        ${r.lignes.map(l => `<tr>
          <td>${esc(l.article_code)}<br><span class="petite-note">${esc(l.libelle)}</span></td>
          <td>${esc(l.famille || '')}</td><td class="num">${fmt(l.quantite_vendue)}</td>
          <td class="num">${fcfa(l.ca_ttc)}</td>
          <td class="num">${l.cout_unitaire !== null ? fmt(l.cout_unitaire, 1) : '<span class="badge rouge">inconnu</span>'}</td>
          <td class="num">${l.marge_realisee !== null ? fcfa(l.marge_realisee) : '-'}</td>
          <td class="num">${l.taux_marque_realise !== null ? fmt(l.taux_marque_realise, 1) + ' %' : '-'}</td>
          <td class="num">${l.taux_marque_theorique !== null ? fmt(l.taux_marque_theorique, 1) + ' %' : '-'}</td>
          <td class="num">${l.ecart_taux !== null ? `<span class="badge ${l.ecart_taux < -2 ? 'rouge' : l.ecart_taux > 2 ? 'vert' : 'gris'}">${l.ecart_taux > 0 ? '+' : ''}${fmt(l.ecart_taux, 1)}</span>` : '-'}</td>
        </tr>`).join('') || '<tr><td colspan="9">Aucune vente importée sur la période.</td></tr>'}
      </table></div>
      <p class="petite-note">Un écart négatif signale une exécution en dessous de la politique : démarque non prévue, prix mal appliqué en caisse ou promotion non tracée.</p>`;
  }
  document.getElementById('mv-charger').onclick = charger;
  await charger();
}

/* ---------------------------------- Mon compte (lot 4) ---------------------------------- */
async function vueCompte(page) {
  const notifs = await api('/compte/notifications');
  const doitChanger = etat.utilisateur && etat.utilisateur.doit_changer_mdp;
  page.innerHTML = `
    <h1>Mon compte</h1>
    <p class="sous-titre">${esc(etat.utilisateur?.email || '')} · rôle ${esc(etat.utilisateur?.role || '')}</p>
    ${doitChanger ? '<div class="message erreur">Votre mot de passe initial doit être changé avant toute utilisation en conditions réelles.</div>' : ''}
    <div class="deux-colonnes">
      <div class="carte">
        <h3>Changer mon mot de passe</h3>
        <div class="ligne-champs">
          <label class="champ">Ancien<input id="cp-ancien" type="password"></label>
          <label class="champ">Nouveau (10 caractères min.)<input id="cp-nouveau" type="password"></label>
          <button id="cp-changer">Changer</button>
        </div>
        <div id="cp-msg"></div>
      </div>
      <div class="carte">
        <h3>Double authentification (TOTP)</h3>
        <p class="petite-note">Renforce l'accès aux données de coût et de marge (F-M11-03). Fonctionne avec toute application d'authentification (Google Authenticator, Aegis, FreeOTP…).</p>
        <div class="actions-page">
          <button id="fa2-preparer" class="secondaire">${etat.utilisateur?.totp_actif ? 'Régénérer le secret' : 'Activer la double authentification'}</button>
          <button id="fa2-desactiver" class="danger petit">Désactiver</button>
        </div>
        <div id="fa2-zone"></div>
      </div>
    </div>
    <h2>Notifications</h2>
    <div class="table-defilante"><table>
      <tr><th>Date</th><th>Titre</th><th>Détail</th><th></th></tr>
      ${notifs.map(n => `<tr style="${n.lue ? 'opacity:.55' : ''}">
        <td>${new Date(n.cree_le).toLocaleString('fr-FR')}</td>
        <td><b>${esc(n.titre)}</b>${n.envoyee_courriel ? ' <span class="badge gris">courriel envoyé</span>' : ''}</td>
        <td class="petite-note" style="white-space:pre-line">${esc(n.corps || '')}</td>
        <td>${n.lue ? '' : `<button class="petit secondaire" onclick="marquerLue(${n.id})">Marquer lue</button>`}</td>
      </tr>`).join('') || '<tr><td colspan="4">Aucune notification.</td></tr>'}
    </table></div>`;

  window.marquerLue = async id => { await api(`/compte/notifications/${id}/lue`, { method: 'POST' }); rendre(); };
  document.getElementById('cp-changer').onclick = async () => {
    try {
      await api('/compte/mot-de-passe', { method: 'POST', body: { ancien: val('cp-ancien'), nouveau: val('cp-nouveau') } });
      etat.utilisateur.doit_changer_mdp = false;
      localStorage.setItem('tarifaire_utilisateur', JSON.stringify(etat.utilisateur));
      message('cp-msg', 'ok', 'Mot de passe changé.');
    } catch (e) { message('cp-msg', 'erreur', e.message); }
  };
  document.getElementById('fa2-preparer').onclick = async () => {
    const r = await api('/compte/2fa/preparer', { method: 'POST' });
    document.getElementById('fa2-zone').innerHTML = `
      <div class="message info">Secret : <code>${esc(r.secret)}</code><br>
      URL : <code style="word-break:break-all">${esc(r.otpauth)}</code><br>${esc(r.aide)}</div>
      <div class="ligne-champs">
        <label class="champ">Code de confirmation<input id="fa2-code" inputmode="numeric" maxlength="6"></label>
        <button id="fa2-confirmer">Confirmer l'activation</button>
      </div><div id="fa2-msg"></div>`;
    document.getElementById('fa2-confirmer').onclick = async () => {
      try {
        await api('/compte/2fa/confirmer', { method: 'POST', body: { code: val('fa2-code') } });
        etat.utilisateur.totp_actif = true;
        localStorage.setItem('tarifaire_utilisateur', JSON.stringify(etat.utilisateur));
        message('fa2-msg', 'ok', 'Double authentification activée : elle sera exigée à la prochaine connexion.');
      } catch (e) { message('fa2-msg', 'erreur', e.message); }
    };
  };
  document.getElementById('fa2-desactiver').onclick = async () => {
    const code = prompt('Code de double authentification (laisser vide si non activée) :') || '';
    try {
      await api('/compte/2fa/desactiver', { method: 'POST', body: { code } });
      etat.utilisateur.totp_actif = false;
      localStorage.setItem('tarifaire_utilisateur', JSON.stringify(etat.utilisateur));
      rendre();
    } catch (e) { alert(e.message); }
  };
}

/* ------------------------- File de relevés hors connexion (lot 3) ------------------------- */
function fileHorsConnexion() {
  return JSON.parse(localStorage.getItem('tarifaire_releves_attente') || '[]');
}

async function synchroniserReleves() {
  const attente = fileHorsConnexion();
  if (!attente.length || !etat.token) return 0;
  let envoyes = 0;
  const restants = [];
  for (const releve of attente) {
    try {
      await api('/veille/releves', { method: 'POST', body: { ...releve, confirmer_aberrant: true } });
      envoyes++;
    } catch (e) {
      if (e.message === 'Failed to fetch' || e.statut === 429 || e.statut === 503) restants.push(releve);
      // un relevé rejeté pour une autre raison (article inconnu, etc.) est abandonné, pas rejoué en boucle
    }
  }
  localStorage.setItem('tarifaire_releves_attente', JSON.stringify(restants));
  return envoyes;
}

window.addEventListener('online', () => {
  synchroniserReleves().then(n => { if (n) alert(`${n} relevé(s) hors connexion synchronisé(s).`); });
});

/* ---------------------------------- Démarrage ---------------------------------- */
window.naviguer = naviguer;
window.deconnexion = deconnexion;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
rendre();
synchroniserReleves();
