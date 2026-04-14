const https = require('https');
const { URL } = require('url');

// ─────────────────────────────────────────────────────
//  NuVizz v7 API Lookup — Netlify Serverless Function
//  POST /api/nuvizz-lookup  { pro: "12345" }
//  GET  /api/nuvizz-lookup   ← diagnostic / connection test
// ─────────────────────────────────────────────────────

const COMPANY = process.env.NUVIZZ_COMPANY || 'davis';
const USERNAME = process.env.NUVIZZ_USER;
const PASSWORD = process.env.NUVIZZ_PASS;
const BASE_URL = process.env.NUVIZZ_BASE_URL || 'https://login.nuvizz.com/deliverit/openapi/v7';

let cachedToken = '';
let tokenExpiry = 0;

function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...opts.headers,
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out after 15s')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return { token: cachedToken };

  const basic = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  const url = `${BASE_URL}/auth/token/${encodeURIComponent(COMPANY)}`;

  console.log(`[AUTH] GET ${url}`);

  const res = await request(url, {
    headers: { 'Authorization': `Basic ${basic}` },
  });

  console.log(`[AUTH] Status: ${res.status}, Body: ${res.body.slice(0, 500)}`);

  if (res.status !== 200) {
    return { error: `Auth failed HTTP ${res.status}`, detail: res.body.slice(0, 500), url };
  }

  let data;
  try { data = JSON.parse(res.body); } catch (e) {
    return { error: 'Auth response not JSON', detail: res.body.slice(0, 500), url };
  }

  if (data.reasons && data.reasons.length > 0) {
    return { error: 'Auth rejected by NuVizz', reasons: data.reasons, url };
  }

  if (!data.authToken) {
    return { error: 'No authToken in response', responseKeys: Object.keys(data), detail: JSON.stringify(data).slice(0, 500), url };
  }

  cachedToken = data.authToken;
  tokenExpiry = data.expiresAt
    ? (Number(data.expiresAt) * 1000) - 300000
    : Date.now() + 3300000;

  return { token: cachedToken };
}

async function lookupStop(stopNbr) {
  const auth = await getToken();
  if (auth.error) {
    return {
      error: 'auth_failed',
      message: auth.error,
      detail: auth.detail || auth.reasons,
      authUrl: auth.url,
      source: 'nuvizz_live',
    };
  }

  const url = `${BASE_URL}/stop/info/${encodeURIComponent(stopNbr)}/${encodeURIComponent(COMPANY)}`;
  console.log(`[LOOKUP] GET ${url}`);

  const res = await request(url, {
    headers: { 'Authorization': `Bearer ${auth.token}` },
  });

  console.log(`[LOOKUP] Status: ${res.status}, Body: ${res.body.slice(0, 1000)}`);

  if (res.status === 404 || res.status === 409) {
    return { error: 'not_found', pro: stopNbr, message: `PRO not found (HTTP ${res.status})`, detail: res.body.slice(0, 300), source: 'nuvizz_live' };
  }

  if (res.status === 401) {
    cachedToken = '';
    tokenExpiry = 0;
    const auth2 = await getToken();
    if (auth2.error) return { error: 'auth_retry_failed', message: auth2.error, source: 'nuvizz_live' };
    const res2 = await request(url, { headers: { 'Authorization': `Bearer ${auth2.token}` } });
    if (res2.status !== 200) return { error: 'retry_failed', pro: stopNbr, httpStatus: res2.status, detail: res2.body.slice(0, 300), source: 'nuvizz_live' };
    return parseStopResponse(JSON.parse(res2.body), stopNbr);
  }

  if (res.status !== 200) {
    return { error: 'api_error', pro: stopNbr, httpStatus: res.status, detail: res.body.slice(0, 500), source: 'nuvizz_live' };
  }

  let data;
  try { data = JSON.parse(res.body); } catch (e) {
    return { error: 'parse_error', pro: stopNbr, message: 'Response not JSON', detail: res.body.slice(0, 500), source: 'nuvizz_live' };
  }

  return parseStopResponse(data, stopNbr);
}

