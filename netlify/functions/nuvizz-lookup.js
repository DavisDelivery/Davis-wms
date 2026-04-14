const https = require('https');
const { URL } = require('url');

// ─────────────────────────────────────────────────────
//  NuVizz v7 API Lookup — Netlify Serverless Function
//  POST /api/nuvizz-lookup  { pro: "12345" }
//
//  Auth flow:
//    1. GET /auth/token/{companyCode}  (Basic Auth header)
//       → returns { authToken, expiresAt }
//    2. GET /stop/info/{stopNbr}/{companyCode}  (Bearer token)
//       → returns { Stop: { stop, load, stopExecutionInfo } }
// ─────────────────────────────────────────────────────

const COMPANY = process.env.NUVIZZ_COMPANY || 'davis';
const USERNAME = process.env.NUVIZZ_USER;
const PASSWORD = process.env.NUVIZZ_PASS;
const BASE_URL = process.env.NUVIZZ_BASE_URL || 'https://login.nuvizz.com/deliverit/openapi/v7';

// Token cache (persists across warm invocations)
let cachedToken = '';
let tokenExpiry = 0;

// ── HTTP helper ──────────────────────────────────────
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
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Get auth token (Basic Auth → Bearer) ─────────────
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const basic = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  const url = `${BASE_URL}/auth/token/${encodeURIComponent(COMPANY)}`;

  const res = await request(url, {
    headers: { 'Authorization': `Basic ${basic}` },
  });

  if (res.status !== 200) {
    throw new Error(`Auth failed (${res.status}): ${res.body.slice(0, 300)}`);
  }

  const data = JSON.parse(res.body);
  if (!data.authToken) {
    throw new Error('No authToken in response: ' + res.body.slice(0, 300));
  }

  cachedToken = data.authToken;
  // NuVizz returns expiresAt as epoch seconds — expire 5 min early for safety
  tokenExpiry = data.expiresAt
    ? (Number(data.expiresAt) * 1000) - 300000
    : Date.now() + 3300000; // default ~55 min

  return cachedToken;
}

