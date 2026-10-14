#!/bin/bash
# NEON DASH — déploiement : copie les fichiers vers le webroot nginx + redémarre le serveur MP.
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST=/var/www/html/neon
cp "$SRC"/{index.html,game.js,style.css,manifest.webmanifest} "$DST"/
cp -r "$SRC"/icons "$DST"/
# Cache-busting : tampon unique par déploiement, injecté dans la copie webroot
# (le dépôt garde le token ?v=DEV). Force le navigateur à recharger game.js/style.css.
STAMP=$(date +%s)
sed -i "s/game\.js?v=[0-9A-Za-z]*/game.js?v=$STAMP/; s/style\.css?v=[0-9A-Za-z]*/style.css?v=$STAMP/" "$DST"/index.html
pm2 restart neon-dash
echo "Déployé sur $DST (v=$STAMP) + serveur multijoueur redémarré."