function parseStopResponse(data, pro) {
  const view = data.Stop || data.stop || data;
  const stop = view.stop || {};
  const load = view.load || {};
  const exec = view.stopExecutionInfo || {};
  const toInfo = stop.to || {};
  const addr = toInfo.address || {};
  const schedule = toInfo.schedule || {};

  const weight = stop.weight ? `${stop.weight} ${stop.weightUOM || 'lbs'}` : '-';
  const status = mapStatus(exec.stopStatus, exec.exceptionPresent);

  let scheduled = '-';
  if (schedule.timeFrom && schedule.timeTo) {
    scheduled = `${fmtTime(schedule.timeFrom)} - ${fmtTime(schedule.timeTo)}`;
  } else if (schedule.timeFrom) {
    scheduled = `By ${fmtTime(schedule.timeFrom)}`;
  }

  return {
    pro,
    stopNbr: stop.stopNbr || pro,
    stopId: stop.stopId || '',
    sealNbr: stop.sealNbr || '',
    bol: stop.bol || '',
    proNumber: stop.proNumber || '',
    accountNumber: stop.accountNumber || '',
    consignee: addr.name || '-',
    address: [addr.addr1, addr.addr2].filter(Boolean).join(', ') || '-',
    city: addr.city || '',
    state: addr.state || '',
    zip: addr.zip || '',
    fullAddress: [addr.addr1, addr.city, addr.state, addr.zip].filter(Boolean).join(', ') || '-',
    driver: load.driverName || '-',
    driverId: load.driverId || '',
    driverPhone: load.driverPhoneNum || '',
    route: load.routeName || load.loadNbr || '-',
    loadNbr: load.loadNbr || '',
    loadStatus: load.loadStatus || '',
    vehicleNbr: load.vehicleNbr || '',
    stop: stop.stopSeq || stop.altStopSeq || '-',
    weight,
    pallets: stop.totalPallets || '-',
    cartons: stop.totalCartons || '-',
    pieces: stop.totalCartons || stop.totalPallets || '-',
    scheduled,
    stopType: stop.stopType || '',
    reference1: stop.reference1 || '',
    reference2: stop.reference2 || '',
    status,
    stopStatusCode: exec.stopStatus || '',
    exceptionPresent: exec.exceptionPresent || false,
    custName: (stop.custInfo || {}).custName || '',
    custAccNbr: (stop.custInfo || {}).custAccNbr || '',
    source: 'nuvizz_live',
  };
}

function mapStatus(code, hasException) {
  switch (code) {
    case '90': case '91': case '80': return 'delivered';
    case '99': return 'cancelled';
    case '38': case '50': case '24': case '27': case '30': return 'on-truck';
    case '20': return hasException ? 'exception' : 'planned';
    case '05': case '10': return 'warehouse';
    default: return 'unknown';
  }
}

