import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data.sqlite');

sqlite3.verbose();
const db = new sqlite3.Database(dbPath);

// Initialize tables
const init = () => {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`);

    db.run(`CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );`);

    db.run(`CREATE TABLE IF NOT EXISTS route (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq INTEGER,
      name TEXT,
      lat REAL,
      lng REAL
    );`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_route_seq ON route(seq);`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_route_name ON route(name);`);

    // Données de départ
    const startTime = '2025-09-08T16:15:00+02:00';
    const startPlace = 'Radisson Blu, Montpellier';
  // Coordonnées précises mises à jour du Radisson Blu Montpellier
  const startLat = 43.6129535885483;
  const startLng = 3.8839984003394976;

    db.run(`INSERT OR IGNORE INTO meta(key,value) VALUES ('start_time', ?);`, [startTime]);
    db.run(`INSERT OR IGNORE INTO meta(key,value) VALUES ('start_place', ?);`, [startPlace]);
  // Upsert des métadonnées de latitude/longitude de départ
  db.run(`INSERT INTO meta(key,value) VALUES ('start_lat', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`, [String(startLat)]);
  db.run(`INSERT INTO meta(key,value) VALUES ('start_lng', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`, [String(startLng)]);

    // Parcours planifié (approx villages / villes - peut être affiné)
    const planned = [
      ['Montpellier (Radisson Blu)', startLat, startLng],
      ['Lunel', 43.6776, 4.1351],
      ['Nîmes', 43.8367, 4.3601],
      ['Remoulins', 43.9406, 4.5606],
      ['Avignon', 43.9493, 4.8055],
      ['Orange', 44.1381, 4.8079],
      ['Montélimar', 44.5558, 4.7500],
      ['Valence', 44.9334, 4.8924],
      ['Vienne', 45.5245, 4.8730],
      ['Lyon', 45.7640, 4.8357],
      ['Villefranche-sur-Saône', 45.9894, 4.7186],
      ['Mâcon', 46.3069, 4.8280],
      ['Tournus', 46.5679, 4.9073],
      ['Chalon-sur-Saône', 46.7800, 4.8527],
      ['Beaune', 47.0260, 4.8400],
      ['Nuits-Saint-Georges', 47.1376, 4.9506],
      ['Dijon', 47.3220, 5.0415],
      ['Montbard', 47.6231, 4.3382],
      ['Tonnerre', 47.8554, 3.9732],
      ['Chablis', 47.8131, 3.7984],
      ['Joigny', 47.9814, 3.3987],
      ['Sens', 48.1975, 3.2830],
      ['Montereau-Fault-Yonne', 48.3835, 2.9577],
      ['Fontainebleau', 48.4047, 2.7016],
      ['Melun', 48.5393, 2.6596],
      ['Brunoy', 48.6990, 2.4924],
      ['Paris (Arrivée)', 48.8566, 2.3522]
    ];

    planned.forEach((p, i) => {
      db.run(`INSERT OR IGNORE INTO route(seq,name,lat,lng) VALUES (?,?,?,?)`, [i, p[0], p[1], p[2]]);
    });

    // Insérer un point de départ dans positions si table vide
    db.get('SELECT COUNT(*) as c FROM positions', (err, row) => {
      if(!err && row && row.c === 0) {
        db.run('INSERT INTO positions(streamer,lat,lng,created_at) VALUES (?,?,?,?)', ['Team', startLat, startLng, startTime]);
      }
    });

    // Migration légère : corriger route seq=0 si ancienne valeur
    db.run('UPDATE route SET lat=?, lng=? WHERE seq=0', [startLat, startLng]);

    // Mettre à jour le premier point existant s'il correspond aux anciennes coordonnées approximatives
    const oldLat = 43.6035, oldLng = 3.8826;
    db.get('SELECT id,lat,lng FROM positions ORDER BY id ASC LIMIT 1', (e,r) => {
      if(!e && r) {
        if(Math.abs(r.lat - oldLat) < 0.0005 && Math.abs(r.lng - oldLng) < 0.0005) {
          db.run('UPDATE positions SET lat=?, lng=? WHERE id=?', [startLat, startLng, r.id]);
        }
      }
    });

    // Code admin par défaut (à changer via variable d'environnement si besoin)
    db.run(`INSERT OR IGNORE INTO meta(key,value) VALUES ('admin_code', ?)`, ['secure123']);
  });
};

// Vérifier / ajouter colonne arrival_time si manquante
db.all("PRAGMA table_info(route)", (err, columns) => {
  if(!err) {
    const hasArrival = columns.some(c => c.name === 'arrival_time');
    if(!hasArrival) {
      db.run('ALTER TABLE route ADD COLUMN arrival_time TEXT', (e) => {
        if(e) console.error('Erreur ajout arrival_time:', e.message);
      });
    }
  }
});

init();

export default db;
