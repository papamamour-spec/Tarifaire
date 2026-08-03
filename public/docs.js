'use strict';
/* Rendu de la documentation d'API depuis /api/docs (aucune dépendance externe). */
(async function () {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const conteneur = document.getElementById('contenu');
  try {
    const spec = await (await fetch('/api/docs')).json();
    const groupes = {};
    for (const [chemin, infos] of Object.entries(spec.chemins)) {
      const segment = chemin.split('/')[2] || 'autre';
      (groupes[segment] = groupes[segment] || []).push([chemin, infos]);
    }
    conteneur.innerHTML = `
      <div class="carte"><p>${esc(spec.info.description)}</p>
      <p><b>Authentification :</b> <code>${esc(spec.securite)}</code></p></div>
      ${Object.entries(groupes).map(([groupe, routes]) => `
        <h2 style="text-transform:capitalize">${esc(groupe)}</h2>
        <div class="table-defilante"><table>
          <tr><th>Route</th><th>Description</th><th>Rôle minimal</th><th>Corps</th></tr>
          ${routes.map(([chemin, infos]) => `<tr>
            <td><code>${esc(chemin)}</code></td>
            <td>${esc(infos.resume)}</td>
            <td><span class="badge bleu">${esc(infos.role_minimum)}</span></td>
            <td>${infos.corps ? `<code>${esc(infos.corps)}</code>` : ''}</td>
          </tr>`).join('')}
        </table></div>`).join('')}`;
  } catch (e) {
    conteneur.innerHTML = `<div class="message erreur">Impossible de charger la documentation : ${esc(e.message)}</div>`;
  }
})();