function fmtTime(dttm) {
  if (!dttm) return '';
  try {
    const parts = dttm.split('T');
    if (parts.length < 2) return dttm;
    const [h, m] = parts[1].split(':');
    const hr = parseInt(h, 10);
    return `${hr % 12 || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
  } catch (e) { return dttm; }
}

// ── MOCK DATA ────────────────────────────────────────
const MOCK = {
  'DD001234': { pro:'DD001234', stopNbr:'DD001234', sealNbr:'SEAL-1001', consignee:'DCO Tech Dr', address:'1430 Tech Dr', city:'Norcross', state:'GA', zip:'30093', fullAddress:'1430 Tech Dr, Norcross, GA 30093', driver:'Trevor Seyers', route:'ATL-N Route 2', loadNbr:'LD-2026-0408-02', stop:'3', weight:'840 lbs', pallets:'2', cartons:'6', pieces:'6', scheduled:'10:00 AM - 12:00 PM', status:'warehouse', stopStatusCode:'10', source:'mock' },
  'DD005678': { pro:'DD005678', stopNbr:'DD005678', sealNbr:'SEAL-1002', consignee:'Atlanta West Carpets', address:'2500 Cobb Pkwy', city:'Smyrna', state:'GA', zip:'30080', fullAddress:'2500 Cobb Pkwy, Smyrna, GA 30080', driver:'Trevarr Howard', route:'ATL-W Route 1', loadNbr:'LD-2026-0408-01', stop:'5', weight:'1,120 lbs', pallets:'3', cartons:'9', pieces:'9', scheduled:'12:00 PM - 2:00 PM', status:'delivered', stopStatusCode:'90', source:'mock' },
  'DD009999': { pro:'DD009999', stopNbr:'DD009999', sealNbr:'SEAL-1003', consignee:'Floor Works Dallas', address:'855 Peachtree Industrial', city:'Duluth', state:'GA', zip:'30097', fullAddress:'855 Peachtree Industrial, Duluth, GA 30097', driver:'Brent Dixon', route:'ATL-S Route 3', loadNbr:'LD-2026-0408-03', stop:'2', weight:'560 lbs', pallets:'1', cartons:'4', pieces:'4', scheduled:'1:00 PM - 3:30 PM', status:'on-truck', stopStatusCode:'38', source:'mock' },
  'DD004321': { pro:'DD004321', stopNbr:'DD004321', sealNbr:'SEAL-1004', consignee:'Hillman Flooring', address:'4200 Satellite Blvd', city:'Duluth', state:'GA', zip:'30096', fullAddress:'4200 Satellite Blvd, Duluth, GA 30096', driver:'Trevor Seyers', route:'ATL-N Route 2', loadNbr:'LD-2026-0408-02', stop:'7', weight:'320 lbs', pallets:'1', cartons:'2', pieces:'2', scheduled:'10:00 AM - 12:00 PM', status:'warehouse', stopStatusCode:'05', source:'mock' },
};

// ── Lambda Handler ───────────────────────────────────
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

  // ── GET = diagnostic test ──
  if (event.httpMethod === 'GET') {
    const diag = {
      status: 'ok',
      env: {
        NUVIZZ_COMPANY: COMPANY,
        NUVIZZ_USER: USERNAME || '(NOT SET)',
        NUVIZZ_PASS: PASSWORD ? ('***' + PASSWORD.slice(-2)) : '(NOT SET)',
        NUVIZZ_BASE_URL: BASE_URL,
      },
      mode: (!USERNAME || !PASSWORD) ? 'MOCK - no credentials' : 'LIVE',
      timestamp: new Date().toISOString(),
    };

    if (USERNAME && PASSWORD) {
      try {
        const authResult = await getToken();
        if (authResult.error) {
          diag.auth = { result: 'FAILED', error: authResult.error, detail: authResult.detail, reasons: authResult.reasons, url: authResult.url };
        } else {
          diag.auth = { result: 'SUCCESS', tokenPrefix: authResult.token.slice(0, 30) + '...' };
        }
      } catch (e) {
        diag.auth = { result: 'EXCEPTION', message: e.message };
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(diag, null, 2) };
  }

  // ── POST = lookup ──
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const body = JSON.parse(event.body || '{}');
  const pro = (body.pro || '').trim().toUpperCase();
  if (!pro) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing PRO number' }) };
  }

  if (!USERNAME || !PASSWORD) {
    const result = MOCK[pro] || { error: 'not_found', pro, message: 'PRO not in mock data (NuVizz creds not configured)', source: 'mock' };
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  }

  try {
    const result = await lookupStop(pro);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    console.error('[FATAL]', err);
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'server_error', message: err.message, pro, source: 'nuvizz_live' }) };
  }
};
