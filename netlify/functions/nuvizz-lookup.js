const https = require('https');
const { URL } = require('url');

const COMPANY = process.env.NUVIZZ_COMPANY || 'davis';
const USERNAME = process.env.NUVIZZ_USER;
const PASSWORD = process.env.NUVIZZ_PASS;
const BASE_URL = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';

function rq(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const r = https.request({
      hostname: p.hostname, path: p.pathname + p.search,
      method: opts.method || 'GET',
      headers: { 'Accept':'application/json','Content-Type':'application/json', ...opts.headers },
      timeout: 15000,
    }, res => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({status:res.statusCode,body:b})); });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function basicHeader() {
  return { 'Authorization': `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}` };
}

// ── Stop Lookup (always prepend 00 to PROs for Uline/NuVizz) ──
async function lookupStop(pro, quick) {
  // Uline PROs need 00 prefix for NuVizz
  let paddedPro = pro;
  if (/^\d+$/.test(pro) && !pro.startsWith('00')) {
    paddedPro = '00' + pro;
  }
  return await tryStopLookup(paddedPro, quick);
}

async function tryStopLookup(pro, quick) {
  const url = `${BASE_URL}/stop/info/${encodeURIComponent(pro)}/${encodeURIComponent(COMPANY)}`;
  const res = await rq(url, { headers: basicHeader() });
  console.log(`[STOP] ${url} → ${res.status}`);

  if (res.status === 404 || res.status === 409) return { notFound:true, error:'not_found', pro, message:`Stop not found (HTTP ${res.status})`, source:'nuvizz_live' };
  if (res.status === 401 || res.status === 403) return { error:'auth_failed', pro, message:`Auth rejected (HTTP ${res.status})`, source:'nuvizz_live' };
  if (res.status !== 200) return { error:'api_error', pro, httpStatus:res.status, detail:res.body.slice(0,500), source:'nuvizz_live' };

  let data; try { data = JSON.parse(res.body); } catch(e) { return { error:'parse_error', detail:res.body.slice(0,500), source:'nuvizz_live' }; }

  const result = parseStop(data, pro);

  // ── Flag 1: Wrong day (scheduled date ≠ today) ──
  const view = data.Stop || data.stop || data;
  const stop = (view.stop || {});
  const toInfo = stop.to || {};
  const schedule = toInfo.schedule || {};
  if (schedule.timeFrom) {
    const schedDate = schedule.timeFrom.split('T')[0]; // "2026-04-14"
    const today = new Date().toISOString().split('T')[0];
    if (schedDate && schedDate !== today) {
      result.flags = result.flags || [];
      result.flags.push({ type: 'wrong_day', severity: 'high', message: `Scheduled for ${formatDate(schedDate)}, not today`, scheduledDate: schedDate, today });
      result.scheduledDate = schedDate;
    }
  }

  // ── Flag 1b: Appointment delivery ──
  // ONLY flag on the exact Uline comment: "NTFY OF DELIVERY-APPT REQD"
  const rawComments = stop.comments || [];
  // NuVizz may return comments as array directly, or nested in an object
  let allComments = [];
  if (Array.isArray(rawComments)) {
    allComments = rawComments;
  } else if (typeof rawComments === 'object') {
    allComments = rawComments.comment || rawComments.comments || [];
    if (!Array.isArray(allComments)) allComments = [allComments];
  }

  let apptComment = null;
  for (const c of allComments) {
    if (!c) continue;
    const desc = (c.commentDescription || c.description || c.text || '');
    if (desc.toUpperCase().includes('NTFY OF DELIVERY-APPT REQD')) {
      apptComment = desc;
      break;
    }
  }
  // Log what we found for debugging
  console.log(`[COMMENTS] pro:${pro} count:${allComments.length} appt:${!!apptComment} raw:${JSON.stringify(rawComments).slice(0,300)}`);

  if (apptComment) {
    result.flags = result.flags || [];
    result.flags.push({
      type: 'appointment',
      severity: 'high',
      message: `Appointment required — ${apptComment}`,
    });
    result.isAppointment = true;
    result.apptNote = apptComment;
  }

  // Also check stopAccessorials and customAttributes for the exact code
  const searchFields = [
    JSON.stringify(stop.customAttributes || {}),
    JSON.stringify(stop.stopAccessorials || {}),
  ];
  if (!result.isAppointment) {
    for (const f of searchFields) {
      if (!f) continue;
      if (f.toUpperCase().includes('NTFY OF DELIVERY-APPT REQD')) {
        result.flags = result.flags || [];
        result.flags.push({ type: 'appointment', severity: 'high', message: 'Appointment required — NTFY OF DELIVERY-APPT REQD' });
        result.isAppointment = true;
        break;
      }
    }
  }

  // ── Flag 2 & 3: Route-level checks (load info) ──
  // Skip in quick mode (scanner) for instant response
  const loadNbr = result.loadNbr;
  if (!quick && loadNbr && loadNbr !== '-') {
    try {
      const loadData = await getLoadInfo(loadNbr);
      if (loadData && !loadData.error) {
        const stops = loadData.stops || [];
        const thisStopNbr = result.stopNbr || pro;
        const loadStatus = loadData.loadStatus || '';

        // Flag 2: Check if any part of this stop has been delivered (multipiece)
        const exec = ((data.Stop || data.stop || data).stopExecutionInfo || {});
        const xTo = exec.to || {};
        if (result.status !== 'delivered' && (xTo.confirmedDTTM || xTo.arrivalDTTM || xTo.departureDTTM)) {
          result.flags = result.flags || [];
          result.flags.push({ type: 'partial_delivery', severity: 'high', message: 'Partial delivery detected — driver visited this stop but freight still here' });
        }

        // Flag 3: Check if ANY other stop on this route has been delivered OR is on truck
        const deliveredStops = [];
        const onTruckStops = [];
        for (const ls of stops) {
          const lsStop = ls.stop || {};
          const lsExec = ls.stopExecutionInfo || {};
          const lsStopNbr = lsStop.stopNbr || '';
          if (lsStopNbr === thisStopNbr) continue; // skip self
          
          const lsStatus = lsExec.stopStatus || '';
          const lsAddr = ((lsStop.to || {}).address || {});
          // 90/91=Completed, 80=Closed → delivered
          if (lsStatus === '90' || lsStatus === '91' || lsStatus === '80') {
            deliveredStops.push({ stopNbr: lsStopNbr, consignee: lsAddr.name || lsStopNbr, status: lsStatus });
            continue;
          }
          // 24/27/30/38/50 → on truck (truck is moving with this stop on it)
          if (['24','27','30','38','50'].includes(lsStatus)) {
            onTruckStops.push({ stopNbr: lsStopNbr, consignee: lsAddr.name || lsStopNbr, status: lsStatus });
            continue;
          }
          // Also catch delivery timestamps (backup check)
          const lsTo = lsExec.to || {};
          if (lsTo.confirmedDTTM || lsTo.departureDTTM) {
            deliveredStops.push({ stopNbr: lsStopNbr, consignee: lsAddr.name || lsStopNbr, status: lsStatus, note: 'has delivery timestamps' });
          }
        }

        // Load status 30/32/33/40 means truck is dispatched/in-progress
        // loadStatus codes: 30=Dispatched, 32=Driver Arrived, 33=Driver Initiated, 40=In-Progress
        const loadInProgress = ['30','32','33','40'].includes(loadStatus);

        // Flag if route is active and this freight is still in warehouse
        if (result.status !== 'delivered' && result.status !== 'on-truck') {
          if (deliveredStops.length > 0) {
            result.flags = result.flags || [];
            result.flags.push({
              type: 'route_active',
              severity: 'high',
              message: `${deliveredStops.length} other stop(s) on this route already delivered — this freight was forgotten`,
              deliveredStops: deliveredStops.slice(0, 5),
            });
          } else if (onTruckStops.length > 0 || loadInProgress) {
            result.flags = result.flags || [];
            result.flags.push({
              type: 'route_active',
              severity: 'high',
              message: `Truck is already on the road (${onTruckStops.length} other stops on truck) — this freight was forgotten`,
              deliveredStops: onTruckStops.slice(0, 5),
            });
          }
        }

        result.routeStopCount = stops.length;
        result.routeDeliveredCount = deliveredStops.length;
        result.routeOnTruckCount = onTruckStops.length;
        result.loadStatus = loadStatus;

        console.log(`[ROUTE] pro:${pro} load:${loadNbr} loadStatus:${loadStatus} totalStops:${stops.length} delivered:${deliveredStops.length} onTruck:${onTruckStops.length}`);
        // Log every stop's status for diagnosis
        stops.forEach(ls => {
          const lsStop = ls.stop || {};
          const lsExec = ls.stopExecutionInfo || {};
          console.log(`[ROUTE]   stop ${lsStop.stopNbr}: status=${lsExec.stopStatus||'none'} consignee=${((lsStop.to||{}).address||{}).name||'?'}`);
        });
      }
    } catch (e) {
      console.log(`[LOAD] Error fetching load ${loadNbr}: ${e.message}`);
    }
  }

  // Set overall forgotten flag — but NOT if it's an appointment delivery
  // Appointment freight is SUPPOSED to be in the warehouse until its delivery date
  if (result.isAppointment) {
    // Remove forgotten-type flags — keep only the appointment flag
    result.flags = (result.flags || []).filter(f => f.type === 'appointment');
    result.isForgotten = false;
  } else {
    // Only forgotten if there are non-appointment flags
    const forgottenFlags = (result.flags || []).filter(f => f.type !== 'appointment');
    result.isForgotten = forgottenFlags.length > 0;
  }

  // Add requested delivery date (from schedule timeFrom)
  if (schedule.timeFrom) {
    result.requestedDate = schedule.timeFrom.split('T')[0];
    result.requestedDateFormatted = formatDate(result.requestedDate);
  }

  return result;
}

