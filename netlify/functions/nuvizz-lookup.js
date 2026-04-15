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
async function lookupStop(pro) {
  // Uline PROs need 00 prefix for NuVizz
  let paddedPro = pro;
  if (/^\d+$/.test(pro) && !pro.startsWith('00')) {
    paddedPro = '00' + pro;
  }
  return await tryStopLookup(paddedPro);
}

async function tryStopLookup(pro) {
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
  // Check structured apptInfo
  const appt = stop.apptInfo || {};
  if (appt.apptId || appt.apptStatus || appt.apptDate) {
    const apptDate = appt.apptDate || '';
    const apptTime = [appt.startTime, appt.endTime].filter(Boolean).join(' - ');
    const apptStatus = appt.apptStatus || '';
    result.flags = result.flags || [];
    result.flags.push({
      type: 'appointment',
      severity: 'high',
      message: `Appointment delivery${apptDate ? ' on ' + formatDate(apptDate) : ''}${apptTime ? ' (' + apptTime + ')' : ''}${apptStatus ? ' — ' + apptStatus : ''}`,
      apptDate, apptTime, apptStatus,
    });
    result.isAppointment = true;
    result.apptDate = apptDate;
    result.apptTime = apptTime;
    result.apptStatus = apptStatus;
  }

  // Check comments for "NTFY OF DELIVERY-APPT REQD" (exact Uline code) and similar
  const comments = stop.comments || {};
  const commentList = comments.comment || comments.comments || [];
  const allComments = Array.isArray(commentList) ? commentList : [commentList];
  let apptComment = null;
  for (const c of allComments) {
    if (!c) continue;
    const desc = (c.commentDescription || c.description || '').toUpperCase();
    const cType = (c.commentType || c.cmtType || '').toUpperCase();
    // Exact Uline code: "NTFY OF DELIVERY-APPT REQD"
    if (desc.includes('NTFY OF DELIVERY') || desc.includes('APPT REQ') ||
        desc.includes('NTFY') || desc.includes('APPT') ||
        cType.includes('NTFY') || cType.includes('APPT')) {
      apptComment = c.commentDescription || c.description || cType;
      break;
    }
  }
  if (apptComment && !result.isAppointment) {
    result.flags = result.flags || [];
    result.flags.push({
      type: 'appointment',
      severity: 'high',
      message: `Appointment required — ${apptComment}`,
    });
    result.isAppointment = true;
    result.apptNote = apptComment;
  }

  // Also check ALL string fields on the stop for the Uline code
  // It could be in reference1, reference2, srvcLevel, profile, consAttribute, customAttributes, or stopDetails
  const searchFields = [
    stop.reference1, stop.reference2, stop.srvcLevel, stop.profile,
    stop.consAttribute, stop.freightTerms, stop.serviceType,
    JSON.stringify(stop.customAttributes || {}),
    JSON.stringify(stop.stopDetails || {}),
    JSON.stringify(stop.stopAccessorials || {}),
    JSON.stringify(stop.privateNotes || {}),
  ];
  if (!result.isAppointment) {
    for (const f of searchFields) {
      if (!f) continue;
      const upper = f.toUpperCase();
      if (upper.includes('NTFY OF DELIVERY') || upper.includes('APPT REQ') ||
          (upper.includes('NTFY') && upper.includes('APPT'))) {
        result.flags = result.flags || [];
        result.flags.push({
          type: 'appointment',
          severity: 'high',
          message: 'Appointment required — NTFY OF DELIVERY-APPT REQD',
        });
        result.isAppointment = true;
        break;
      }
    }
  }

  // Log raw data for debugging where appointment codes appear
  console.log(`[APPT-DEBUG] pro:${pro} isAppt:${result.isAppointment}`);
  console.log(`[APPT-DEBUG] apptInfo:`, JSON.stringify(appt));
  console.log(`[APPT-DEBUG] comments:`, JSON.stringify(allComments).slice(0, 800));
  console.log(`[APPT-DEBUG] ref1:${stop.reference1||''} ref2:${stop.reference2||''} srvcLevel:${stop.srvcLevel||''} profile:${stop.profile||''}`);
  console.log(`[APPT-DEBUG] consAttribute:${stop.consAttribute||''} freightTerms:${stop.freightTerms||''} serviceType:${stop.serviceType||''}`);
  if (stop.customAttributes) console.log(`[APPT-DEBUG] customAttrs:`, JSON.stringify(stop.customAttributes).slice(0, 500));
  if (stop.stopDetails) console.log(`[APPT-DEBUG] stopDetails:`, JSON.stringify(stop.stopDetails).slice(0, 500));
  if (stop.privateNotes) console.log(`[APPT-DEBUG] privateNotes:`, JSON.stringify(stop.privateNotes).slice(0, 300));

  // ── Flag 2 & 3: Need load info for route-level checks ──
  const loadNbr = result.loadNbr;
  if (loadNbr && loadNbr !== '-') {
    try {
      const loadData = await getLoadInfo(loadNbr);
      if (loadData && !loadData.error) {
        const stops = loadData.stops || [];
        const thisStopNbr = result.stopNbr || pro;

        // Flag 2: Check if any part of this stop has been delivered (multipiece)
        // If the stop itself shows status < 90 but execution has partial completion
        const exec = ((data.Stop || data.stop || data).stopExecutionInfo || {});
        const xTo = exec.to || {};
        if (result.status !== 'delivered' && (xTo.confirmedDTTM || xTo.arrivalDTTM || xTo.departureDTTM)) {
          result.flags = result.flags || [];
          result.flags.push({ type: 'partial_delivery', severity: 'high', message: 'Partial delivery detected — driver visited this stop but freight still here' });
        }

        // Flag 3: Check if ANY other stop on this route has been delivered
        const deliveredStops = [];
        for (const ls of stops) {
          const lsStop = ls.stop || {};
          const lsExec = ls.stopExecutionInfo || {};
          const lsStopNbr = lsStop.stopNbr || '';
          if (lsStopNbr === thisStopNbr) continue; // skip self
          
          const lsStatus = lsExec.stopStatus || '';
          // 90=Completed, 91=Manually Completed, 80=Closed
          if (lsStatus === '90' || lsStatus === '91' || lsStatus === '80') {
            const lsAddr = ((lsStop.to || {}).address || {});
            deliveredStops.push({
              stopNbr: lsStopNbr,
              consignee: lsAddr.name || lsStopNbr,
              status: lsStatus,
            });
          }
          // Also check if stop has actual arrival/departure timestamps
          const lsTo = lsExec.to || {};
          if (!deliveredStops.find(d => d.stopNbr === lsStopNbr) && (lsTo.confirmedDTTM || lsTo.departureDTTM)) {
            deliveredStops.push({
              stopNbr: lsStopNbr,
              consignee: ((lsStop.to || {}).address || {}).name || lsStopNbr,
              status: lsStatus,
              note: 'has delivery timestamps',
            });
          }
        }

        if (deliveredStops.length > 0 && result.status !== 'delivered') {
          result.flags = result.flags || [];
          result.flags.push({
            type: 'route_active',
            severity: 'high',
            message: `${deliveredStops.length} other stop(s) on this route already delivered — this freight is forgotten`,
            deliveredStops: deliveredStops.slice(0, 5), // limit to 5 for payload size
          });
        }

        result.routeStopCount = stops.length;
        result.routeDeliveredCount = deliveredStops.length;
      }
    } catch (e) {
      console.log(`[LOAD] Error fetching load ${loadNbr}: ${e.message}`);
      // Non-fatal — still return the stop data
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
  if (!pro) return {statusCode:400,headers:H,body:'{"error":"Missing PRO"}'};

  if (!USERNAME||!PASSWORD) {
    const r=MOCK[pro]||{error:'not_found',pro,message:'Not in mock data',source:'mock'};
    return {statusCode:200,headers:H,body:JSON.stringify(r)};
  }

  try { return {statusCode:200,headers:H,body:JSON.stringify(await lookupStop(pro))}; }
  catch(e){ console.error(e); return {statusCode:200,headers:H,body:JSON.stringify({error:'server_error',message:e.message,pro,source:'nuvizz_live'})}; }
};
