import 'dotenv/config';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

const USE_FIRESTORE = (process.env.USE_FIRESTORE || '').toLowerCase() === 'true';
export const firebaseDebug = { useFirestore: USE_FIRESTORE, method: null, path: null, error: null, initialized: false, projectId: null, clientEmail: null };

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
      firebaseDebug.method = 'json';
      firebaseDebug.projectId = parsed.project_id || null;
      firebaseDebug.clientEmail = parsed.client_email || null;
    } catch (e) {
  console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON invalide:', e.message);
  firebaseDebug.error = 'JSON parse error: ' + e.message;
    }
  } else {
    const candidatePaths = [];
    if (filePath) candidatePaths.push(filePath);
    // Fallbacks: chemin relatif courant et parent
  // Ancien nom connu
  candidatePaths.push(path.resolve(process.cwd(), 'suivi-byilhann-nicola-firebase-adminsdk-fbsvc-abd7f4cd1f.json'));
  candidatePaths.push(path.resolve(process.cwd(), '..', 'suivi-byilhann-nicola-firebase-adminsdk-fbsvc-abd7f4cd1f.json'));
  // Nouveau nom fourni (V2)
  candidatePaths.push(path.resolve(process.cwd(), 'suivi-byilhann-nicola-firebase-adminsdk-fbsvc-bdcbb98ed0V2.json'));
  candidatePaths.push(path.resolve(process.cwd(), '..', 'suivi-byilhann-nicola-firebase-adminsdk-fbsvc-bdcbb98ed0V2.json'));
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
  firebaseDebug.method = 'file';
  firebaseDebug.path = p;
  firebaseDebug.projectId = parsed.project_id || null;
  firebaseDebug.clientEmail = parsed.client_email || null;
        break;
      } catch(e){ /* essayer suivant */ }
    }
  if(!cred && filePath){ console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_FILE introuvable ou invalide:', filePath); firebaseDebug.error = 'FILE not found or invalid: ' + filePath; firebaseDebug.path = filePath; }
  }
  try {
    if(cred){
      app = admin.initializeApp({ credential: cred });
      firebaseDebug.initialized = true;
    } else {
      console.warn('[Firebase] Aucun credentials explicite, Firestore non initialisé (pas d\'applicationDefault)');
      firebaseDebug.error = 'no credentials provided';
    }
  } catch(e) {
    console.warn('[Firebase] Initialisation ignorée (pas de credentials valides):', e.message);
    firebaseDebug.error = 'init failed: ' + e.message;
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