// ── Load Info ────────────────────────────────────────
async function getLoadInfo(loadNbr) {
  const url = `${BASE_URL}/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(COMPANY)}`;
  console.log(`[LOAD] ${url}`);
  const res = await rq(url, { headers: basicHeader() });
  console.log(`[LOAD] ${res.status}`);
  if (res.status !== 200) return { error: true, status: res.status };
  const data = JSON.parse(res.body);
  const view = data.Load || data.load || data;
  return {
    loadNbr: (view.loadHeader || {}).loadNbr || loadNbr,
    stops: view.stops || [],
    loadStatus: ((view.loadExecutionInfo || {}).loadStatus) || '',
  };
}

// ── Parse Stop ───────────────────────────────────────
function parseStop(data, pro) {
  const view = data.Stop || data.stop || data;
  const s = view.stop || {}; const l = view.load || {}; const x = view.stopExecutionInfo || {};
  const to = s.to || {}; const a = to.address || {}; const sch = to.schedule || {};
  const w = s.weight ? `${s.weight} ${s.weightUOM||'lbs'}` : '-';

  // Delivered timestamp from execution info
  const xTo = x.to || {};
  let deliveredAt = '-';
  if (xTo.confirmedDTTM) deliveredAt = ft(xTo.confirmedDTTM);
  else if (xTo.departureDTTM) deliveredAt = ft(xTo.departureDTTM);
  else if (xTo.arrivalDTTM) deliveredAt = ft(xTo.arrivalDTTM);
  else if (x.receiveDTTM) deliveredAt = ft(x.receiveDTTM);

  // Extract product details (what's supposed to be in the order)
  const rawDetails = s.stopDetails || [];
  const detailsList = Array.isArray(rawDetails) ? rawDetails : (rawDetails.stopDetail || []);
  const products = (Array.isArray(detailsList) ? detailsList : [detailsList]).filter(Boolean).map(d => ({
    product: d.product || '',
    quantity: d.quantity || '',
    uom: d.quantityUOM || '',
    orderDate: d.orderDate || '',
    palletID: (d.palletID && d.palletID.palletID) || '',
    weight: d.weight || '',
    description: d.productDescription || d.description || '',
  }));

  return {
    pro, stopNbr: s.stopNbr||pro, stopId: s.stopId||'', sealNbr: s.sealNbr||'',
    bol: s.bol||'', proNumber: s.proNumber||'', accountNumber: s.accountNumber||'',
    consignee: a.name||'-', address: [a.addr1,a.addr2].filter(Boolean).join(', ')||'-',
    city: a.city||'', state: a.state||'', zip: a.zip||'',
    fullAddress: [a.addr1,a.city,a.state,a.zip].filter(Boolean).join(', ')||'-',
    driver: l.driverName||'-', driverId: l.driverId||'', driverPhone: l.driverPhoneNum||'',
    route: l.routeName||l.loadNbr||'-', loadNbr: l.loadNbr||'',
    loadStatus: l.loadStatus||'', vehicleNbr: l.vehicleNbr||'',
    stop: s.stopSeq||s.altStopSeq||'-', weight: w,
    pallets: s.totalPallets||'-', cartons: s.totalCartons||'-',
    pieces: s.totalCartons||s.totalPallets||'-', deliveredAt,
    stopType: s.stopType||'', reference1: s.reference1||'', reference2: s.reference2||'',
    status: ms(x.stopStatus, x.exceptionPresent), stopStatusCode: x.stopStatus||'',
    exceptionPresent: x.exceptionPresent||false,
    custName: (s.custInfo||{}).custName||'', custAccNbr: (s.custInfo||{}).custAccNbr||'',
    products,
    flags: [],
    isForgotten: false,
    source: 'nuvizz_live',
  };
}

