import express from 'express';
import cors from 'cors';
import db from './db.js';
import fetch from 'node-fetch';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 4000;

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
    if(createdAt) await run('INSERT INTO positions(streamer,lat,lng,created_at) VALUES (?,?,?,?)',['Team',lat,lng,createdAt]);
    else await run('INSERT INTO positions(streamer,lat,lng) VALUES (?,?,?)',['Team',lat,lng]);
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
    if(createdAt) await run('INSERT INTO positions(streamer,lat,lng,created_at) VALUES (?,?,?,?)',['Team',parseFloat(lat),parseFloat(lng),createdAt]);
    else await run('INSERT INTO positions(streamer,lat,lng) VALUES (?,?,?)',['Team',parseFloat(lat),parseFloat(lng)]);
    res.json({ok:true, created_at: createdAt});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch('/api/positions/:id', checkAdmin, async (req,res)=> {
  try {
    const {id} = req.params; const {lat,lng,date,time} = req.body;
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
    await run('INSERT INTO positions(streamer,lat,lng) VALUES (?,?,?)',[ 'Team', r.lat, r.lng]);
    res.json({ok:true, lat:r.lat, lng:r.lng});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/route', async (req,res)=> {
  try { res.json(await all('SELECT * FROM route ORDER BY seq ASC')); }
  catch(e){ res.status(500).json({error:e.message}); }
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

app.listen(PORT, ()=> console.log(`Tracker server running on :${PORT}`));
