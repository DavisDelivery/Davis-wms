const https = require('https');
const { URL } = require('url');

const COMPANY = process.env.NUVIZZ_COMPANY || 'davis';
const USERNAME = process.env.NUVIZZ_USER;
const PASSWORD = process.env.NUVIZZ_PASS;
const BASE_URL = process.env.NUVIZZ_BASE_URL;

const URL_CANDIDATES = [
  'https://portal.nuvizz.com/deliverit/openapi/v7',
  'https://portal.nuvizz.com/api-gateway/webservices/nudeliverit/v7',
  'https://portal.nuvizz.com/api-gateway/webservices/nudeliverit/v5',
  'https://portal.nuvizz.com/deliverit/openapi/v5',
];

let workingBase = '';
let cachedToken = '';
let tokenExpiry = 0;

function rq(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const r = https.request({
      hostname: p.hostname, path: p.pathname + p.search,
      method: opts.method || 'GET',
      headers: { 'Accept':'application/json','Content-Type':'application/json', ...opts.headers },
      timeout: 12000,
    }, res => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({status:res.statusCode,body:b})); });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry && workingBase) return { token: cachedToken, base: workingBase };

  const basic = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  const urls = BASE_URL ? [BASE_URL] : URL_CANDIDATES;
  const tried = [];

  for (const base of urls) {
    const url = `${base}/auth/token/${encodeURIComponent(COMPANY)}`;
    console.log(`[AUTH] ${url}`);
    try {
      const res = await rq(url, { headers: { 'Authorization': `Basic ${basic}` } });
      tried.push({ url, status: res.status, body: res.body.slice(0, 300) });
      console.log(`[AUTH] ${res.status} ${res.body.slice(0, 200)}`);

      if (res.status === 401 || res.status === 403) {
        return { error: `Bad credentials (HTTP ${res.status})`, tried };
      }
      if (res.status === 200) {
        let data; try { data = JSON.parse(res.body); } catch(e) { continue; }
        if (data.authToken) {
          workingBase = base; cachedToken = data.authToken;
          tokenExpiry = data.expiresAt ? (Number(data.expiresAt)*1000)-300000 : Date.now()+3300000;
          return { token: cachedToken, base: workingBase };
        }
        if (data.reasons) return { error: 'Auth rejected', reasons: data.reasons, tried };
      }
    } catch(e) { tried.push({ url, status: 0, error: e.message }); }
  }
  return { error: 'No working API URL found', tried };
}

async function lookupStop(pro) {
  const auth = await getToken();
  if (auth.error) return { error:'auth_failed', message:auth.error, tried:auth.tried, reasons:auth.reasons, source:'nuvizz_live' };

  const url = `${auth.base}/stop/info/${encodeURIComponent(pro)}/${encodeURIComponent(COMPANY)}`;
  console.log(`[LOOKUP] ${url}`);
  const res = await rq(url, { headers: { 'Authorization': `Bearer ${auth.token}` } });
  console.log(`[LOOKUP] ${res.status} ${res.body.slice(0,500)}`);

  if (res.status === 404 || res.status === 409) return { error:'not_found', pro, message:`Stop not found (HTTP ${res.status})`, apiUrl:url, detail:res.body.slice(0,300), source:'nuvizz_live' };
  if (res.status === 401) {
    cachedToken=''; tokenExpiry=0; workingBase='';
    const a2 = await getToken(); if (a2.error) return { error:'auth_retry_failed', message:a2.error, source:'nuvizz_live' };
    const r2 = await rq(`${a2.base}/stop/info/${encodeURIComponent(pro)}/${encodeURIComponent(COMPANY)}`, { headers:{'Authorization':`Bearer ${a2.token}`} });
    if (r2.status !== 200) return { error:'retry_failed', httpStatus:r2.status, detail:r2.body.slice(0,300), source:'nuvizz_live' };
    return parse(JSON.parse(r2.body), pro);
  }
  if (res.status !== 200) return { error:'api_error', pro, httpStatus:res.status, detail:res.body.slice(0,500), apiUrl:url, source:'nuvizz_live' };

  let data; try { data = JSON.parse(res.body); } catch(e) { return { error:'parse_error', detail:res.body.slice(0,500), source:'nuvizz_live' }; }
  return parse(data, pro);
}