function ms(c,e) {
  switch(c) {
    case '90': case '91': case '80': return 'delivered';
    case '99': return 'cancelled';
    case '38': case '50': case '24': case '27': case '30': return 'on-truck';
    case '20': return e ? 'exception' : 'planned';
    case '05': case '10': return 'warehouse';
    default: return 'unknown';
  }
}

function ft(d) {
  if (!d) return '-';
  try { const [dt,t]=d.split('T'); const [h,m]=t.split(':'); const hr=parseInt(h,10); return `${hr%12||12}:${m} ${hr>=12?'PM':'AM'}`; }
  catch(e) { return d; }
}

function formatDate(d) {
  if (!d) return '';
  try { const [y,m,day] = d.split('-'); return `${parseInt(m)}/${parseInt(day)}/${y}`; }
  catch(e) { return d; }
}

// ── Mock ─────────────────────────────────────────────
const MOCK = {
  'DD001234':{pro:'DD001234',consignee:'DCO Tech Dr',driver:'Trevor Seyers',route:'ATL-N Route 2',stop:'3',weight:'840 lbs',status:'warehouse',flags:[{type:'route_active',severity:'high',message:'3 other stops on this route already delivered'}],isForgotten:true,source:'mock'},
  'DD005678':{pro:'DD005678',consignee:'Atlanta West Carpets',driver:'Trevarr Howard',route:'ATL-W Route 1',stop:'5',weight:'1120 lbs',status:'delivered',deliveredAt:'11:45 AM',flags:[],isForgotten:false,source:'mock'},
  'DD009999':{pro:'DD009999',consignee:'Floor Works',driver:'Brent Dixon',route:'ATL-S Route 3',stop:'2',weight:'560 lbs',status:'on-truck',flags:[],isForgotten:false,source:'mock'},
};

