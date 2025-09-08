# Intégration statut Twitch

1. Crée une application sur https://dev.twitch.tv/console/apps
2. Copie Client ID et génère un Client Secret.
3. Dans le dossier `server/`, crée un fichier `.env` en t'inspirant de `.env.example` :
```
TWITCH_CLIENT_ID=xxxxxxxxxxxx
TWITCH_CLIENT_SECRET=yyyyyyyyyyyy
PORT=4000
```
4. Installe les dépendances si pas déjà fait:
```
npm install
```
5. Lance le serveur:
```
npm start
```
6. La page web appellera `/api/twitch-status` et affichera LIVE + viewers.

Notes:
- Cache 60s.
- Si credentials absents: Hors ligne.
- Si token invalide: il est regénéré automatiquement.
