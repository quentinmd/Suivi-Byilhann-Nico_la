import express from 'express';
import cors from 'cors';
import db from './db.js';
import fetch from 'node-fetch';
import 'dotenv/config';
import { firestore, makeTimestamp, firebaseDebug } from './firebase.js';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 4000;

// Static website (serve web/ from the same server to have one single domain)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, '../../web');
app.use(express.static(webDir, { extensions: ['html'] }));
app.get('/', (req,res)=> res.sendFile(path.join(webDir, 'index.html')));
app.get('/admin', (req,res)=> res.sendFile(path.join(webDir, 'admin.html')));
app.get('/healthz', (req,res)=> res.json({ ok:true }));

// Override éventuel du code admin via variable d'environnement
if(process.env.ADMIN_CODE) {
  // Met à jour / insère le code admin avant tout traitement
  try {
    db.run('INSERT INTO meta(key,value) VALUES ("admin_code", ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [process.env.ADMIN_CODE]);
    console.log('[Admin] Code admin défini via ADMIN_CODE (env)');
  } catch(e){ console.warn('[Admin] Impossible de définir ADMIN_CODE:', e.message); }
}
// Config Twitch via variables d'environnement (à définir avant lancement)
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
if(!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET){
  console.log('[Twitch] Credentials manquants ou incomplets. ID chargé =', !!TWITCH_CLIENT_ID, 'Secret présent =', !!TWITCH_CLIENT_SECRET);
} else {
  console.log('[Twitch] Credentials chargés (ID ok, secret ok)');
}
const TWITCH_USER_LOGIN = 'byilhann';
let twitchCache = { ts:0, data:null };
let twitchTokenInfo = { token:null, exp:0 };
async function getTwitchToken(){
  if(!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
  const now = Date.now();
  if(twitchTokenInfo.token && now < twitchTokenInfo.exp - 60_000) return twitchTokenInfo.token;
  const url = `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`;
  const r = await fetch(url, {method:'POST'});
  if(!r.ok) throw new Error('OAuth Twitch failed');
  const j = await r.json();
  twitchTokenInfo = { token: j.access_token, exp: now + (j.expires_in*1000) };
  return twitchTokenInfo.token;
}
async function fetchTwitchStatus(){
  try {
    if(!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return {live:false, reason:'NO_CREDENTIALS'};
    const now = Date.now();
    if(twitchCache.data && (now - twitchCache.ts) < 60_000) return twitchCache.data; // cache 60s
    const token = await getTwitchToken();
    if(!token) return {live:false, reason:'TOKEN'};
    const r = await fetch(`https://api.twitch.tv/helix/streams?user_login=${TWITCH_USER_LOGIN}`, {
      headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` }
    });
    if(!r.ok) throw new Error('Helix error');
    const j = await r.json();
    const stream = j.data && j.data[0];
  const data = stream ? {live:true, viewers: stream.viewer_count, title: stream.title, started_at: stream.started_at} : {live:false};
    twitchCache = {ts: now, data};
    return data;
  } catch(e){
    return {live:false, error: e.message};
  }
}

// ---- DB helpers ----
const all = (sql, params=[]) => new Promise((res,rej)=> db.all(sql, params, (e,r)=> e?rej(e):res(r)));
const get = (sql, params=[]) => new Promise((res,rej)=> db.get(sql, params, (e,r)=> e?rej(e):res(r)));
const run = (sql, params=[]) => new Promise((res,rej)=> db.run(sql, params, function(e){ e?rej(e):res(this); }));

// ---- Firestore helpers ----
const USE_FIRESTORE = (process.env.USE_FIRESTORE || '').toLowerCase() === 'true';
const ORS_KEY = process.env.OPENROUTESERVICE_API_KEY || '';
const WALKING_SEGMENTS = (process.env.WALKING_SEGMENTS || 'true').toLowerCase() === 'true';
const WALKING_MAX_SEGMENTS = Math.max(5, parseInt(process.env.WALKING_MAX_SEGMENTS || '40', 10));
const isFirestoreReady = () => !!(USE_FIRESTORE && firestore && typeof firestore.collection === 'function');
const shouldFsFallback = (err) => {
  try {
    const msg = String(err && (err.message || err)).toLowerCase();
    return msg.includes('unauthenticated') || msg.includes('permission') || msg.includes('credential');
  } catch { return false; }
};

// Fetch avec timeout pour éviter les requêtes pendantes
async function fetchWithTimeout(url, options={}, timeoutMs=10000){
  const controller = new AbortController();
  const id = setTimeout(()=> controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    return r;
  } finally { clearTimeout(id); }
}

function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371; const toRad = d=> d*Math.PI/180;
  const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
const WALKING_AVOID_PAVED = (process.env.WALKING_AVOID_PAVED || 'true').toLowerCase() === 'true';

// ---- Normalisation de dates (Europe/Paris) ----
function ensureParisISOFromAny(input){
  try {
    if(!input || typeof input !== 'string') return null;
    const s = input.trim();
    // Cas déjà ISO avec timezone (Z ou +hh:mm)
    if(/T/.test(s) && /(Z|[+-][0-9]{2}:[0-9]{2})$/.test(s)) return s;
    // Extraire composantes Y-M-D H:M(:S)?
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/);
    if(m){
      const [_, y, mo, d, hh, mm, ss] = m; // eslint-disable-line no-unused-vars
      const sec = ss || '00';
      const offset = parisOffsetForDate(`${y}-${mo}-${d}`);
      return `${y}-${mo}-${d}T${hh}:${mm}:${sec}${offset}`;
    }
    // Dernier recours: laisser le parseur Date gérer, puis re-émettre en ISO local Paris
    const dt = new Date(s);
    if(!isNaN(dt.getTime())){
      const y = dt.getUTCFullYear();
      const mo = String(dt.getUTCMonth()+1).padStart(2,'0');
      const d = String(dt.getUTCDate()).padStart(2,'0');
      const hh = String(dt.getUTCHours()).padStart(2,'0');
      const mm = String(dt.getUTCMinutes()).padStart(2,'0');
      const ss = String(dt.getUTCSeconds()).padStart(2,'0');
      const offset = parisOffsetForDate(`${y}-${mo}-${d}`);
      return `${y}-${mo}-${d}T${hh}:${mm}:${ss}${offset}`;
    }
    return null;
  } catch { return null; }
}

async function getWalkingRoute(aLat,aLng,bLat,bLng, opts={}){
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 9000;
  if(ORS_KEY){
    try {
      const r = await fetchWithTimeout('https://api.openrouteservice.org/v2/directions/foot-walking/geojson', {
        method:'POST', headers:{'Authorization': ORS_KEY,'Content-Type':'application/json'},
        body: JSON.stringify({
          coordinates: [[aLng, aLat], [bLng, bLat]],
          instructions: false,
          preference: 'shortest',
          options: {
    avoid_features: ['highways', 'fords', 'steps', 'tracks', 'unpavedroads']
          }
        })
      }, timeoutMs);
      if(!r.ok) throw new Error('ORS failed '+r.status);
      const j = await r.json();
      const feat = (j.features && j.features[0]) || null; if(!feat) throw new Error('ORS no route');
      const coords = feat.geometry.coordinates; // [lng,lat]
      const seg = feat.properties && feat.properties.segments && feat.properties.segments[0];
      return { geometry: { type:'LineString', coordinates: coords }, distance_km: seg? seg.distance/1000 : null, duration_min: seg? seg.duration/60 : null, source:'ors' };
    } catch(_){ /* fallback OSRM */ }
  }
  const url = `https://router.project-osrm.org/route/v1/foot/${aLng},${aLat};${bLng},${bLat}?overview=full&geometries=geojson`;
  const r = await fetchWithTimeout(url, {}, timeoutMs);
  if(!r.ok) throw new Error('OSRM failed');
  const j = await r.json();
  const route = j.routes && j.routes[0]; if(!route) throw new Error('OSRM no route');
  return { geometry: route.geometry, distance_km: route.distance/1000, duration_min: route.duration/60, source:'osrm' };
}

async function fs_addWalkingSegmentForNewPosition(newDoc){
  if(!WALKING_SEGMENTS) return;
  try {
    // Récupérer les deux dernières positions (desc)
  let coll = firestore.collection('positions');
  try { coll = coll.orderBy('created_at_ts','desc'); } catch { coll = coll.orderBy('created_at','desc'); }
  const snap = await coll.limit(2).get();
    if(snap.size < 2) return; // pas de segment
    const docs = snap.docs.map(d=> ({ id:d.id, ...d.data() }));
    const latest = docs.find(d=> d.id === newDoc.id) || docs[0];
    const other = docs.find(d=> d.id !== latest.id);
    if(!other) return;
    // Vérifier si segment existe déjà
    const segId = `${other.id}__${latest.id}`;
    const exists = await firestore.collection('segments').doc(segId).get();
    if(exists.exists) return;
    const route = await getWalkingRoute(other.lat, other.lng, latest.lat, latest.lng);
    await firestore.collection('segments').doc(segId).set({
      fromId: other.id,
      toId: latest.id,
      geometry: route.geometry,
      distance_km: route.distance_km,
      duration_min: route.duration_min,
      created_at: new Date().toISOString(),
      source: route.source
    });
  } catch(e){ console.warn('[Walking] segment error:', e.message); }
}
async function fs_addPosition(doc){
  const ref = firestore.collection('positions');
  const created_at = doc.created_at || new Date().toISOString();
  const payload = { streamer: 'Team', lat: doc.lat, lng: doc.lng, created_at, created_at_ts: makeTimestamp(created_at) };
  const saved = await ref.add(payload);
  return { id: saved.id, ...payload };
}
async function fs_listPositions(){
  let coll = firestore.collection('positions');
  try { coll = coll.orderBy('created_at_ts','asc'); } catch { coll = coll.orderBy('created_at','asc'); }
  const snap = await coll.get();
  return snap.docs.map(d=> ({ id: d.id, ...d.data() }));
}
async function fs_countPositions(){
  const snap = await firestore.collection('positions').limit(1).get();
  // Firestore JS SDK n'a pas de count serverless ici; fallback sur get() complet n'est pas souhaitable.
  // Approche: paginer ou estimer; pour simplicité, on lit IDs via page token short si besoin.
  // Ici, on utilisera une simple lecture limitée pour détecter collection vide ou non, et comparer via seuils.
  // On retourne -1 si inconnu.
  try {
    // Tentative de compter rapidement en lisant par petits lots (jusqu'à 1000 max par prudence)
    let last = null, count = 0;
    while(true){
      let q = firestore.collection('positions').orderBy('__name__').limit(500);
      if(last) q = q.startAfter(last);
      const s = await q.get();
      count += s.size; if(s.size < 500) break; last = s.docs[s.docs.length-1];
      if(count >= 5000) break; // garde-fou
    }
    return count;
  } catch { return -1; }
}
async function fs_getPosition(id){
  const doc = await firestore.collection('positions').doc(String(id)).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}
async function fs_updatePosition(id, fields){
  await firestore.collection('positions').doc(String(id)).set(fields, { merge: true });
}
async function fs_deletePosition(id){
  await firestore.collection('positions').doc(String(id)).delete();
}

// Auto-migration au démarrage si Firestore activé et incomplet
async function autoMigrateToFirestoreIfNeeded(){
  if(!USE_FIRESTORE || !firestore || typeof firestore.collection !== 'function') return;
  try {
    const sqlCountRow = await get('SELECT COUNT(*) AS c FROM positions');
    const sqlCount = (sqlCountRow && sqlCountRow.c) ? Number(sqlCountRow.c) : 0;
    const fsCount = await fs_countPositions();
    if(fsCount >= 0 && fsCount < sqlCount){
      console.log(`[Migrate] Firestore ${fsCount} < SQLite ${sqlCount} → migration des positions manquantes...`);
      const rows = await all('SELECT * FROM positions ORDER BY id ASC');
      let copied=0, skipped=0, failed=0;
      for(const row of rows){
        try {
          const docId = String(row.id);
          const exists = await firestore.collection('positions').doc(docId).get();
          if(exists.exists){ skipped++; continue; }
          const created_at = row.created_at || new Date().toISOString();
          await firestore.collection('positions').doc(docId).set({
            streamer: row.streamer || 'Team',
            lat: row.lat,
            lng: row.lng,
            created_at,
            created_at_ts: makeTimestamp(created_at)
          });
          copied++;
          // Eviter d'étrangler l'API
          if(copied % 50 === 0) await new Promise(r=> setTimeout(r, 60));
        } catch(e){ failed++; }
      }
      console.log(`[Migrate] Terminé: copied=${copied}, skipped=${skipped}, failed=${failed}`);
    } else {
      console.log('[Migrate] Aucune migration nécessaire (Firestore positions >= SQLite ou inconnu)');
    }
  } catch(e){ console.warn('[Migrate] Erreur auto-migration:', e.message); }
}

// ---- Timezone helpers (Europe/Paris) ----
function parisOffsetForDate(dateStr) {
  const [y,m,d] = dateStr.split('-').map(Number);
  const year = y;
  const lastSunday = (month) => {
    const firstNext = new Date(Date.UTC(year, month+1, 1));
    let cur = new Date(firstNext.getTime() - 86400000);
    while(cur.getUTCDay() !== 0) cur = new Date(cur.getTime() - 86400000);
    return cur; // UTC
  };
  const dstStart = lastSunday(2); // March
  const dstStartMs = Date.UTC(dstStart.getUTCFullYear(), dstStart.getUTCMonth(), dstStart.getUTCDate(), 1,0,0);
  const dstEnd = lastSunday(9); // October
  const dstEndMs = Date.UTC(dstEnd.getUTCFullYear(), dstEnd.getUTCMonth(), dstEnd.getUTCDate(), 1,0,0);
  const currentMs = Date.UTC(year, m-1, d, 12,0,0);
  return (currentMs >= dstStartMs && currentMs < dstEndMs) ? '+02:00' : '+01:00';
}
function buildParisISO(date, time) {
  const now = new Date();
  if(!date) date = now.toISOString().slice(0,10);
  if(!time) time = now.toISOString().slice(11,16);
  const offset = parisOffsetForDate(date);
  return `${date}T${time}:00${offset}`;
}

// ---- Auth middleware ----
async function checkAdmin(req,res,next){
  try {
    const code = req.header('X-Admin-Code') || req.body.adminCode || req.query.adminCode;
    if(!code) return res.status(401).json({error:'Code requis'});
    const row = await get('SELECT value FROM meta WHERE key="admin_code"');
    if(!row || row.value !== code) return res.status(403).json({error:'Code invalide'});
    next();
  } catch(e){ res.status(500).json({error:e.message}); }
}

// ---- Endpoints ----
app.get('/api/start', async (req,res)=> {
  try {
    const metaRows = await all('SELECT key,value FROM meta WHERE key IN ("start_time","start_place","start_lat","start_lng")');
    res.json(Object.fromEntries(metaRows.map(r=>[r.key,r.value])));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/verify', async (req,res)=>{
  try {
    const {code} = req.body;
    if(!code) return res.json({ok:false});
    const row = await get('SELECT value FROM meta WHERE key="admin_code"');
    res.json({ok: !!row && row.value === code});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/positions', async (req,res)=> {
  try {
    // Permettre de forcer SQLite même si USE_FIRESTORE=true (ex: ?source=sqlite)
    const src = String(req.query.source||'').toLowerCase();
    const forceSqlite = src==='sqlite' || src==='sql' || src==='db';

    if(USE_FIRESTORE && !forceSqlite){
      try {
        const rows = await fs_listPositions();
        // Harmoniser la forme: id numérique attendu côté front? On laisse tel quel.
        return res.json(rows.map(r=> ({ id: r.id, streamer: r.streamer, lat: r.lat, lng: r.lng, created_at: r.created_at })));
      } catch(err){
        // Fallback automobile en SQLite si Firestore échoue (ex: credentials manquants)
        console.warn('[GET /api/positions] Firestore indisponible, fallback SQLite:', err.message);
      }
    }
    // SQLite par défaut ou en fallback
    const rows = await all('SELECT * FROM positions ORDER BY id ASC');
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/positions', checkAdmin, async (req,res)=> {
  try {
    const {lat,lng,date,time} = req.body;
    if(lat==null || lng==null) return res.status(400).json({error:'Missing lat/lng'});
    let createdAt = null;
    if(date || time) {
      if(time && /^[0-9]{2}:[0-9]{2}$/.test(time)) createdAt = buildParisISO(date, time);
      else if(date && !time) createdAt = buildParisISO(date, null);
      else if(time && /T/.test(time)) createdAt = time; // assume iso
    }
    if(!createdAt) {
      // Uniformiser : toujours un ISO Europe/Paris
      createdAt = buildParisISO();
    }
    if(isFirestoreReady()){
      try {
        const saved = await fs_addPosition({lat, lng, created_at: createdAt});
        // tenter de créer un segment à pied (non bloquant)
        try { await fs_addWalkingSegmentForNewPosition(saved); } catch(_){ }
        return res.json({ok:true, created_at: saved.created_at, id: saved.id});
      } catch(err){
        if(!shouldFsFallback(err)) throw err;
        console.warn('[POST /api/positions] Firestore échec, fallback SQLite:', err.message);
      }
    }
    await run('INSERT INTO positions(streamer,lat,lng,created_at) VALUES (?,?,?,?)',['Team',lat,lng,createdAt]);
    res.json({ok:true, created_at: createdAt});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/positions/quick', checkAdmin, async (req,res)=> {
  try {
    const {lat,lng,date,time} = req.query;
    if(lat==null || lng==null) return res.status(400).json({error:'lat & lng requis'});
    let createdAt = null;
    if(date || time) {
      if(time && /^[0-9]{2}:[0-9]{2}$/.test(time)) createdAt = buildParisISO(date, time);
      else if(date && !time) createdAt = buildParisISO(date, null);
      else if(time && /T/.test(time)) createdAt = time;
    }
  if(!createdAt) createdAt = buildParisISO();
    if(isFirestoreReady()){
      try {
        const saved = await fs_addPosition({lat: parseFloat(lat), lng: parseFloat(lng), created_at: createdAt});
        try { await fs_addWalkingSegmentForNewPosition(saved); } catch(_){ }
        return res.json({ok:true, created_at: saved.created_at, id: saved.id});
      } catch(err){
        if(!shouldFsFallback(err)) throw err;
        console.warn('[GET /api/positions/quick] Firestore échec, fallback SQLite:', err.message);
      }
    }
    await run('INSERT INTO positions(streamer,lat,lng,created_at) VALUES (?,?,?,?)',['Team',parseFloat(lat),parseFloat(lng),createdAt]);
    res.json({ok:true, created_at: createdAt});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch('/api/positions/:id', checkAdmin, async (req,res)=> {
  try {
    const {id} = req.params; const {lat,lng,date,time} = req.body;
    if(isFirestoreReady()){
      try {
        const cur = await fs_getPosition(id);
        if(!cur) throw new Error('Not found');
        const newLat = lat!=null ? parseFloat(lat) : cur.lat;
        const newLng = lng!=null ? parseFloat(lng) : cur.lng;
        let createdAt = cur.created_at;
        if(date || time) {
          if(time && /^[0-9]{2}:[0-9]{2}$/.test(time)) createdAt = buildParisISO(date || (createdAt?createdAt.slice(0,10):null), time);
          else if(date && !time) {
            const oldTime = createdAt? createdAt.slice(11,16) : null;
            createdAt = buildParisISO(date, oldTime);
          } else if(time && /T/.test(time)) createdAt = time;
        }
        await fs_updatePosition(id, { lat:newLat, lng:newLng, created_at: createdAt });
        return res.json({ok:true,id,lat:newLat,lng:newLng,created_at:createdAt});
      } catch(err){
        if(!shouldFsFallback(err)) throw err;
        console.warn('[PATCH /api/positions/:id] Firestore échec, fallback SQLite:', err.message);
      }
    }
    const row = await get('SELECT * FROM positions WHERE id=?',[id]);
    if(!row) return res.status(404).json({error:'Not found'});
    const newLat = lat!=null ? parseFloat(lat) : row.lat;
    const newLng = lng!=null ? parseFloat(lng) : row.lng;
    let createdAt = row.created_at;
    if(date || time) {
      if(time && /^[0-9]{2}:[0-9]{2}$/.test(time)) createdAt = buildParisISO(date || (createdAt?createdAt.slice(0,10):null), time);
      else if(date && !time) {
        const oldTime = createdAt? createdAt.slice(11,16) : null;
        createdAt = buildParisISO(date, oldTime);
      } else if(time && /T/.test(time)) createdAt = time;
    }
    await run('UPDATE positions SET lat=?, lng=?, created_at=? WHERE id=?',[newLat,newLng,createdAt,id]);
    res.json({ok:true,id,lat:newLat,lng:newLng,created_at:createdAt});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/positions/:id', checkAdmin, async (req,res)=> {
  try {
    const {id} = req.params;
    if(isFirestoreReady()){
      try {
        const cur = await fs_getPosition(id);
        if(!cur) throw new Error('Not found');
        await fs_deletePosition(id);
        return res.json({ok:true});
      } catch(err){
        if(!shouldFsFallback(err)) throw err;
        console.warn('[DELETE /api/positions/:id] Firestore échec, fallback SQLite:', err.message);
      }
    }
    const row = await get('SELECT id FROM positions WHERE id=?',[id]);
    if(!row) return res.status(404).json({error:'Not found'});
    await run('DELETE FROM positions WHERE id=?',[id]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/positions/by-place', checkAdmin, async (req,res)=> {
  try {
    const {name} = req.body;
    if(!name) return res.status(400).json({error:'Missing name'});
    const r = await get('SELECT * FROM route WHERE LOWER(name)=LOWER(?)',[name]);
    if(!r) return res.status(404).json({error:'Lieu non trouvé dans le parcours'});
    const createdAt = buildParisISO();
    if(isFirestoreReady()){
      try {
        const saved = await fs_addPosition({ lat: r.lat, lng: r.lng, created_at: createdAt });
        try { await fs_addWalkingSegmentForNewPosition(saved); } catch(_){ }
        return res.json({ok:true, lat:r.lat, lng:r.lng, created_at: saved.created_at, id: saved.id});
      } catch(err){
        if(!shouldFsFallback(err)) throw err;
        console.warn('[POST /api/positions/by-place] Firestore échec, fallback SQLite:', err.message);
      }
    }
    await run('INSERT INTO positions(streamer,lat,lng,created_at) VALUES (?,?,?,?)',[ 'Team', r.lat, r.lng, createdAt]);
    res.json({ok:true, lat:r.lat, lng:r.lng, created_at: createdAt});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/route', async (req,res)=> {
  try { res.json(await all('SELECT * FROM route ORDER BY seq ASC')); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Walking track combiné (GeoJSON FeatureCollection) basé sur segments Firestore
app.get('/api/walking-track', async (req,res)=>{
  try {
  const src = String(req.query.source||'').toLowerCase();
  const forceSqlite = src==='sqlite' || src==='sql' || src==='db';
  const firestoreReady = !!(USE_FIRESTORE && firestore && typeof firestore.collection === 'function');
  if(firestoreReady && !forceSqlite){
      const wantFull = (String(req.query.full||'').toLowerCase()==='true') || (String(req.query.full||'')==='1');
      // 1) Tenter d'utiliser les segments persistés
      const snap = await firestore.collection('segments').orderBy('created_at','asc').get();
      let features = snap.docs.map(d=> ({ type:'Feature', properties:{ id: d.id, distance_km: d.get('distance_km'), duration_min: d.get('duration_min') }, geometry: d.get('geometry') }));
      if(features.length > 0 && !wantFull) {
        return res.json({ type:'FeatureCollection', features });
      }
      // 2) Positions Firestore
      let posColl = firestore.collection('positions');
      try { posColl = posColl.orderBy('created_at_ts','asc'); } catch { posColl = posColl.orderBy('created_at','asc'); }
      const posSnap = await posColl.get();
      const rows = posSnap.docs.map(d=> ({ id: d.id, lat: d.get('lat'), lng: d.get('lng') }));
      // Si Firestore n'a pas assez de points pour tracer (0 ou 1), bascule immédiatement sur SQLite
      if(rows.length < 2){
        const sqlRows = await all('SELECT id, lat, lng FROM positions ORDER BY id ASC');
        const fc = { type:'FeatureCollection', features: [] };
        if(sqlRows.length >= 2){
          // Ajouter le départ si défini
          try {
            const meta = await all('SELECT key,value FROM meta WHERE key IN ("start_lat","start_lng")');
            const obj = Object.fromEntries(meta.map(r=> [r.key, r.value]));
            const sLat = obj.start_lat != null ? parseFloat(obj.start_lat) : null;
            const sLng = obj.start_lng != null ? parseFloat(obj.start_lng) : null;
            if(Number.isFinite(sLat) && Number.isFinite(sLng)){
              const first = sqlRows[0];
              const dist0 = haversineKm(sLat, sLng, first.lat, first.lng);
              if(!(dist0 < 0.01)) sqlRows.unshift({ id: '__START__', lat: sLat, lng: sLng });
            }
          } catch(_){ }
          for(let i=1;i<sqlRows.length;i++){
            const prev = sqlRows[i-1], curr = sqlRows[i];
            if([prev,curr].some(p=> p==null || p.lat==null || p.lng==null)) continue;
            const distance_km = haversineKm(prev.lat, prev.lng, curr.lat, curr.lng);
            fc.features.push({ type:'Feature', properties:{ fromId: prev.id, toId: curr.id, distance_km, duration_min: null, source:'straight' }, geometry:{ type:'LineString', coordinates:[[prev.lng,prev.lat],[curr.lng,curr.lat]] } });
          }
        }
        return res.json(fc);
      }
      // Insérer le point de départ s'il existe (tiré de SQLite meta)
      try {
        const meta = await all('SELECT key,value FROM meta WHERE key IN ("start_lat","start_lng")');
        const obj = Object.fromEntries(meta.map(r=> [r.key, r.value]));
        const sLat = obj.start_lat != null ? parseFloat(obj.start_lat) : null;
        const sLng = obj.start_lng != null ? parseFloat(obj.start_lng) : null;
        if(Number.isFinite(sLat) && Number.isFinite(sLng)){
          // N'ajouter que si une première position existe et n'est pas déjà au départ
          if(rows.length>0){
            const first = rows[0];
            const dist0 = haversineKm(sLat, sLng, first.lat, first.lng);
            if(!(dist0 < 0.01)) rows.unshift({ id: '__START__', lat: sLat, lng: sLng });
          } else {
            rows.unshift({ id: '__START__', lat: sLat, lng: sLng });
          }
        }
      } catch(_){ }
      features = [];
      const count = Math.max(0, rows.length - 1);

      if(wantFull){
        // Mode complet: utiliser les segments stockés quand présents, sinon tracer en ligne droite pour TOUTES les paires.
        for(let i=1;i<=count;i++){
          const prev = rows[i-1]; const curr = rows[i];
          if([prev,curr].some(p=> !p || p.lat==null || p.lng==null)) continue;
          try {
            const segId = `${prev.id}__${curr.id}`;
            const segDoc = await firestore.collection('segments').doc(segId).get();
            if(segDoc.exists){
              features.push({ type:'Feature', properties:{ id: segId, distance_km: segDoc.get('distance_km'), duration_min: segDoc.get('duration_min') }, geometry: segDoc.get('geometry') });
              continue;
            }
          } catch(_){ }
          const distance_km = haversineKm(prev.lat, prev.lng, curr.lat, curr.lng);
          features.push({ type:'Feature', properties:{ fromId: prev.id, toId: curr.id, distance_km, duration_min: null, source:'straight' }, geometry: { type:'LineString', coordinates: [[prev.lng,prev.lat],[curr.lng,curr.lat]] } });
        }
        return res.json({ type:'FeatureCollection', features });
      }

      // 3) Mode réduit: dernières paires, avec routage quand possible
      const maxPairs = Math.min(WALKING_MAX_SEGMENTS, count);
      const deadline = Date.now() + 10000;
      for(let idx=1; idx<=count; idx++){
        const remaining = count - idx + 1;
        if(remaining > maxPairs) continue;
        const prev = rows[idx-1]; const curr = rows[idx];
        if([prev,curr].some(p=> !p || p.lat==null || p.lng==null)) continue;
        if(Date.now() > deadline) break;
        try {
          const segId = `${prev.id}__${curr.id}`;
          const segDoc = await firestore.collection('segments').doc(segId).get();
          if(segDoc.exists){
            features.push({ type:'Feature', properties:{ id: segId, distance_km: segDoc.get('distance_km'), duration_min: segDoc.get('duration_min') }, geometry: segDoc.get('geometry') });
            continue;
          }
        } catch(_){ }
        try {
          const route = await getWalkingRoute(prev.lat, prev.lng, curr.lat, curr.lng, { timeoutMs: 6000 });
          features.push({ type:'Feature', properties:{ fromId: prev.id, toId: curr.id, distance_km: route.distance_km, duration_min: route.duration_min, source: route.source }, geometry: route.geometry });
          await new Promise(r=> setTimeout(r, 50));
        } catch(_){
          const distance_km = haversineKm(prev.lat, prev.lng, curr.lat, curr.lng);
          features.push({ type:'Feature', properties:{ fromId: prev.id, toId: curr.id, distance_km, duration_min: null, source:'straight' }, geometry: { type:'LineString', coordinates: [[prev.lng,prev.lat],[curr.lng,curr.lat]] } });
        }
      }
      return res.json({ type:'FeatureCollection', features });
  }
  // Mode SQLite explicite ou fallback: construire la trace à partir des positions SQLite (consécutives)
  const rows = await all('SELECT id, lat, lng FROM positions ORDER BY created_at ASC, id ASC');
    // Ajouter le départ en tête s'il est défini
    try {
      const meta = await all('SELECT key,value FROM meta WHERE key IN ("start_lat","start_lng")');
      const obj = Object.fromEntries(meta.map(r=> [r.key, r.value]));
      const sLat = obj.start_lat != null ? parseFloat(obj.start_lat) : null;
      const sLng = obj.start_lng != null ? parseFloat(obj.start_lng) : null;
      if(Number.isFinite(sLat) && Number.isFinite(sLng)){
        if(rows.length>0){
          const first = rows[0];
          const dist0 = haversineKm(sLat, sLng, first.lat, first.lng);
          if(!(dist0 < 0.01)) rows.unshift({ id: '__START__', lat: sLat, lng: sLng });
        } else {
          rows.unshift({ id: '__START__', lat: sLat, lng: sLng });
        }
      }
    } catch(_){ }
    const features = [];
    const count = Math.max(0, rows.length - 1);
    const wantFull = (String(req.query.full||'').toLowerCase()==='true') || (String(req.query.full||'')==='1');

    if(wantFull){
      // Mode complet: renvoyer TOUTES les paires depuis le début, sans dépendre d'APIs externes
      // pour garantir un rendu immédiat (segments en lignes droites).
      for(let i=1; i<=count; i++){
        const prev = rows[i-1];
        const curr = rows[i];
        if([prev, curr].some(p=> p==null || p.lat==null || p.lng==null)) continue;
        const distance_km = haversineKm(prev.lat, prev.lng, curr.lat, curr.lng);
        features.push({
          type:'Feature',
          properties: { fromId: prev.id, toId: curr.id, distance_km, duration_min: null, source:'straight' },
          geometry: { type:'LineString', coordinates: [ [prev.lng, prev.lat], [curr.lng, curr.lat] ] }
        });
      }
      return res.json({ type:'FeatureCollection', features });
    }

    // Mode réduit: ne traiter que les derniers segments avec routage (comme avant)
    const toProcess = Math.min(WALKING_MAX_SEGMENTS, count);
    const deadline = Date.now() + 10000; // budget global ~10s
    for(let k=0; k<toProcess; k++){
      const i = count - k; // paire (i-1, i)
      const prev = rows[i-1];
      const curr = rows[i];
      if([prev, curr].some(p=> p==null || p.lat==null || p.lng==null)) continue;
      if(Date.now() > deadline) break;
      try {
        const route = await getWalkingRoute(prev.lat, prev.lng, curr.lat, curr.lng, { timeoutMs: 6000 });
        features.push({
          type: 'Feature',
          properties: {
            fromId: prev.id,
            toId: curr.id,
            distance_km: route.distance_km,
            duration_min: route.duration_min,
            source: route.source
          },
          geometry: route.geometry
        });
        await new Promise(r=> setTimeout(r, 60));
      } catch(_){
        const distance_km = haversineKm(prev.lat, prev.lng, curr.lat, curr.lng);
        features.push({
          type:'Feature',
          properties: { fromId: prev.id, toId: curr.id, distance_km, duration_min: null, source:'straight' },
          geometry: { type:'LineString', coordinates: [ [prev.lng, prev.lat], [curr.lng, curr.lat] ] }
        });
      }
    }
    // Réordonner chronologiquement (plus ancien -> plus récent)
    features.reverse();
    return res.json({ type:'FeatureCollection', features });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Itinéraire à pied entre deux points (préférence ORS, fallback OSRM public)
app.get('/api/walking-route', async (req,res)=>{
  try {
    const { fromLat, fromLng, toLat, toLng } = req.query;
    const aLat = parseFloat(fromLat), aLng = parseFloat(fromLng);
    const bLat = parseFloat(toLat), bLng = parseFloat(toLng);
    if([aLat,aLng,bLat,bLng].some(v=>Number.isNaN(v))) return res.status(400).json({error:'fromLat,fromLng,toLat,toLng requis'});
      if(ORS_KEY){
      const r = await fetchWithTimeout('https://api.openrouteservice.org/v2/directions/foot-walking/geojson', {
        method:'POST',
        headers: { 'Authorization': ORS_KEY, 'Content-Type':'application/json' },
          body: JSON.stringify({
            coordinates: [[aLng, aLat], [bLng, bLat]],
            instructions: false,
            preference: 'shortest',
      options: { avoid_features: ['highways','fords', 'steps', 'tracks', 'unpavedroads'] }
        })
      }, 9000);
      if(!r.ok) {
        const txt = await r.text();
        return res.status(502).json({error:'ORS failed', details: txt.slice(0,200)});
      }
      const j = await r.json();
      const feat = (j.features && j.features[0]) || null;
      if(!feat) return res.status(502).json({error:'ORS no route'});
      const coords = feat.geometry.coordinates; // [lng,lat]
      const dist = (feat.properties && feat.properties.segments && feat.properties.segments[0] && feat.properties.segments[0].distance) || null;
      const duration = (feat.properties && feat.properties.segments && feat.properties.segments[0] && feat.properties.segments[0].duration) || null;
      return res.json({ geometry: { type:'LineString', coordinates: coords }, distance_km: dist? dist/1000 : null, duration_min: duration? (duration/60) : null, source:'ors' });
    } else {
  const url = `https://router.project-osrm.org/route/v1/foot/${aLng},${aLat};${bLng},${bLat}?overview=full&geometries=geojson`;
  const r = await fetchWithTimeout(url, {}, 9000);
      if(!r.ok) return res.status(502).json({error:'OSRM failed'});
      const j = await r.json();
      const route = j.routes && j.routes[0];
      if(!route) return res.status(502).json({error:'OSRM no route'});
      return res.json({ geometry: route.geometry, distance_km: route.distance/1000, duration_min: route.duration/60, source:'osrm' });
    }
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Migration des positions SQLite -> Firestore (conserver historique)
app.post('/api/migrate/sqlite-to-firestore', checkAdmin, async (req,res)=>{
  try {
  if(!isFirestoreReady()) return res.status(400).json({error:'Firestore non prêt (activer USE_FIRESTORE=true et fournir des credentials)'});
    const rows = await all('SELECT * FROM positions ORDER BY id ASC');
    let copied=0, skipped=0;
    for(const row of rows){
      const docId = String(row.id);
      const exists = await firestore.collection('positions').doc(docId).get();
      if(exists.exists){ skipped++; continue; }
      const created_at = row.created_at || new Date().toISOString();
      await firestore.collection('positions').doc(docId).set({
        streamer: row.streamer || 'Team',
        lat: row.lat,
        lng: row.lng,
        created_at,
        created_at_ts: makeTimestamp(created_at)
      });
      copied++;
    }
    res.json({ok:true, copied, skipped});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Normaliser les dates Firestore: uniformiser created_at en ISO Europe/Paris et garantir created_at_ts
app.post('/api/admin/normalize-firestore-dates', checkAdmin, async (req,res)=>{
  try {
    if(!isFirestoreReady()) return res.status(400).json({error:'Firestore non prêt'});
    let coll = firestore.collection('positions');
    // On parcourt par pages pour éviter de gros reads (ici simple, dataset petit)
    let fixed=0, skipped=0, failed=0;
    const snap = await coll.get();
    for(const doc of snap.docs){
      try {
        const data = doc.data();
        const curCreated = data.created_at;
        const norm = ensureParisISOFromAny(curCreated) || buildParisISO();
  const hasTs = !!(data.created_at_ts && typeof data.created_at_ts.toDate === 'function');
        const update = {};
  if(curCreated !== norm) update.created_at = norm;
  // Toujours écraser en Timestamp pour garantir un type homogène (corrige les strings)
  update.created_at_ts = makeTimestamp(norm);
        if(Object.keys(update).length === 0){ skipped++; continue; }
        await firestore.collection('positions').doc(doc.id).set(update, { merge:true });
        fixed++;
      } catch(e){ failed++; }
    }
    res.json({ok:true, fixed, skipped, failed, total: (await coll.get()).size});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Migration inverse: copier les positions Firestore -> SQLite (pour synchroniser la base locale)
app.post('/api/migrate/firestore-to-sqlite', checkAdmin, async (req,res)=>{
  try {
    if(!isFirestoreReady()) return res.status(400).json({error:'Firestore non prêt'});
    let coll = firestore.collection('positions');
    try { coll = coll.orderBy('created_at_ts','asc'); } catch { coll = coll.orderBy('created_at','asc'); }
    const snap = await coll.get();
    const docs = snap.docs.map(d=> ({ id: d.id, ...d.data() }));
    let inserted=0, skipped=0, failed=0;
    for(const p of docs){
      try {
        const lat = Number(p.lat), lng = Number(p.lng);
        const created = p.created_at || new Date().toISOString();
        // Dédupliquer par (created_at, lat, lng) ~exact pour nos données
        const existing = await get('SELECT id FROM positions WHERE created_at=? AND ABS(lat-?)<1e-6 AND ABS(lng-?)<1e-6', [created, lat, lng]);
        if(existing){ skipped++; continue; }
        await run('INSERT INTO positions(streamer,lat,lng,created_at) VALUES (?,?,?,?)', [p.streamer||'Team', lat, lng, created]);
        inserted++;
      } catch(e){ failed++; }
    }
    res.json({ok:true, inserted, skipped, failed, total: docs.length});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Recréer tous les segments à pied (à lancer après migration)
app.post('/api/walking-segments/rebuild', checkAdmin, async (req,res)=>{
  try {
  if(!isFirestoreReady()) return res.status(400).json({error:'Firestore non prêt (activer USE_FIRESTORE et fournir des credentials)'});
  let coll = firestore.collection('positions');
  try { coll = coll.orderBy('created_at_ts','asc'); } catch { coll = coll.orderBy('created_at','asc'); }
  const snap = await coll.get();
    const docs = snap.docs.map(d=> ({ id:d.id, ...d.data() }));
    let created=0, skipped=0, failed=0;
    for(let i=1;i<docs.length;i++){
      const prev = docs[i-1], curr = docs[i];
      if(prev.lat==null || prev.lng==null || curr.lat==null || curr.lng==null) { skipped++; continue; }
      const segId = `${prev.id}__${curr.id}`;
      const exist = await firestore.collection('segments').doc(segId).get();
      if(exist.exists) { skipped++; continue; }
      try {
        const route = await getWalkingRoute(prev.lat, prev.lng, curr.lat, curr.lng);
        await firestore.collection('segments').doc(segId).set({
          fromId: prev.id,
          toId: curr.id,
          geometry: route.geometry,
          distance_km: route.distance_km,
          duration_min: route.duration_min,
          created_at: new Date().toISOString(),
          source: route.source
        });
        created++;
        // Petit délai pour éviter un throttle
        await new Promise(r=> setTimeout(r, 150));
      } catch(e){ failed++; }
    }
    res.json({ok:true, created, skipped, failed, totalPairs: Math.max(0, docs.length-1)});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Statut Twitch simple
app.get('/api/twitch-status', async (req,res)=>{
  const data = await fetchTwitchStatus();
  res.json(data);
});

// Debug credentials (à retirer en prod) - NE PAS exposer publiquement
app.get('/api/_debug/twitch-env', (req,res)=>{
  res.json({
    client_id_present: !!TWITCH_CLIENT_ID,
    secret_present: !!TWITCH_CLIENT_SECRET,
    sample_id: TWITCH_CLIENT_ID ? TWITCH_CLIENT_ID.slice(0,6)+'...' : null
  });
});

// Debug: vérifier si Firestore est prêt et l'état USE_FIRESTORE
app.get('/api/_debug/firestore-ready', (req,res)=>{
  const ready = isFirestoreReady();
  res.json({ USE_FIRESTORE, firestore_ready: ready });
});

// Debug: état Firebase (méthode de chargement, chemin, erreurs)
app.get('/api/_debug/firebase-status', (req,res)=>{
  res.json(firebaseDebug);
});

// Debug: flags d'environnement sans exposer de secrets
app.get('/api/_debug/env-flags', (req,res)=>{
  const uf = process.env.USE_FIRESTORE;
  const hasJson = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const fileVar = process.env.FIREBASE_SERVICE_ACCOUNT_FILE || '';
  res.json({
    USE_FIRESTORE_env: uf ?? null,
    USE_FIRESTORE_parsed: (typeof uf === 'string' ? uf.toLowerCase() === 'true' : false),
    has_JSON_env: hasJson,
    has_FILE_env: !!fileVar,
    file_env_value_hint: fileVar ? (fileVar.startsWith('/etc/secrets/') ? 'etc-secrets-path' : 'custom-path') : null
  });
});

// Debug: ping Firestore (lecture simple) pour exposer l'erreur exacte côté serveur
app.get('/api/_debug/firestore-ping', async (req,res)=>{
  try {
    if(!isFirestoreReady()) return res.status(400).json({ok:false, error:'not-ready'});
    // Petite lecture qui devrait réussir même sans documents
    const s = await firestore.collection('positions').limit(1).get();
    res.json({ ok:true, size: s.size });
  } catch(e){
    res.status(500).json({ ok:false, error: e && e.message ? e.message : String(e) });
  }
});

// Debug: lister les positions SQLite même si USE_FIRESTORE=true
app.get('/api/_debug/sqlite-positions', checkAdmin, async (req,res)=>{
  try {
    const rows = await all('SELECT * FROM positions ORDER BY id ASC');
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/route/arrival', checkAdmin, async (req,res)=> {
  try {
    const {name,time} = req.body;
    if(!name || !time) return res.status(400).json({error:'name & time requis'});
    const row = await get('SELECT * FROM route WHERE LOWER(name)=LOWER(?)',[name]);
    if(!row) return res.status(404).json({error:'Lieu inconnu'});
    let iso = time;
    if(/^[0-9]{2}:[0-9]{2}$/.test(time)) {
      const today = new Date();
      const date = today.toISOString().slice(0,10);
      iso = buildParisISO(date, time);
    }
    await run('UPDATE route SET arrival_time=? WHERE id=?',[iso,row.id]);
    res.json({ok:true, arrival_time: iso});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.listen(PORT, async ()=> { 
  console.log(`Tracker server running on :${PORT}`);
  // Auto-migration asynchrone
  try { await autoMigrateToFirestoreIfNeeded(); } catch(_){ }
});
