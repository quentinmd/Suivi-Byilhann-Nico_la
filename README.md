# Suivi Montpellier - Paris (Byilhann & Nico_la)

Petite application pour afficher en direct le parcours à pied de Montpellier à Paris, en passant par les petits villages.

## Démarrage

### Backend
```bash
cd server
npm install
npm run start
```
Le serveur tourne sur `http://localhost:4000`.

### Frontend
Ouvrez simplement le fichier `web/index.html` dans votre navigateur (double-clic) ou servez le via une extension Live Server.

Page admin pour ajouter des positions : `web/admin.html`.

## Endpoints API
- `GET /api/start` : infos de départ (heure, lieu, coords)
- `GET /api/positions` : liste chronologique des positions réelles
- `POST /api/positions` : `{ lat, lng }` ajout manuel
- `POST /api/positions/by-place` : `{ name }` ajoute un point en cherchant le lieu dans le parcours planifié
- `GET /api/route` : parcours planifié (liste ordonnée de lieux)
 - `POST /api/route/arrival` : `{ name, time }` enregistre l'heure d'arrivée sur un lieu (time = HH:MM ou ISO)

## Données de départ
- Heure de départ : 8 septembre 2025 16h15 (Europe/Paris)
- Lieu : Radisson Blu, Montpellier

## Améliorations possibles
- Auth (token) sur l'admin
 - Changer dynamiquement le code admin (endpoint de rotation)
- Filtre par date / segment
- Export GPX ou CSV
- Distance totale + estimation temps restant
- Mode offline (cache localStorage)

## Déploiement (GitHub + Render)

### 1. Préparer le dépôt Git
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin <URL_DU_REPO>
git push -u origin main
```

### 2. Services Render

Backend (Web Service):
- Root directory: `server`
- Build command: `npm install`
- Start command: `npm start`
- Environment variables à ajouter: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`.

Frontend (Static Site):
- Root directory: `web`
- Pas de build (laisser vide)
- Publish directory: `web`

Ajouter une règle de réécriture (Static Site -> Redirects/Rewrites) si on veut utiliser des chemins relatifs `/api`:
```
/api/*    https://<NOM_DU_SERVICE_BACK>.onrender.com/api/:splat   rewrite
```
Sinon, modifier `API_BASE` dans `web/index.html` pour pointer directement vers l'URL du backend public.

### 3. Base de données persistante (Optionnel)
SQLite sur Render est volatile. Pour la persistance réelle, remplacer SQLite par PostgreSQL:
- Créer une instance PostgreSQL Render
- Adapter le code `db.js` (sequelize ou pg) et effectuer une migration.

### 4. Variables sensibles
Ne jamais committer `.env`. Le secret Twitch doit être régénéré si exposé.

### 5. Mise à jour continue
Chaque push sur `main` déclenche un redeploy Render (si connecté). Pour déploiements préprod, utiliser une branche staging.

