const https = require('https');

// ─────────────────────────────────────────────
//  Firebase Logger — Netlify Serverless Function
//  POST /api/log-scan  { scan: {...} }
// ─────────────────────────────────────────────

const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (!FIREBASE_PROJECT || !FIREBASE_API_KEY) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, mode: 'mock', message: 'Firebase not configured — scan logged locally only' }),
    };
  }

  try {
    const { scan } = JSON.parse(event.body || '{}');
    if (!scan || !scan.pro) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing scan data' }) };
    }

    const today = new Date().toLocaleDateString('en-US', { year:'numeric', month:'2-digit', day:'2-digit' }).replace(/\//g, '-');
    const docId = `${today}_${scan.pro}_${Date.now()}`;

    const firestoreDoc = {
      fields: {
        pro: { stringValue: scan.pro },
        stopNbr: { stringValue: scan.stopNbr || scan.pro },
        sealNbr: { stringValue: scan.sealNbr || '' },
        driver: { stringValue: scan.driver || '' },
        route: { stringValue: scan.route || '' },
        loadNbr: { stringValue: scan.loadNbr || '' },
        consignee: { stringValue: scan.consignee || '' },
        address: { stringValue: scan.fullAddress || scan.address || '' },
        stop: { stringValue: String(scan.stop || '') },
        weight: { stringValue: scan.weight || '' },
        pallets: { stringValue: String(scan.pallets || '') },
        cartons: { stringValue: String(scan.cartons || '') },
        scheduled: { stringValue: scan.scheduled || '' },
        status: { stringValue: scan.status || '' },
        stopStatusCode: { stringValue: scan.stopStatusCode || '' },
        scannedAt: { timestampValue: new Date().toISOString() },
        shiftDate: { stringValue: today },
        source: { stringValue: scan.source || 'app' },
      }
    };

    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/scans/${docId}?key=${FIREBASE_API_KEY}`;

    const parsed = new URL(firestoreUrl);
    const bodyStr = JSON.stringify(firestoreDoc);
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });

    if (result.status < 300) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, docId }) };
    } else {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Firebase write failed', detail: result.body }) };
    }
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
