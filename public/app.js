'use strict';
/* Tarifaire — application web (page unique, sans dépendance externe). */

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
  if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fcfa(n) { return n === null || n === undefined ? '—' : fmt(n) + ' F'; }
function dateFr(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : '—'; }
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

/* ---------------------------------- Routeur ---------------------------------- */
const routes = {
  '': vueTableau, 'tableau': vueTableau, 'articles': vueArticles, 'article': vueFicheArticle,
  'douane': vueDouane, 'dossiers': vueDossiers, 'dossier': vueDossierDetail,
  'tarification': vueTarification, 'veille': vueVeille, 'admin': vueAdmin
};

window.addEventListener('hashchange', rendre);

function naviguer(hash) { location.hash = hash; }

function rendre() {
  const app = document.getElementById('app');
  if (!etat.token) { vueConnexion(app); return; }
  const [route, ...args] = location.hash.replace(/^#\/?/, '').split('/');
  const vue = routes[route] || vueTableau;
  const menu = [
    ['tableau', 'Tableau de bord'],
    ['articles', 'Référentiel article'],
    ['douane', 'Douane & fiscalité'],
    ['dossiers', "Dossiers d'importation"],
    ['tarification', 'Tarification'],
    ['veille', 'Veille concurrentielle'],
    ['admin', 'Administration']
  ];
  app.innerHTML = `
    <nav class="lateral">
      <div class="logo">TARIFAIRE<small>Prix de revient &amp; politique tarifaire — UEMOA</small></div>
      ${menu.map(([r, l]) => `<a class="item ${route === r || (route === '' && r === 'tableau') || (route === 'article' && r === 'articles') || (route === 'dossier' && r === 'dossiers') ? 'actif' : ''}" href="#/${r}">${l}</a>`).join('')}
      <div class="pied">
        <div>${esc(etat.utilisateur?.nom || '')}<br><span class="badge gris">${esc(etat.utilisateur?.role || '')}</span></div>
        <button class="secondaire petit" onclick="deconnexion()">Se déconnecter</button>
      </div>
    </nav>
    <main class="contenu" id="page">Chargement…</main>`;
  vue(document.getElementById('page'), args).catch(e => {
    document.getElementById('page').innerHTML = `<div class="message erreur">${esc(e.message)}</div>`;
  });
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
        <button id="btn-connexion">Se connecter</button>
        <p class="petite-note">Compte de démonstration initial : admin@demo.sn / admin123</p>
      </div>
    </div>`;
  const soumettre = async () => {
    try {
      const r = await api('/connexion', { method: 'POST', body: { email: val('c-email'), mot_de_passe: val('c-mdp') } });
      etat.token = r.token; etat.utilisateur = r.utilisateur;
      localStorage.setItem('tarifaire_token', r.token);
      localStorage.setItem('tarifaire_utilisateur', JSON.stringify(r.utilisateur));
      rendre();
    } catch (e) { message('msg-connexion', 'erreur', e.message); }
  };
  document.getElementById('btn-connexion').onclick = soumettre;
  app.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') soumettre(); }));
}

/* ---------------------------------- Tableau de bord ---------------------------------- */
async function vueTableau(page) {
  const [tb, analyse] = await Promise.all([api('/pilotage/tableau-de-bord'), api('/pilotage/analyse-dossiers')]);
  const statuts = Object.fromEntries(tb.dossiers_par_statut.map(x => [x.statut, x.n]));
  const tarifs = Object.fromEntries(tb.tarifs_par_statut.map(x => [x.statut, x.n]));
  page.innerHTML = `
    <h1>Tableau de bord</h1>
    <p class="sous-titre">Vue d'ensemble du référentiel, des coûts et de la politique tarifaire</p>
    <div class="grille kpi">
      <div class="carte"><div class="valeur">${fmt(tb.articles.actifs)}</div><div class="libelle">Articles actifs (${fmt(tb.articles.total)} au total)</div></div>
      <div class="carte"><div class="valeur">${fmt(tb.completude.taux, 1)} %</div><div class="libelle">Complétude du référentiel (poids, volume, colisage, position)</div></div>
      <div class="carte"><div class="valeur">${fcfa(tb.creance_tva)}</div><div class="libelle">Créances sur l'État (TVA import + acomptes liquidés)</div></div>
      <div class="carte"><div class="valeur ${tb.references_marge_negative > 0 ? 'alerte-rouge' : ''}">${fmt(tb.references_marge_negative)}</div><div class="libelle">Tarifs en marge négative</div></div>
      <div class="carte"><div class="valeur">${tb.coefficient_moyen ? fmt(tb.coefficient_moyen, 3) : '—'}</div><div class="libelle">Coefficient de revient moyen</div></div>
      <div class="carte"><div class="valeur">${tb.taux_effectif_bornes && tb.taux_effectif_bornes.mini !== null ? fmt(tb.taux_effectif_bornes.mini, 1) + ' → ' + fmt(tb.taux_effectif_bornes.maxi, 1) + ' %' : '—'}</div><div class="libelle">Taux effectif de droits et taxes (mini → maxi)</div></div>
      <div class="carte"><div class="valeur">${fmt(tb.releves_30j.mois)}</div><div class="libelle">Relevés concurrents sur 30 jours (${fmt(tb.releves_30j.non_apparies)} à apparier)</div></div>
      <div class="carte"><div class="valeur ${tb.doublons_codes_barres > 0 ? 'alerte-rouge' : ''}">${fmt(tb.doublons_codes_barres)}</div><div class="libelle">Doublons de codes barres</div></div>
      <div class="carte"><div class="valeur">${fmt(statuts.ouvert || 0)} / ${fmt(statuts.cloture || 0)}</div><div class="libelle">Dossiers ouverts / clôturés</div></div>
      <div class="carte"><div class="valeur">${fmt(tarifs.publie || 0)}</div><div class="libelle">Tarifs publiés (${fmt(tarifs.propose || 0)} en attente)</div></div>
    </div>
    <h2>Derniers dossiers d'importation</h2>
    <div class="table-defilante"><table>
      <tr><th>Référence</th><th>Statut</th><th class="num">Lignes</th><th class="num">Valeur d'achat</th><th class="num">Coût total</th><th class="num">Coefficient</th><th class="num">Taux effectif</th></tr>
      ${analyse.map(d => `<tr class="cliquable" onclick="naviguer('#/dossier/${d.id}')">
        <td>${esc(d.reference)}</td><td>${badgeStatutDossier(d.statut)}</td>
        <td class="num">${fmt(d.nb_lignes)}</td><td class="num">${fcfa(d.valeur_achat)}</td>
        <td class="num">${fcfa(d.cout_total)}</td><td class="num">${d.coefficient ? fmt(d.coefficient, 3) : '—'}</td>
        <td class="num">${d.te_min !== null && d.te_min !== undefined ? fmt(d.te_min, 1) + ' → ' + fmt(d.te_max, 1) + ' %' : '—'}</td>
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
    <h1>Référentiel article</h1>
    <p class="sous-titre">Socle de la plateforme : toute imprécision se propage au coût et à la marge</p>
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
    document.getElementById('a-liste').innerHTML = `
      <div class="table-defilante"><table>
        <tr><th>Code</th><th>Code barres</th><th>Libellé</th><th>Famille</th><th class="num">Colisage</th>
        <th class="num">Poids carton</th><th class="num">Volume</th><th class="num">Densité</th><th>UP</th>
        <th>Position</th><th class="num">Taux eff.</th><th>Complétude</th></tr>
        ${articles.map(a => `<tr class="cliquable" onclick="naviguer('#/article/${encodeURIComponent(a.code_interne)}')">
          <td>${esc(a.code_interne)}</td><td>${esc(a.code_barres || '')}</td><td>${esc(a.libelle)}</td>
          <td>${esc(a.famille_code || '')}</td><td class="num">${fmt(a.unites_par_carton)}</td>
          <td class="num">${a.poids_brut_carton ? fmt(a.poids_brut_carton, 2) + ' kg' : '—'}</td>
          <td class="num">${a.volume_carton ? fmt(a.volume_carton, 4) + ' m³' : '—'}</td>
          <td class="num">${a.densite ? fmt(a.densite) : '—'}</td>
          <td>${a.indicateur_up ? `<span class="badge ${a.indicateur_up === 'poids' ? 'bleu' : 'orange'}">${a.indicateur_up}</span>` : '—'}</td>
          <td>${esc(a.position_tarifaire || '')}</td>
          <td class="num">${a.taux_effectif_constate ? fmt(a.taux_effectif_constate, 1) + ' %' : '—'}</td>
          <td>${a.complet ? '<span class="badge vert">complète</span>' : `<span class="badge rouge" title="${esc(a.donnees_manquantes.join(', '))}">${a.donnees_manquantes.length} manquante(s)</span>`}</td>
        </tr>`).join('') || '<tr><td colspan="12">Aucun article.</td></tr>'}
      </table></div>
      <p class="petite-note">${articles.length} article(s) affiché(s) — limite 500.</p>`;
  }
  document.getElementById('a-chercher').onclick = charger;
  document.getElementById('a-recherche').addEventListener('keydown', e => { if (e.key === 'Enter') charger(); });
  document.getElementById('a-export').onclick = () => telecharger('/referentiels/articles-export/csv', 'referentiel_articles.csv');
  document.getElementById('a-import').onclick = () => {
    document.getElementById('a-zone-import').innerHTML = `
      <div class="carte">
        <h3>Import du référentiel (format Annexe B)</h3>
        <p class="petite-note">Colonnes : code_interne;code_barres;libelle;famille;fournisseur;reference_fournisseur;unites_par_carton;poids_net_unitaire;poids_brut_carton;longueur_carton;largeur_carton;hauteur_carton;volume_carton;position_tarifaire;origine;taux_tva_vente;statut</p>
        <textarea id="a-csv" placeholder="Collez le contenu CSV ici…"></textarea>
        <div class="actions-page">
          <button id="a-previsualiser">Prévisualiser</button>
          <button id="a-confirmer" disabled>Confirmer l'import</button>
        </div>
        <div id="a-rapport"></div>
      </div>`;
    document.getElementById('a-previsualiser').onclick = async () => {
      try {
        const r = await api('/referentiels/articles-import/csv', { method: 'POST', body: { contenu: val('a-csv') } });
        document.getElementById('a-rapport').innerHTML = `<div class="message info">${r.importables} ligne(s) importable(s) sur ${r.total}. ${r.rejets.length} rejet(s).</div>
          ${r.rejets.length ? '<ul>' + r.rejets.map(x => `<li>Ligne ${x.ligne} : ${esc(x.motif)}</li>`).join('') + '</ul>' : ''}`;
        document.getElementById('a-confirmer').disabled = r.importables === 0;
      } catch (e) { message('a-rapport', 'erreur', e.message); }
    };
    document.getElementById('a-confirmer').onclick = async () => {
      try {
        const r = await api('/referentiels/articles-import/csv', { method: 'POST', body: { contenu: val('a-csv'), confirmer: true } });
        message('a-rapport', 'ok', `${r.crees} créé(s), ${r.modifies} modifié(s), ${r.rejets.length} rejet(s).`);
        charger();
      } catch (e) { message('a-rapport', 'erreur', e.message); }
    };
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
    <p class="sous-titre">${nouveau ? '' : 'Code ' + esc(a.code_interne) + (a.complet ? '' : ' — <span class="badge rouge">données manquantes : ' + esc((a.donnees_manquantes || []).join(', ')) + '</span>')}</p>
    <div id="fa-msg"></div>
    <div class="carte">
      <h3>Identification</h3>
      <div class="ligne-champs">
        ${champ('fa-code', 'Code interne *', a.code_interne, 'text', nouveau ? '' : 'readonly')}
        ${champ('fa-cb', 'Code barres (EAN/UPC)', a.code_barres)}
        ${champ('fa-libelle', 'Libellé long *', a.libelle, 'text', 'style="min-width:300px"')}
        ${champ('fa-libelle-court', 'Libellé court (caisse)', a.libelle_court)}
        ${sel('fa-famille', 'Famille', [['', '—']].concat(familles.map(f => [f.code, f.code + ' — ' + f.libelle])), a.famille_code)}
        ${champ('fa-marque', 'Marque', a.marque)}
        ${sel('fa-type-marque', 'Type de marque', [['', '—'], ['nationale', 'Marque nationale'], ['propre', 'Marque propre'], ['premier_prix', 'Premier prix']], a.type_marque)}
        ${sel('fa-statut', 'Statut', [['en_creation', 'En création'], ['actif', 'Actif'], ['en_arret', 'En arrêt'], ['arrete', 'Arrêté'], ['saisonnier', 'Saisonnier']], a.statut || 'actif')}
        ${sel('fa-fournisseur', 'Fournisseur principal', [['', '—']].concat(fournisseurs.map(f => [f.code, f.code + ' — ' + f.nom])), a.fournisseur_code)}
        ${champ('fa-ref-fourn', 'Référence fournisseur', a.reference_fournisseur)}
      </div>
    </div>
    <div class="carte">
      <h3>Logistique <span class="petite-note">— volume calculé depuis les dimensions, densité et unité payante déduites</span></h3>
      <div class="ligne-champs">
        ${champ('fa-upc', 'Unités / carton', a.unites_par_carton, 'number')}
        ${champ('fa-pnu', 'Poids net unitaire (kg)', a.poids_net_unitaire, 'number', 'step="0.001"')}
        ${champ('fa-pbc', 'Poids brut carton (kg)', a.poids_brut_carton, 'number', 'step="0.001"')}
        ${champ('fa-long', 'Longueur carton (cm)', a.longueur_carton, 'number', 'step="0.1"')}
        ${champ('fa-larg', 'Largeur carton (cm)', a.largeur_carton, 'number', 'step="0.1"')}
        ${champ('fa-haut', 'Hauteur carton (cm)', a.hauteur_carton, 'number', 'step="0.1"')}
        ${champ('fa-vol', 'Volume carton (m³)', a.volume_carton, 'number', 'step="0.00001"')}
      </div>
      ${!nouveau && a.densite ? `<p>Densité : <b>${fmt(a.densite)} kg/m³</b> — l'unité payante retenue pour le fret est le <span class="badge ${a.indicateur_up === 'poids' ? 'bleu' : 'orange'}">${a.indicateur_up}</span></p>` : ''}
    </div>
    <div class="carte">
      <h3>Douane &amp; fiscalité</h3>
      <div class="ligne-champs">
        ${champ('fa-position', 'Position tarifaire (10 chiffres)', a.position_tarifaire)}
        ${champ('fa-origine', 'Origine (code pays)', a.origine, 'text', 'maxlength="2" style="width:70px"')}
        ${champ('fa-tva', 'TVA à la vente (%)', a.taux_tva_vente ?? 18, 'number', 'step="0.1"')}
      </div>
      ${a.taux_effectif_constate ? `<p>Taux effectif de droits et taxes constaté sur dossiers : <b>${fmt(a.taux_effectif_constate, 1)} %</b></p>` : ''}
    </div>
    <div class="carte">
      <h3>Commercial</h3>
      <div class="ligne-champs">
        ${champ('fa-marge', 'Marge cible (%, surcharge famille)', a.marge_cible, 'number', 'step="0.1"')}
        ${sel('fa-role', "Rôle dans l'assortiment", [['', '—'], ['appel', "Produit d'appel"], ['marge', 'Produit de marge'], ['gamme', 'Produit de gamme']], a.role_assortiment)}
        ${sel('fa-sensibilite', 'Sensibilité prix', [['', '—'], ['elevee', 'Élevée'], ['moyenne', 'Moyenne'], ['faible', 'Faible']], a.sensibilite_prix)}
        ${sel('fa-arbitrage', "Mode d'arbitrage prix", [['', 'Selon politique'], ['marge', 'Marge prioritaire'], ['marche', 'Marché prioritaire'], ['encadre', 'Encadré'], ['alignement', 'Alignement strict'], ['manuel', 'Manuel']], a.mode_arbitrage)}
      </div>
    </div>
    <div class="actions-page">
      <button id="fa-enregistrer">Enregistrer</button>
      <button class="secondaire" onclick="naviguer('#/articles')">Retour à la liste</button>
    </div>
    ${!nouveau ? `
    <div class="deux-colonnes">
      <div class="carte">
        <h3>Conditions d'achat</h3>
        ${(a.conditions_achat || []).length ? `<div class="table-defilante"><table>
          <tr><th>Fournisseur</th><th class="num">Prix</th><th>Devise</th><th class="num">Remise</th><th>Date d'effet</th></tr>
          ${a.conditions_achat.map(c => `<tr><td>${esc(c.fournisseur_nom)}</td><td class="num">${fmt(c.prix_achat, 2)}</td><td>${esc(c.devise)}</td><td class="num">${fmt(c.remise_pct, 1)} %</td><td>${dateFr(c.date_effet)}</td></tr>`).join('')}
        </table></div>` : '<p class="petite-note">Aucune condition enregistrée.</p>'}
      </div>
      <div class="carte">
        <h3>Historique des modifications</h3>
        ${(a.historique || []).length ? `<div class="table-defilante" style="max-height:260px;overflow-y:auto"><table>
          <tr><th>Date</th><th>Champ</th><th>Avant</th><th>Après</th><th>Source</th></tr>
          ${a.historique.map(h => `<tr><td>${dateFr(h.date_modif)}</td><td>${esc(h.champ)}</td><td>${esc(h.ancienne_valeur ?? '')}</td><td>${esc(h.nouvelle_valeur ?? '')}</td><td><span class="badge ${h.source === 'dossier' ? 'orange' : 'gris'}">${esc(h.source)}</span></td></tr>`).join('')}
        </table></div>` : '<p class="petite-note">Aucune modification tracée.</p>'}
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
            <button id="s-lancer">Simuler</button>
          </div>
          <div id="s-resultat"></div>
        </div>`;
      document.getElementById('s-lancer').onclick = async () => {
        try {
          const r = await api('/douane/simulation', { method: 'POST', body: { valeur_en_douane: val('s-vd'), position_tarifaire: val('s-pos'), origine: val('s-ori') } });
          document.getElementById('s-resultat').innerHTML = `
            ${r.position ? `<p>Position <b>${esc(r.position.code)}</b> — ${esc(r.position.libelle)} (droit de douane ${fmt(r.position.taux_dd, 1)} %)</p>` : '<p class="message info">Position inconnue du référentiel : droit de douane à 0 %, seules les taxes à taux fixe sont calculées.</p>'}
            <div class="table-defilante"><table>
              <tr><th>Taxe</th><th class="num">Base</th><th class="num">Taux</th><th class="num">Montant</th><th>Traitement</th></tr>
              ${r.lignes.map(l => `<tr><td>${esc(l.code)} — ${esc(l.libelle)}</td><td class="num">${fcfa(l.base)}</td><td class="num">${fmt(l.taux, 2)} %</td><td class="num">${fcfa(l.montant)}</td>
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
        <div class="message info">La distinction coût / créance sur l'État est portée par le paramétrage de chaque taxe — règle la plus critique de la plateforme (CDC §6.3). La base est exprimée en composants : VD (valeur en douane) et codes des taxes déjà calculées, séparés par « + ».</div>
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
        <label class="champ">Fournisseur<select id="do-fourn"><option value="">—</option>${fournisseurs.map(f => `<option value="${esc(f.code)}">${esc(f.nom)}</option>`).join('')}</select></label>
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
        <td><b>${esc(d.reference)}</b></td><td>${esc(d.libelle || '')}</td><td>${esc(d.fournisseur_nom || '')}</td>
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
    <p class="sous-titre">${esc(d.libelle || '')} — ${esc(d.fournisseur_nom || 'fournisseur non renseigné')} — devise ${esc(d.devise)} (taux ${fmt(d.taux_change, 4)})
      ${d.poids_total ? ' — poids BL ' + fmt(d.poids_total) + ' kg' : ''}${d.volume_total ? ' — volume BL ' + fmt(d.volume_total, 2) + ' m³' : ''}</p>
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
            <td class="num">${l.declaration_rang ?? '<span class="badge rouge">—</span>'}</td>
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
          <h3>Importer la facture fournisseur (CSV) — appariement automatique par code barres</h3>
          <p class="petite-note">Colonnes : code_barres (ou code_interne);libelle;quantite;prix_unitaire;nb_cartons;poids_brut;volume;declaration_rang</p>
          <textarea id="l-csv"></textarea>
          <div class="actions-page">
            <label><input type="checkbox" id="l-remplacer"> Remplacer les lignes existantes</label>
            <button id="l-importer">Importer</button>
            <button class="secondaire" id="l-rattacher">Rattacher automatiquement à la déclaration</button>
          </div>
          <div id="l-msg"></div>
        </div>`;
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
      document.getElementById('l-importer').onclick = async () => {
        try {
          const r = await api(`/dossiers/${id}/lignes-import/csv`, { method: 'POST', body: { contenu: val('l-csv'), remplacer: coche('l-remplacer') } });
          message('l-msg', 'ok', `${r.importees} ligne(s) importée(s), ${r.appariees} appariée(s) au référentiel, ${r.non_appariees} sans correspondance, ${r.rejets.length} rejet(s).`);
          setTimeout(rendre, 1200);
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
          <span class="petite-note">La simulation reproduit le calcul de la Douane. Les montants réels saisis priment toujours.</span>
        </div>
        <div id="de-msg"></div>
        ${d.declaration.map(a => {
          const taxes = a.taxes || [];
          const totalCout = taxes.reduce((s, t) => s + Number(t.montant), 0);
          return `<div class="carte">
            <h3>Article n°${a.rang} — position ${esc(a.position_tarifaire)} ${a.origine ? '(origine ' + esc(a.origine) + ')' : ''}</h3>
            <p>${esc(a.designation || '')} — valeur CAF déclarée : <b>${fcfa(a.valeur_caf)}</b>${a.poids_brut ? ' — poids ' + fmt(a.poids_brut) + ' kg' : ''}</p>
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
            <td><button class="petit danger" onclick="supprPiece(${p.id})">✕</button></td></tr>`).join('') || '<tr><td colspan="7">Aucune pièce rattachée.</td></tr>'}
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
      document.getElementById('pi-ajouter').onclick = async () => {
        await api(`/dossiers/${id}/pieces`, { method: 'POST', body: { type_piece: val('pi-type'), reference: val('pi-ref'), date_piece: val('pi-date') || null, montant: val('pi-montant'), devise: val('pi-devise'), commentaire: val('pi-com') } });
        rendre();
      };
    } else if (o === 'resultats') {
      c.innerHTML = `
        <div class="actions-page">
          <button id="r-calculer">Calculer le coût de revient débarqué</button>
          <button class="secondaire" id="r-export">Exporter les coûts (CSV)</button>
          <button class="secondaire" id="r-ecritures">Écritures comptables (CSV)</button>
        </div>
        <div id="r-msg"></div>
        <div id="r-tableau">${tableauResultats(d.resultats)}</div>`;
      document.getElementById('r-calculer').onclick = async () => {
        try {
          const r = await api(`/dossiers/${id}/calculer`, { method: 'POST' });
          let html = `<div class="message ok">Calcul effectué. Coefficient moyen : <b>${fmt(r.totaux.coefficient_moyen, 3)}</b> — coût total ${fcfa(r.totaux.cout_total)} pour ${fcfa(r.totaux.valeur_achat)} d'achats. Créances sur l'État : ${fcfa(r.totaux.taxes_creance)}. ${r.articles_enrichis} fiche(s) article enrichie(s).</div>`;
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
          <td>${esc(x.article_code || '—')}</td><td class="num">${fmt(x.quantite)}</td>
          <td class="num">${fcfa(x.prix_achat_total)}</td><td class="num">${fcfa(x.cout_total)}</td>
          <td class="num"><b>${fmt(x.cout_unitaire, 2)}</b></td>
          <td class="num">${fmt(x.coefficient, 3)}</td>
          <td class="num">${x.taux_effectif !== null ? fmt(x.taux_effectif, 1) + ' %' : '—'}</td>
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
        <div class="message info">Résolution : le niveau le plus fin l'emporte — article &gt; famille+format &gt; famille &gt; format &gt; défaut (20 %).</div>
        <div class="table-defilante"><table>
          <tr><th>Famille</th><th>Format</th><th class="num">Taux de marque cible</th><th class="num">Plancher</th><th>Mode d'arbitrage</th><th class="num">Indice cible</th><th class="num">Encadrement</th><th></th></tr>
          ${pols.map(p => `<tr><td>${esc(p.famille_code || 'toutes')}</td><td>${esc(p.format_code || 'tous')}</td>
            <td class="num">${fmt(p.taux_marque_cible, 1)} %</td><td class="num">${fmt(p.taux_marque_plancher, 1)} %</td>
            <td><span class="badge bleu">${esc(p.mode_arbitrage)}</span></td>
            <td class="num">${p.indice_cible ? fmt(p.indice_cible, 1) : '—'}</td>
            <td class="num">${p.encadrement_pct ? '±' + fmt(p.encadrement_pct, 1) + ' %' : '—'}</td>
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
          <h3>Générer des propositions <span class="petite-note">— coût de mise en rayon → marge cible → confrontation au marché</span></h3>
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
                <td class="num">${p.prix_marche ? fcfa(p.prix_marche) : '—'}</td>
                <td class="num"><b>${fcfa(p.prix_ttc_propose)}</b></td>
                <td class="num">${p.taux_marque !== null ? fmt(p.taux_marque, 1) + ' %' : '—'}</td>
                <td class="num">${p.indice_vs_marche ? fmt(p.indice_vs_marche, 1) : '—'}</td>
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
            message('pr-msg', 'ok', `${rr.crees} proposition(s) enregistrée(s) — à valider dans l'onglet « Tarifs & validation ».`);
          };
        } catch (e) { message('pr-msg', 'erreur', e.message); }
      };
    } else if (o === 'tarifs') {
      const tarifs = await api('/tarification/tarifs');
      const badge = s => ({ propose: 'bleu', valide: 'orange', publie: 'vert', refuse: 'rouge', annule: 'gris', remplace: 'gris' }[s] || 'gris');
      c.innerHTML = `
        <div class="actions-page">
          <button id="ta-publier" ${etat.utilisateur.role === 'admin' || etat.utilisateur.role === 'direction' ? '' : 'disabled title="Rôle direction requis"'}>Publier la sélection</button>
          <button class="secondaire" id="ta-export">Exporter les tarifs publiés (CSV → ERP/caisse)</button>
        </div>
        <div id="ta-msg"></div>
        <div class="table-defilante"><table>
          <tr><th></th><th>Article</th><th>Format</th><th class="num">Prix TTC</th><th class="num">Prix HT</th><th class="num">Taux de marque</th>
          <th>Contrainte</th><th>Statut</th><th>Date d'effet</th><th>Alerte</th><th>Auteur</th></tr>
          ${tarifs.map(t => `<tr>
            <td>${['propose', 'valide'].includes(t.statut) ? `<input type="checkbox" class="ta-coche" value="${t.id}">` : ''}</td>
            <td>${esc(t.article_code)}<br><span class="petite-note">${esc(t.article_libelle)}</span></td>
            <td>${esc(t.format_code)}</td><td class="num"><b>${fcfa(t.prix_ttc)}</b></td><td class="num">${fmt(t.prix_ht, 1)}</td>
            <td class="num">${t.taux_marque !== null ? fmt(t.taux_marque, 1) + ' %' : '—'}</td>
            <td>${t.contrainte ? `<span class="badge gris">${esc(t.contrainte)}</span>` : ''}</td>
            <td><span class="badge ${badge(t.statut)}">${esc(t.statut)}</span></td>
            <td>${dateFr(t.date_effet)}</td>
            <td>${t.alerte ? `<span class="badge rouge" title="${esc(t.alerte)}">⚠</span>` : ''}</td>
            <td class="petite-note">${esc(t.auteur || '')}</td>
          </tr>`).join('') || '<tr><td colspan="11">Aucun tarif.</td></tr>'}
        </table></div>`;
      document.getElementById('ta-export').onclick = () => telecharger('/tarification/tarifs-export/csv', 'tarifs_publies.csv');
      document.getElementById('ta-publier').onclick = async () => {
        const ids = [...document.querySelectorAll('.ta-coche:checked')].map(x => Number(x.value));
        if (!ids.length) { message('ta-msg', 'erreur', 'Aucun tarif sélectionné.'); return; }
        try {
          const r = await api('/tarification/tarifs-publier-lot', { method: 'POST', body: { ids } });
          message('ta-msg', 'ok', `${r.publies} tarif(s) publié(s). Le tarif précédent de chaque article/format a été remplacé.`);
          setTimeout(() => afficher('tarifs'), 1200);
        } catch (e) { message('ta-msg', 'erreur', e.message); }
      };
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
      c.innerHTML = `
        <div class="carte">
          <h3>Relevé de prix concurrent</h3>
          <div class="ligne-champs">
            <label class="champ">Code barres *<input id="rv-cb" placeholder="scanner ou saisir"></label>
            <label class="champ">Enseigne<select id="rv-enseigne">${enseignes.map(e => `<option value="${esc(e.code)}">${esc(e.nom)}</option>`).join('')}</select></label>
            <label class="champ">Point de relevé<input id="rv-point" placeholder="magasin / site"></label>
            <label class="champ">Prix TTC (F CFA) *<input id="rv-prix" type="number"></label>
            <label class="champ">Type<select id="rv-type"><option value="fond_de_rayon">Fond de rayon</option><option value="promotion">Promotion</option></select></label>
            <label class="champ">Disponibilité<select id="rv-dispo"><option value="disponible">Disponible</option><option value="rupture">Rupture</option><option value="non_reference">Non référencé</option></select></label>
            <label class="champ">Date<input id="rv-date" type="date"></label>
            <button id="rv-enregistrer">Enregistrer le relevé</button>
          </div>
          <div id="rv-msg"></div>
        </div>`;
      document.getElementById('rv-enregistrer').onclick = async (ev, forcer = false) => {
        try {
          const r = await api('/veille/releves', {
            method: 'POST',
            body: { code_barres: val('rv-cb'), enseigne_code: val('rv-enseigne'), point_de_releve: val('rv-point'), prix_ttc: val('rv-prix'), type_prix: val('rv-type'), disponibilite: val('rv-dispo'), date_releve: val('rv-date') || null, confirmer_aberrant: forcer }
          });
          message('rv-msg', 'ok', r.apparie ? `Relevé enregistré et apparié à ${r.article_code}.` : 'Relevé enregistré — non apparié, à traiter dans la file d\'appariement.');
          document.getElementById('rv-cb').value = ''; document.getElementById('rv-prix').value = '';
        } catch (e) {
          if (e.statut === 409) {
            message('rv-msg', 'erreur', e.message + ' ');
            const b = document.createElement('button'); b.className = 'petit'; b.textContent = 'Confirmer malgré tout';
            b.onclick = () => document.getElementById('rv-enregistrer').onclick(null, true);
            document.getElementById('rv-msg').firstChild.appendChild(b);
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
          <h3>Import de relevés (format Annexe C — panel, collecte en ligne ou terrain)</h3>
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
            ${ind.syntheses.map(s => `<div class="carte"><div class="valeur ${s.indice_moyen > 102 ? 'alerte-rouge' : ''}">${fmt(s.indice_moyen, 1)}</div>
              <div class="libelle">${esc(s.enseigne)} — ${s.nb_references} référence(s) comparée(s)</div></div>`).join('') || '<p class="petite-note">Aucune comparaison possible : publiez des tarifs et enregistrez des relevés appariés.</p>'}
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
              <td>${Number(x.age_jours) > 45 ? `<span class="badge rouge">${x.age_jours} j — périmé</span>` : `<span class="badge vert">${x.age_jours} j</span>`}</td></tr>`).join('') || '<tr><td colspan="6">Aucune donnée.</td></tr>'}
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
          <p class="petite-note">Paramètres reconnus : <code>ratio_unite_payante</code> (tonnes pour 1 m³, défaut 1), <code>devise_reference</code>, <code>entreprise</code>.</p>
        </div>`;
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
        <div class="table-defilante"><table>
          <tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Objet</th><th>Identifiant</th><th>Détail</th></tr>
          ${journal.map(j => `<tr><td>${new Date(j.date_action).toLocaleString('fr-FR')}</td><td>${esc(j.utilisateur || '')}</td>
            <td><span class="badge gris">${esc(j.action)}</span></td><td>${esc(j.objet_type)}</td>
            <td>${esc(j.objet_id || '')}</td><td class="petite-note">${esc(j.detail || '')}</td></tr>`).join('')}
        </table></div>`;
    }
  }
  await afficher('utilisateurs');
}

/* ---------------------------------- Démarrage ---------------------------------- */
window.naviguer = naviguer;
window.deconnexion = deconnexion;
rendre();