function parse(data, pro) {
  const view = data.Stop || data.stop || data;
  const s = view.stop || {}; const l = view.load || {}; const x = view.stopExecutionInfo || {};
  const to = s.to || {}; const a = to.address || {}; const sch = to.schedule || {};
  const w = s.weight ? `${s.weight} ${s.weightUOM||'lbs'}` : '-';
  let sched = '-';
  if (sch.timeFrom && sch.timeTo) sched = `${ft(sch.timeFrom)} - ${ft(sch.timeTo)}`;
  else if (sch.timeFrom) sched = `By ${ft(sch.timeFrom)}`;
  return {
    pro, stopNbr:s.stopNbr||pro, stopId:s.stopId||'', sealNbr:s.sealNbr||'',
    bol:s.bol||'', proNumber:s.proNumber||'', accountNumber:s.accountNumber||'',
    consignee:a.name||'-', address:[a.addr1,a.addr2].filter(Boolean).join(', ')||'-',
    city:a.city||'', state:a.state||'', zip:a.zip||'',
    fullAddress:[a.addr1,a.city,a.state,a.zip].filter(Boolean).join(', ')||'-',
    driver:l.driverName||'-', driverId:l.driverId||'', driverPhone:l.driverPhoneNum||'',
    route:l.routeName||l.loadNbr||'-', loadNbr:l.loadNbr||'',
    loadStatus:l.loadStatus||'', vehicleNbr:l.vehicleNbr||'',
    stop:s.stopSeq||s.altStopSeq||'-', weight:w,
    pallets:s.totalPallets||'-', cartons:s.totalCartons||'-',
    pieces:s.totalCartons||s.totalPallets||'-', scheduled:sched,
    stopType:s.stopType||'', reference1:s.reference1||'', reference2:s.reference2||'',
    status:ms(x.stopStatus,x.exceptionPresent), stopStatusCode:x.stopStatus||'',
    exceptionPresent:x.exceptionPresent||false,
    custName:(s.custInfo||{}).custName||'', custAccNbr:(s.custInfo||{}).custAccNbr||'',
    source:'nuvizz_live',
  };
}
function ms(c,e){switch(c){case'90':case'91':case'80':return'delivered';case'99':return'cancelled';case'38':case'50':case'24':case'27':case'30':return'on-truck';case'20':return e?'exception':'planned';case'05':case'10':return'warehouse';default:return'unknown';}}
function ft(d){if(!d)return'';try{const[,t]=d.split('T');const[h,m]=t.split(':');const hr=parseInt(h,10);return`${hr%12||12}:${m} ${hr>=12?'PM':'AM'}`;}catch(e){return d;}}

const MOCK = {
  'DD001234':{pro:'DD001234',consignee:'DCO Tech Dr',driver:'Trevor Seyers',route:'ATL-N Route 2',stop:'3',weight:'840 lbs',status:'warehouse',source:'mock'},
  'DD005678':{pro:'DD005678',consignee:'Atlanta West Carpets',driver:'Trevarr Howard',route:'ATL-W Route 1',stop:'5',weight:'1120 lbs',status:'delivered',source:'mock'},
  'DD009999':{pro:'DD009999',consignee:'Floor Works',driver:'Brent Dixon',route:'ATL-S Route 3',stop:'2',weight:'560 lbs',status:'on-truck',source:'mock'},
};

exports.handler = async (event) => {
  const H = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,GET,OPTIONS','Content-Type':'application/json'};
  if (event.httpMethod==='OPTIONS') return {statusCode:200,headers:H,body:''};

  if (event.httpMethod==='GET') {
    const d = {
      env:{NUVIZZ_COMPANY:COMPANY,NUVIZZ_USER:USERNAME||'NOT SET',NUVIZZ_PASS:PASSWORD?'***'+PASSWORD.slice(-2):'NOT SET',NUVIZZ_BASE_URL:BASE_URL||'auto-detect'},
      mode:(!USERNAME||!PASSWORD)?'MOCK':'LIVE',
      candidates:BASE_URL?[BASE_URL]:URL_CANDIDATES,
    };
    if (USERNAME&&PASSWORD) {
      try {
        const a=await getToken();
        d.auth=a.error?{result:'FAILED',error:a.error,tried:a.tried}:{result:'OK',workingUrl:a.base,token:a.token.slice(0,20)+'...'};
      } catch(e){d.auth={result:'ERROR',msg:e.message};}
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
