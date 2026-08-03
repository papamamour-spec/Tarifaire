'use strict';
/* Lot 1 : en-têtes de sécurité HTTP et limitation de débit en mémoire. */

function entetesSecurite(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self)');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'");
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/*
 * Limiteur à fenêtre glissante en mémoire, par IP.
 * Suffisant pour un service mono-réplique ; nettoie ses compteurs périodiquement.
 */
function limiteurDebit({ fenetreMs, maximum, message }) {
  const compteurs = new Map();
  setInterval(() => {
    const seuil = Date.now() - fenetreMs;
    for (const [cle, dates] of compteurs) {
      const restantes = dates.filter(t => t > seuil);
      if (restantes.length) compteurs.set(cle, restantes);
      else compteurs.delete(cle);
    }
  }, fenetreMs).unref();

  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    const maintenant = Date.now();
    const dates = (compteurs.get(ip) || []).filter(t => t > maintenant - fenetreMs);
    if (dates.length >= maximum) {
      res.setHeader('Retry-After', Math.ceil(fenetreMs / 1000));
      return res.status(429).json({ erreur: message || 'Trop de requêtes, réessayez plus tard' });
    }
    dates.push(maintenant);
    compteurs.set(ip, dates);
    next();
  };
}

module.exports = { entetesSecurite, limiteurDebit };