// ── Look up a stop by stopNbr (PRO) ──────────────────
async function lookupStop(stopNbr) {
  const token = await getToken();
  const url = `${BASE_URL}/stop/info/${encodeURIComponent(stopNbr)}/${encodeURIComponent(COMPANY)}`;

  const res = await request(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (res.status === 404 || res.status === 409) {
    return { error: 'not_found', pro: stopNbr, message: 'PRO not found in NuVizz' };
  }
  if (res.status === 401) {
    // Token may have expired — clear and retry once
    cachedToken = '';
    tokenExpiry = 0;
    const token2 = await getToken();
    const res2 = await request(url, {
      headers: { 'Authorization': `Bearer ${token2}` },
    });
    if (res2.status !== 200) {
      return { error: 'auth_retry_failed', pro: stopNbr, message: `Auth retry failed (${res2.status})` };
    }
    return parseStopResponse(JSON.parse(res2.body), stopNbr);
  }
  if (res.status !== 200) {
    return { error: 'api_error', pro: stopNbr, message: `NuVizz returned ${res.status}: ${res.body.slice(0, 200)}` };
  }

  return parseStopResponse(JSON.parse(res.body), stopNbr);
}

// ── Parse NuVizz StopView response ───────────────────
function parseStopResponse(data, pro) {
  // Response shape: { Stop: { stop: {...}, load: {...}, stopExecutionInfo: {...} } }
  const view = data.Stop || data.stop || data;
  const stop = view.stop || {};
  const load = view.load || {};
  const exec = view.stopExecutionInfo || {};

  // Address — prefer "to" (delivery destination)
  const toInfo = stop.to || {};
  const addr = toInfo.address || {};
  const schedule = toInfo.schedule || {};

  // Weight / pieces
  const weight = stop.weight ? `${stop.weight} ${stop.weightUOM || 'lbs'}` : '—';
  const pallets = stop.totalPallets || '—';
  const cartons = stop.totalCartons || '—';
  const pieces = stop.totalCartons || stop.totalPallets || '—';

  // Stop status mapping
  const status = mapStopStatus(exec.stopStatus, exec.exceptionPresent);

  // Schedule window
  let scheduled = '—';
  if (schedule.timeFrom && schedule.timeTo) {
    const from = formatTime(schedule.timeFrom);
    const to = formatTime(schedule.timeTo);
    scheduled = `${from} – ${to}`;
  } else if (schedule.timeFrom) {
    scheduled = `By ${formatTime(schedule.timeFrom)}`;
  }

  return {
    pro,
    stopNbr: stop.stopNbr || pro,
    stopId: stop.stopId || '',
    sealNbr: stop.sealNbr || '',
    bol: stop.bol || '',
    proNumber: stop.proNumber || '',
    accountNumber: stop.accountNumber || '',

    // Delivery address
    consignee: addr.name || '—',
    address: [addr.addr1, addr.addr2].filter(Boolean).join(', ') || '—',
    city: addr.city || '',
    state: addr.state || '',
    zip: addr.zip || '',
    fullAddress: [addr.addr1, addr.city, addr.state, addr.zip].filter(Boolean).join(', ') || '—',

    // Load / route info
    driver: load.driverName || '—',
    driverId: load.driverId || '',
    driverPhone: load.driverPhoneNum || '',
    route: load.routeName || load.loadNbr || '—',
    loadNbr: load.loadNbr || '',
    loadStatus: load.loadStatus || '',
    vehicleNbr: load.vehicleNbr || '',

    // Stop detail
    stop: stop.stopSeq || stop.altStopSeq || '—',
    weight,
    pallets,
    cartons,
    pieces,
    scheduled,
    stopType: stop.stopType || '',
    reference1: stop.reference1 || '',
    reference2: stop.reference2 || '',

    // Execution
    status,
    stopStatusCode: exec.stopStatus || '',
    exceptionPresent: exec.exceptionPresent || false,
    exceptions: (exec.exceptions || []).map(e => e.exceptionCode || e.reason || '').filter(Boolean),

    // Customer
    custName: (stop.custInfo || {}).custName || '',
    custAccNbr: (stop.custInfo || {}).custAccNbr || '',

    source: 'nuvizz_live',
  };
}

// ── Map NuVizz stopStatus codes to our categories ────
function mapStopStatus(code, hasException) {
  // 05=Placed, 10=Un-Planned, 20=Planned, 24=PU In Transit,
  // 27=PU Arrived, 30=PU Completed, 38=Enroute, 50=Arrived at DO,
  // 80=Closed, 90=Completed, 91=Manually Completed, 99=Cancelled
  switch (code) {
    case '90': case '91': case '80': return 'delivered';
    case '99': return 'cancelled';
    case '38': case '50': case '24': case '27': case '30': return 'on-truck';
    case '20': return hasException ? 'exception' : 'planned';
    case '05': case '10': return 'warehouse';
    default: return code ? 'unknown' : 'unknown';
  }
}

function formatTime(dttm) {
  if (!dttm) return '';
  try {
    // Format: "2020-04-21T12:00:00"
    const parts = dttm.split('T');
    if (parts.length < 2) return dttm;
    const [h, m] = parts[1].split(':');
    const hr = parseInt(h, 10);
    const ampm = hr >= 12 ? 'PM' : 'AM';
    return `${hr % 12 || 12}:${m} ${ampm}`;
  } catch (e) { return dttm; }
}

// ── MOCK DATA (when credentials not configured) ──────
const MOCK = {
  'DD001234': { pro:'DD001234', stopNbr:'DD001234', sealNbr:'SEAL-1001', consignee:'DCO Tech Dr', address:'1430 Tech Dr', city:'Norcross', state:'GA', zip:'30093', fullAddress:'1430 Tech Dr, Norcross, GA 30093', driver:'Trevor Seyers', route:'ATL-N Route 2', loadNbr:'LD-2026-0408-02', stop:'3', weight:'840 lbs', pallets:'2', cartons:'6', pieces:'6', scheduled:'10:00 AM – 12:00 PM', status:'warehouse', stopStatusCode:'10', source:'mock' },
  'DD005678': { pro:'DD005678', stopNbr:'DD005678', sealNbr:'SEAL-1002', consignee:'Atlanta West Carpets', address:'2500 Cobb Pkwy', city:'Smyrna', state:'GA', zip:'30080', fullAddress:'2500 Cobb Pkwy, Smyrna, GA 30080', driver:'Trevarr Howard', route:'ATL-W Route 1', loadNbr:'LD-2026-0408-01', stop:'5', weight:'1,120 lbs', pallets:'3', cartons:'9', pieces:'9', scheduled:'12:00 PM – 2:00 PM', status:'delivered', stopStatusCode:'90', source:'mock' },
  'DD009999': { pro:'DD009999', stopNbr:'DD009999', sealNbr:'SEAL-1003', consignee:'Floor Works Dallas', address:'855 Peachtree Industrial', city:'Duluth', state:'GA', zip:'30097', fullAddress:'855 Peachtree Industrial, Duluth, GA 30097', driver:'Brent Dixon', route:'ATL-S Route 3', loadNbr:'LD-2026-0408-03', stop:'2', weight:'560 lbs', pallets:'1', cartons:'4', pieces:'4', scheduled:'1:00 PM – 3:30 PM', status:'on-truck', stopStatusCode:'38', source:'mock' },
  'DD004321': { pro:'DD004321', stopNbr:'DD004321', sealNbr:'SEAL-1004', consignee:'Hillman Flooring', address:'4200 Satellite Blvd', city:'Duluth', state:'GA', zip:'30096', fullAddress:'4200 Satellite Blvd, Duluth, GA 30096', driver:'Trevor Seyers', route:'ATL-N Route 2', loadNbr:'LD-2026-0408-02', stop:'7', weight:'320 lbs', pallets:'1', cartons:'2', pieces:'2', scheduled:'10:00 AM – 12:00 PM', status:'warehouse', stopStatusCode:'05', source:'mock' },
};

// ── Lambda Handler ───────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const body = JSON.parse(event.body || '{}');
  const pro = (body.pro || '').trim().toUpperCase();
  if (!pro) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing PRO number' }) };
  }

  // If no creds → mock mode
  if (!USERNAME || !PASSWORD) {
    const result = MOCK[pro] || { error: 'not_found', pro, message: 'PRO not in mock dataset', source: 'mock' };
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  }

  try {
    const result = await lookupStop(pro);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'server_error', message: err.message, pro }) };
  }
};