// ── Handler ──────────────────────────────────────────
exports.handler = async (event) => {
  const H = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,GET,OPTIONS','Content-Type':'application/json'};
  if (event.httpMethod==='OPTIONS') return {statusCode:200,headers:H,body:''};

  if (event.httpMethod==='GET') {
    const d = { env:{NUVIZZ_COMPANY:COMPANY,NUVIZZ_USER:USERNAME||'NOT SET',NUVIZZ_PASS:PASSWORD?'***'+PASSWORD.slice(-2):'NOT SET',NUVIZZ_BASE_URL:BASE_URL}, mode:(!USERNAME||!PASSWORD)?'MOCK':'LIVE' };
    if (USERNAME&&PASSWORD) {
      try {
        const url = `${BASE_URL}/auth/token/${encodeURIComponent(COMPANY)}`;
        const res = await rq(url, { headers: basicHeader() });
        if (res.status===200) { const tk=JSON.parse(res.body); d.auth={result:'OK',token:tk.authToken?tk.authToken.slice(0,20)+'...':'none'}; }
        else d.auth={result:'FAILED',status:res.status,body:res.body.slice(0,200)};
      } catch(e) { d.auth={result:'ERROR',msg:e.message}; }
    }
    return {statusCode:200,headers:H,body:JSON.stringify(d,null,2)};
  }

  if (event.httpMethod!=='POST') return {statusCode:405,headers:H,body:'{"error":"Method not allowed"}'};
  const body=JSON.parse(event.body||'{}');
  const pro=(body.pro||'').trim().toUpperCase();
  const quick = body.quick || false;
  const debug = body.debug || false;
  if (!pro) return {statusCode:400,headers:H,body:'{"error":"Missing PRO"}'};

  if (!USERNAME||!PASSWORD) {
    const r=MOCK[pro]||{error:'not_found',pro,message:'Not in mock data',source:'mock'};
    return {statusCode:200,headers:H,body:JSON.stringify(r)};
  }

  // Debug mode: return raw stop + load data to diagnose flag issues
  if (debug) {
    try {
      let paddedPro = pro;
      if (/^\d+$/.test(pro) && !pro.startsWith('00')) paddedPro = '00' + pro;
      const stopUrl = `${BASE_URL}/stop/info/${encodeURIComponent(paddedPro)}/${encodeURIComponent(COMPANY)}`;
      const stopRes = await rq(stopUrl, { headers: basicHeader() });
      const stopData = stopRes.status===200 ? JSON.parse(stopRes.body) : null;
      const view = stopData ? (stopData.Stop||stopData.stop||stopData) : null;
      const loadNbr = view ? ((view.load||{}).loadNbr || '') : '';
      let loadRaw = null;
      if (loadNbr) {
        const loadUrl = `${BASE_URL}/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(COMPANY)}`;
        const loadRes = await rq(loadUrl, { headers: basicHeader() });
        loadRaw = loadRes.status===200 ? JSON.parse(loadRes.body) : { status: loadRes.status, body: loadRes.body.slice(0,500) };
      }
      // Summarize load for quick scan
      const loadView = loadRaw ? (loadRaw.Load||loadRaw.load||loadRaw) : null;
      const summary = loadView ? {
        loadNbr: (loadView.loadHeader||{}).loadNbr,
        routeName: (loadView.loadHeader||{}).routeName,
        loadStatus: (loadView.loadExecutionInfo||{}).loadStatus,
        actualStartDTTM: (loadView.loadExecutionInfo||{}).actualStartDTTM,
        stops: (loadView.stops||[]).map(ls => ({
          stopNbr: (ls.stop||{}).stopNbr,
          stopSeq: (ls.stop||{}).stopSeq,
          consignee: (((ls.stop||{}).to||{}).address||{}).name,
          stopStatus: (ls.stopExecutionInfo||{}).stopStatus,
          exceptionPresent: (ls.stopExecutionInfo||{}).exceptionPresent,
          arrivalDTTM: ((ls.stopExecutionInfo||{}).to||{}).arrivalDTTM,
          confirmedDTTM: ((ls.stopExecutionInfo||{}).to||{}).confirmedDTTM,
          departureDTTM: ((ls.stopExecutionInfo||{}).to||{}).departureDTTM,
        })),
      } : null;
      return {statusCode:200,headers:H,body:JSON.stringify({pro: paddedPro, thisStop: view ? ((view.stop||{}).stopNbr) : null, summary, rawLoad: loadRaw}, null, 2)};
    } catch(e) {
      return {statusCode:200,headers:H,body:JSON.stringify({error:'debug_error',message:e.message,stack:e.stack})};
    }
  }

  try { return {statusCode:200,headers:H,body:JSON.stringify(await lookupStop(pro, quick))}; }
  catch(e){ console.error(e); return {statusCode:200,headers:H,body:JSON.stringify({error:'server_error',message:e.message,pro,source:'nuvizz_live'})}; }
};
