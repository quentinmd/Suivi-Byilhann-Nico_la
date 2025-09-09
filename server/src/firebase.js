import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

const USE_FIRESTORE = (process.env.USE_FIRESTORE || '').toLowerCase() === 'true';

let app;
if (USE_FIRESTORE && !admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_FILE || '';
  let cred = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      // Certains environnements encodent les retours de ligne de la clé privée
      if (parsed.private_key && parsed.private_key.includes('\\n')) {
        parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      }
      cred = admin.credential.cert(parsed);
    } catch (e) {
      console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON invalide:', e.message);
    }
  } else {
    const candidatePaths = [];
    if (filePath) candidatePaths.push(filePath);
    // Fallbacks: chemin relatif courant et parent
    candidatePaths.push(path.resolve(process.cwd(), 'suivi-byilhann-nicola-firebase-adminsdk-fbsvc-abd7f4cd1f.json'));
    candidatePaths.push(path.resolve(process.cwd(), '..', 'suivi-byilhann-nicola-firebase-adminsdk-fbsvc-abd7f4cd1f.json'));
    for (const p of candidatePaths){
      try {
        if(!p) continue;
        const txt = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(txt);
        if (parsed.private_key && parsed.private_key.includes('\\n')) {
          parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
        }
        cred = admin.credential.cert(parsed);
        console.log('[Firebase] Credentials chargés depuis', p);
        break;
      } catch(e){ /* essayer suivant */ }
    }
    if(!cred && filePath){ console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_FILE introuvable ou invalide:', filePath); }
  }
  try {
    app = admin.initializeApp({ credential: cred || admin.credential.applicationDefault() });
  } catch(e) {
    console.warn('[Firebase] Initialisation ignorée (pas de credentials valides):', e.message);
  }
}
export const firestore = USE_FIRESTORE && admin.apps.length ? admin.firestore() : {};
if (USE_FIRESTORE) {
  if (admin.apps.length) console.log('[Firebase] Firestore prêt');
  else console.warn('[Firebase] Firestore non initialisé');
}
export function makeTimestamp(iso){
  try { return admin.firestore.Timestamp.fromDate(new Date(iso)); } catch { return undefined; }
}
