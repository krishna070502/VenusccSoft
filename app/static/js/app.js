
/* =======================================================================
   VENUS CHICKEN CENTERS — Operations Console
   DATA LAYER: all persistence goes through DB below. To connect the real
   database, replace each DB method body with a fetch() to your API.
   ======================================================================= */
(function () {
'use strict';

var mem = {};
var LS = {
  get:function(k){ try{ return localStorage.getItem(k); }catch(e){ return mem[k]||null; } },
  set:function(k,val){ try{ localStorage.setItem(k,val); }catch(e){ mem[k]=val; toast('Storage full — reduce photos.','error'); } },
  del:function(k){ try{ localStorage.removeItem(k); }catch(e){ delete mem[k]; } }
};
var K = { users:'vcc_users', branches:'vcc_branches', entries:'vcc_entries',
          workers:'vcc_workers', ledger:'vcc_ledger', settings:'vcc_settings', session:'vcc_session',
          activity:'vcc_activity', logoutReason:'vcc_logout_reason', overheads:'vcc_overheads',
          /* Which screen/branch/entry to come back to after a reload — a plain
             browser refresh used to always land back on the Dashboard (or the
             blank Entry form) no matter what was open, which felt like losing
             your place. lastEntry is '' for "no entry open" (a genuine blank
             new-entry screen) vs unset/missing for "nothing recorded yet". */
          lastView:'vcc_last_view', lastBranch:'vcc_last_branch', lastEntry:'vcc_last_entry' };
var DB = {
  read:function(key,fb){ var r=LS.get(key); if(!r) return fb;
    try{ var val=JSON.parse(r); return (val===null||val===undefined)?fb:val; }catch(e){ return fb; } },
  write:function(key,val){ LS.set(key,JSON.stringify(val)); },
  clearAll:function(){ Object.keys(K).forEach(function(k){ LS.del(K[k]); }); }
};

var DEFAULT_BRANCHES = { B01:'Branch 01 — Main Hub', B02:'Branch 02 — Downtown' };
/* Left over from the browser-only version, which kept accounts in
   localStorage. Authentication is server-side now — loadAll() below is
   replaced by bootstrap() — so this is dead, and it is deliberately empty:
   shipping usernames and passwords in a file anyone can read is not something
   to leave lying around just because nothing reads it any more. */
var DEFAULT_USERS = [];
var DEFAULT_SETTINGS = { wasteBroiler:31, wasteParents:21, tolerance:2, dayWage:600 };
var OVERHEAD_CATS = [
  { v:'supervisor_salary', t:'Supervisor salary', ic:'fa-user-tie' },
  { v:'rent',              t:'Shop rent',         ic:'fa-shop' },
  { v:'electricity',       t:'Electricity bill',  ic:'fa-bolt' },
  { v:'water',             t:'Water bill',        ic:'fa-droplet' },
  { v:'maintenance',       t:'Maintenance',       ic:'fa-screwdriver-wrench' },
  { v:'licence',           t:'Licence & taxes',   ic:'fa-stamp' },
  { v:'transport',         t:'Transport',         ic:'fa-truck' },
  { v:'other',             t:'Other overhead',    ic:'fa-receipt' }
];
var LEDGER_TYPES = {
  work:   { t:'Work day',       effect:'earn',    shop:true  },
  paid:   { t:'Payment made',   effect:'settle',  shop:false },
  advance:{ t:'Advance given',  effect:'settle',  shop:false },
  tea:    { t:'Tea',            effect:'none',    shop:true  },
  tiffin: { t:'Tiffin',         effect:'none',    shop:true  },
  other:  { t:'Other shop cost',effect:'none',    shop:true  }
};

/* Admin has no idle limit at all — Infinity here is just the safe fallback
   before bootstrap()'s real (server-configured) value arrives; tickSession()
   also short-circuits for admin so the countdown pill/warning never show.
   The supervisor fallback mirrors config.py's default (30 min) — it's only
   ever used in the sliver of time before bootstrap() overwrites it with the
   server's real value, but should still agree with the server if it is. */
var IDLE_MS = { admin: Infinity, supervisor: 30*60*1000 };
var IDLE_WARN = 30*1000;

/* Hotels & hostels buy under the counter rate. PRODUCTS keeps the three
   sellable meat lines in one place so the form, the deal and the ledger can
   never drift apart. */
var PRODUCTS = [
  { v:'skin',     t:'Skin',       rate:'rateSkin',     less:'lessSkin',     fixed:'rateSkin',     meat:true  },
  { v:'skinless', t:'Skinless',   rate:'rateSkinless', less:'lessSkinless', fixed:'rateSkinless', meat:true  },
  { v:'liver',    t:'Liver',      rate:'rateLiver',    less:'lessLiver',    fixed:'rateLiver',    meat:true  },
  /* a live bird leaves the shed whole: it comes off the BIRD stock, not the
     meat pool, so it needs a head count as well as a weight */
  { v:'live',     t:'Live birds', rate:'rateLive',     less:'lessLive',     fixed:'rateLive',     meat:false }
];
function productDef(v){ return PRODUCTS.filter(function(p){ return p.v===v; })[0] || PRODUCTS[0]; }

var CUSTOMER_KINDS = [
  { v:'hotel',    t:'Hotel',    ic:'fa-hotel',        cls:'bg-indigo-100 text-indigo-800' },
  { v:'hostel',   t:'Hostel',   ic:'fa-building-user',cls:'bg-violet-100 text-violet-800' },
  { v:'function', t:'Function', ic:'fa-champagne-glasses', cls:'bg-pink-100 text-pink-800' }
];
function kindDef(v){ return CUSTOMER_KINDS.filter(function(k){ return k.v===v; })[0] || CUSTOMER_KINDS[0]; }

var S = { users:[], branches:{}, entries:[], workers:[], ledger:[], overheads:[], settings:{}, activity:[],
          customers:[], receipts:[], customerAdjustments:[], custTotals:{}, closes:[],
          window:null, fetching:null, ovhScope:'branch', ovhLedger:null, wkLedger:null, dcCurrent:null, closeHistory:[],
          lastAct:Date.now(), auto:{ closeBirds:true, closeWt:true },
          user:null, branch:null, cat:'broiler', dashCat:'all', dashScope:'branch',
          editing:null, photos:[], purchases:[], hotelSales:[], charts:{}, carryForward:null,
          purchaseLedger:null, openPurchases:{} };

/* ---------------- helpers ---------------- */
function $(id){ return document.getElementById(id); }
function qsa(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); }
function num(v){ var x=parseFloat(v); return isFinite(x)?x:0; }
function v(id){ var el=$(id); return el?num(el.value):0; }
function tv(id){ var el=$(id); return el?String(el.value||'').trim():''; }
function filled(id){ var el=$(id); return !!(el && String(el.value||'').trim()!==''); }
function filledG(id){ var a=$(id+'_kg'),b=$(id+'_g'); return !!((a&&String(a.value||'').trim()!=='')||(b&&String(b.value||'').trim()!=='')); }
function gv(id){ return v(id+'_kg')*1000 + v(id+'_g'); }
function setG(id,g){ g=Math.round(num(g)); var a=$(id+'_kg'); if(a) a.value=g?Math.floor(g/1000):''; var b=$(id+'_g'); if(b) b.value=g?(g%1000):''; }
function setV(id,x){ var el=$(id); if(el) el.value=(x===0||x)?x:''; }
function fmtW(g){ g=Math.round(num(g)); var s=g<0?'-':''; g=Math.abs(g); return s+Math.floor(g/1000)+'.'+String(g%1000).padStart(3,'0')+' kg'; }
function fmtWs(g){ g=Math.round(num(g)); var s=g<0?'-':''; g=Math.abs(g); return s+Math.floor(g/1000)+' kg '+(g%1000)+' g'; }
function money(x){ x=num(x); return (x<0?'−₹':'₹')+Math.abs(x).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function money0(x){ x=num(x); return (x<0?'−₹':'₹')+Math.round(Math.abs(x)).toLocaleString('en-IN'); }
function pct(x,d){ return num(x).toFixed(d===undefined?1:d)+'%'; }
function uid(p){ return (p||'x')+Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function todayISO(d){ d=d||new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function nowLocal(){ var d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,16); }
function dOf(dt){ return String(dt||'').slice(0,10); }
function addDays(iso,k){ var p=iso.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]); d.setDate(d.getDate()+k); return todayISO(d); }
function shortD(iso){ var p=String(iso).split('-'); return p[2]+'/'+p[1]; }
function monthStart(){ var d=new Date(); return todayISO(new Date(d.getFullYear(),d.getMonth(),1)); }

function toast(msg,type){
  var el=$('toast'); if(!el) return;
  var c=type==='error'?'bg-rose-600 text-white':type==='warn'?'bg-amber-500 text-emerald-900':'bg-emerald-700 text-white';
  var i=type==='error'?'fa-circle-exclamation':type==='warn'?'fa-triangle-exclamation':'fa-circle-check';
  el.innerHTML='<div class="'+c+' px-5 py-3 rounded-xl shadow-2xl flex items-center gap-3 text-sm font-semibold max-w-sm pop"><i class="fa-solid '+i+'"></i>'+esc(msg)+'</div>';
  el.classList.remove('hidden'); clearTimeout(el._t); el._t=setTimeout(function(){el.classList.add('hidden');},3600);
}

/* ---------------- running chicken ---------------- */
function runChicken(){
  var o=$('runOverlay'), t=$('runTrack'); if(!o||!t) return;
  o.classList.remove('hidden');
  t.classList.remove('runner'); void t.offsetWidth; t.classList.add('runner');
  clearTimeout(o._t); o._t=setTimeout(function(){ o.classList.add('hidden'); t.classList.remove('runner'); },2450);
}

/* ---------------- calculation engine ---------------- */
function wasteFor(cat){ return cat==='parents'?num(S.settings.wasteParents):num(S.settings.wasteBroiler); }

function labourFor(date,branch){
  var earn=0, adv=0, other=0, days=0;
  S.ledger.forEach(function(l){
    if(l.branch!==branch || l.date!==date) return;
    var def=LEDGER_TYPES[l.type]||{};
    if(l.type==='work'){ earn+=num(l.amount); days+=num(l.days); }
    else if(l.type==='advance'){ adv+=num(l.amount); }
    else if(def.shop) other+=num(l.amount);
  });
  return { wages:earn, advances:adv, other:other, manDays:days };
}

/* What one day carries of a branch's overheads. A DATED cost lands on its own
   day in full; an undated monthly one is spread evenly across the month.
   Mirrors overhead_day_share() in api.py. */
function overheadDayShare(date,branch){
  var month=String(date).slice(0,7), spread=0, dated=0;
  S.overheads.forEach(function(o){
    if(o.branch!==branch || o.status!=='approved') return;
    if(o.date){ if(o.date===date) dated+=num(o.amount); }
    else if(o.month===month) spread+=num(o.amount);
  });
  var p=String(date).split('-');
  var dim=new Date(+p[0], +p[1], 0).getDate();
  return (dim ? spread/dim : 0) + dated;
}

/* Costs for one branch-day. Mirrors day_costs_for() in api.py.
   selfId is the id of the entry this call is being made for (may be a
   brand-new, not-yet-saved draft — always counted as present for its own
   category, so a draft second entry sees the same picture Approval will
   show once it's saved, instead of looking like it's the only one there).

   When only one category has an entry that day, it carries the whole
   day's wages/overheads, same as ever. When BOTH broiler and parents have
   an entry the same day, they're worked by the same crew — the whole
   day's cost is charged to broiler, and parents carries none of it that
   day, rather than splitting it evenly. */
function dayCostsFor(date,branch,selfId,category){
  var lab=labourFor(date,branch);
  var categories={}; categories[category]=1;
  S.entries.forEach(function(e){
    if(e.branch===branch && dOf(e.datetime)===date && e.id!==selfId) categories[e.category]=1;
  });
  var shared=Object.keys(categories).length||1;
  if(category==='parents' && categories.broiler && categories.parents){
    return { wages:0, advances:0, other:0, manDays:0, overheads:0, shared:shared };
  }
  return { wages:lab.wages, advances:lab.advances, other:lab.other,
           manDays:lab.manDays, overheads:overheadDayShare(date,branch),
           shared:shared };
}

/* What one hotel/hostel line is worth. Mirrors price_hotel_line() in calc.py —
   the server recomputes this before anything is stored, this copy only exists
   so the figures move while the supervisor is still typing. */
function priceHotelLine(line,e){
  line=line||{}; e=e||{};
  var def=productDef(line.product);
  var market=num(e[def.rate]);
  var rate;
  if(line.rateOverride!==null && line.rateOverride!==undefined && line.rateOverride!=='') rate=num(line.rateOverride);
  else if(line.mode==='fixed') rate=num(line.fixed);
  else rate=market-num(line.less);
  if(rate<0) rate=0;
  var kg=num(line.weightG)/1000;
  /* signed on purpose: positive is a concession given away, negative is a
     premium earned (the customer's less/adjustment figure went negative —
     see applyDeal()/customerModal()) — mirrors price_hotel_line() in calc.py */
  return { product:def.v, grams:num(line.weightG), market:market, rate:rate,
           amount:kg*rate, concession:kg*(market-rate),
           birds:def.v==='live'?num(line.birds):0,
           settled:!!line.settled };
}

function calc(e){
  e=e||{};
  var wastePct=wasteFor(e.category), expYield=100-wastePct, yieldFrac=expYield/100;
  var tol=num(S.settings.tolerance);

  /* ---- purchases & weighted average cost ---- */
  /* Birds returned to a supplier (kind==='return') physically leave the shed
     on the day the return is recorded — whether bought today or weeks ago —
     so they come off today's available stock the same way a live sale or
     mortality does; mirrors compute_entry() (calc.py). buyBirds/buyWtG/buyAmt
     stay GROSS (what was bought, matching the Dashboard's "purchased" figure
     and the purchase ledger's own "bought" column) — only availWtG/availValue
     net the return out, priced at the original purchase's own rate so the
     average cost of what's left is unchanged. */
  var rows=e.purchases||[];
  var buyBirds=0, buyWtG=0, buyAmt=0;
  var returnBirds=0, returnWtG=0, returnAmt=0;
  rows.forEach(function(r){
    if(r.kind==='return'){
      returnBirds+=num(r.birds); returnWtG+=num(r.wtG); returnAmt+=num(r.wtG)/1000*num(r.rate);
      return;
    }
    buyBirds+=num(r.birds); buyWtG+=num(r.wtG); buyAmt+=num(r.wtG)/1000*num(r.rate); });

  var openWtG=num(e.openWtG), openRate=num(e.openRate);
  var openValue=openWtG/1000*openRate;
  var availWtG=openWtG+buyWtG-returnWtG, availValue=openValue+buyAmt-returnAmt;
  var avgRate=availWtG>0 ? availValue/(availWtG/1000) : openRate;
  var meatCostKg=yieldFrac>0 ? avgRate/yieldFrac : 0;

  /* ---- dressing ---- */
  var dressedWtG=num(e.dressedWtG);
  /* Math.floor, not a bare multiply — mirrors int(dressed_wt_g * yield_frac)
     in compute_entry() (calc.py). Without the floor, a fractional gram
     (e.g. 14007g * 78% = 10925.46g) left expectedMeatG a hair above the
     server's truncated 10925g, so an exact-match entry could show a tiny
     phantom shortfall here (a red "-0.000 kg" bonus/short chip) that the
     server-side saved figures never had. */
  var expectedMeatG=Math.floor(dressedWtG*yieldFrac);
  /* derived from the truncated expectedMeatG, not a fresh dressedWtG*waste%
     multiply — mirrors waste_meat_g = dressed_wt_g - expected_meat_g in
     calc.py exactly, so this and "Expected meat" always add up to the
     dressed weight on the nose, on both client and server. */
  var wasteMeatG=dressedWtG-expectedMeatG;

  /* ---- revenue ---- */
  var skinAmt=num(e.skinSoldG)/1000*num(e.rateSkin);
  var skinlessAmt=num(e.skinlessSoldG)/1000*num(e.rateSkinless);
  var liverAmt=num(e.liverSoldG)/1000*num(e.rateLiver);
  var liveAmt=num(e.liveSoldWtG)/1000*num(e.rateLive);
  var cutAmt=num(e.cutCharges);
  var counterSaleAmt=skinAmt+skinlessAmt+liverAmt;

  /* ---- hotel & hostel sales (extra to the counter figures above) ---- */
  var hotelLines=(e.hotelSales||[]).map(function(l){ return priceHotelLine(l,e); });
  var hotelG={skin:0,skinless:0,liver:0,live:0};
  var hotelAmt=0, hotelConcession=0, hotelCash=0, hotelCredit=0, hotelBirds=0;
  hotelLines.forEach(function(h){
    hotelG[h.product]+=h.grams; hotelBirds+=h.birds;
    hotelAmt+=h.amount; hotelConcession+=h.concession;
    if(h.settled) hotelCash+=h.amount; else hotelCredit+=h.amount;
  });
  /* meat leaves the pool; live birds leave the shed */
  var hotelMeatG=hotelG.skin+hotelG.skinless+hotelG.liver;
  var hotelLiveG=hotelG.live;
  var hotelTotalG=hotelMeatG+hotelLiveG;

  var meatSaleAmt=counterSaleAmt+hotelAmt;
  var revenue=meatSaleAmt+liveAmt+cutAmt;

  /* ---- actual meat obtained (derived from the physical closing count) ----
     Closing meat is a real physical count (Section G on the entry form),
     not a formula output any more — mirrors compute_entry() (calc.py).
     Actual meat obtained is reconciled FROM it: whatever was sold at the
     counter, sold to a hotel/hostel, or written off as damage, plus
     whatever is physically left over at closing, is what must have come
     out of dressing today. bonus/short meat are unchanged in meaning, just
     fed from this reconciled figure now instead of a typed one. */
  var closeMeatG=num(e.closeMeatG);
  var actualMeatG=closeMeatG+num(e.skinSoldG)+num(e.skinlessSoldG)+num(e.liverSoldG)+hotelMeatG+num(e.damageG);
  var varianceG=actualMeatG-expectedMeatG;
  var bonusG=Math.max(varianceG,0), shortG=Math.max(-varianceG,0);
  var yieldPct=dressedWtG>0?(actualMeatG/dressedWtG)*100:0;
  var yieldLow=dressedWtG>0&&actualMeatG>0&&yieldPct<expYield-tol;
  var yieldHigh=dressedWtG>0&&yieldPct>expYield+tol;

  /* ---- birds & meat balance ---- */
  var handled=num(e.openBirds)+buyBirds-returnBirds;
  /* Unlike opening meat, opening birds legitimately belongs in this sum —
     a bird in the shed from yesterday and one bought this morning are the
     same stock. Still floor the result: more recorded sold/dressed/dead
     than were on hand must show as a same-day deficit, not a negative
     headcount that compounds into tomorrow's opening count. */
  var expBirdsRaw=handled-num(e.liveSoldCount)-hotelBirds-num(e.mortCount)-num(e.dressedCount);
  var birdDeficit=Math.max(-expBirdsRaw,0);
  var expBirds=Math.max(expBirdsRaw,0);
  var birdVar=expBirds-num(e.closeBirds);
  var mortRate=handled>0?(num(e.mortCount)/handled)*100:0;
  var meatAvailG=num(e.openMeatG)+actualMeatG;
  var expCloseWtGRaw=availWtG-num(e.liveSoldWtG)-hotelLiveG-num(e.mortWtG)-dressedWtG;
  var wtDeficitG=Math.max(-expCloseWtGRaw,0);
  var expCloseWtG=Math.max(expCloseWtGRaw,0);
  /* Birds and weight are tracked independently, so every bird handled today
     can be fully accounted for (expBirds hits exactly 0) while the weight
     side still shows something left over — that leftover has no bird left
     to sit on, so it is pulled out as a live-bird weight shortage instead of
     being carried forward as tomorrow's opening weight. Mirrors calc.py. */
  var liveShortWtG=expBirds===0?expCloseWtG:0;
  if(liveShortWtG) expCloseWtG=0;
  var liveShortValue=liveShortWtG/1000*avgRate;
  /* Closing meat is a direct physical count now, not a formula output, so
     there's nothing left to derive or floor — it simply IS what was
     entered in Section G, and it's what becomes tomorrow's opening meat.
     meatVarG/meatDeficitG stay at zero by construction here; kept only so
     the Meat shortfall report and older approved entries (computed before
     this change, when they could be nonzero) keep working. */
  var expCloseMeatG=closeMeatG;
  var meatVarG=0, meatDeficitG=0;

  /* ---- feed purchase ----
     A single feed purchase for the day, bags @ a price per bag. A straight
     cost against the day (chicken feed, not birds), so it comes off net
     profit the same way wages/overheads do — mirrors calc.py. */
  var feedBags=num(e.feedBags);
  var feedRate=num(e.feedRate);
  var feedAmt=feedBags*feedRate;

  /* ---- profit & loss ---- */
  var openMeatValue=num(e.openMeatG)/1000*meatCostKg;
  var closeLiveValue=num(e.closeWtG)/1000*avgRate;
  var closeMeatValue=num(e.closeMeatG)/1000*meatCostKg;
  var closeValue=closeLiveValue+closeMeatValue;
  var cogs=(availValue+openMeatValue)-closeValue;
  var grossProfit=revenue-cogs;

  var lab=dayCostsFor(dOf(e.datetime), e.branch, e.id, e.category);
  var advances=lab.advances;   /* shown, never deducted: it settles wages already counted */
  var overheads=lab.overheads; /* this day's share of rent, power, salary */
  var netProfit=grossProfit-lab.wages-lab.other-overheads-feedAmt;

  /* ---- loss drivers ---- */
  var mortValue=num(e.mortWtG)/1000*avgRate;
  var damageValue=num(e.damageG)/1000*meatCostKg;
  var shortValue=shortG/1000*meatCostKg;
  var bonusValue=bonusG/1000*meatCostKg;
  var meatDeficitValue=meatDeficitG/1000*meatCostKg;
  var wtDeficitValue=wtDeficitG/1000*avgRate;

  var photos=e.photos||[];
  var needsPhoto=num(e.mortCount)>0 && photos.length===0;
  var hasData=handled>0||dressedWtG>0||revenue>0;

  return { wastePct:wastePct, expYield:expYield, yieldFrac:yieldFrac,
    buyBirds:buyBirds, buyWtG:buyWtG, buyAmt:buyAmt,
    returnBirds:returnBirds, returnWtG:returnWtG, returnAmt:returnAmt,
    openValue:openValue, availWtG:availWtG,
    availValue:availValue, avgRate:avgRate, meatCostKg:meatCostKg,
    expectedMeatG:expectedMeatG, wasteMeatG:wasteMeatG, actualMeatG:actualMeatG,
    varianceG:varianceG, bonusG:bonusG, shortG:shortG,
    yieldPct:yieldPct, yieldLow:yieldLow, yieldHigh:yieldHigh,
    skinAmt:skinAmt, skinlessAmt:skinlessAmt, liverAmt:liverAmt, liveAmt:liveAmt, cutAmt:cutAmt,
    counterSaleAmt:counterSaleAmt, meatSaleAmt:meatSaleAmt, revenue:revenue,
    hotelAmt:hotelAmt, hotelConcession:hotelConcession, hotelCash:hotelCash, hotelCredit:hotelCredit,
    hotelSkinG:hotelG.skin, hotelSkinlessG:hotelG.skinless, hotelLiverG:hotelG.liver,
    hotelLiveG:hotelLiveG, hotelMeatG:hotelMeatG, hotelBirds:hotelBirds,
    hotelTotalG:hotelTotalG, hotelLines:hotelLines,
    cashSales:counterSaleAmt+liveAmt+cutAmt+hotelCash,
    handled:handled, expBirds:expBirds, birdVar:birdVar, birdDeficit:birdDeficit, mortRate:mortRate,
    meatAvailG:meatAvailG, expCloseWtG:expCloseWtG, wtDeficitG:wtDeficitG, wtDeficitValue:wtDeficitValue,
    liveShortWtG:liveShortWtG, liveShortValue:liveShortValue,
    expCloseMeatG:expCloseMeatG, meatVarG:meatVarG,
    meatDeficitG:meatDeficitG, meatDeficitValue:meatDeficitValue,
    openMeatValue:openMeatValue, closeLiveValue:closeLiveValue, closeMeatValue:closeMeatValue,
    closeValue:closeValue, cogs:cogs, grossProfit:grossProfit,
    feedBags:feedBags, feedRate:feedRate, feedAmt:feedAmt,
    labour:lab.wages, advances:advances, otherExp:lab.other, overheads:overheads,
    manDays:lab.manDays, netProfit:netProfit,
    mortValue:mortValue, damageValue:damageValue, shortValue:shortValue, bonusValue:bonusValue,
    needsPhoto:needsPhoto, hasData:hasData };
}

function warnings(e,c){
  var w=[];
  if(c.needsPhoto) w.push({lvl:'red',t:'Mortality photo missing',m:num(e.mortCount)+' bird(s) recorded. At least one photo is required before submitting.'});
  if(c.yieldLow) w.push({lvl:'red',t:'Meat shortfall',m:'Yield '+pct(c.yieldPct)+' against an expected '+pct(c.expYield,0)+'. Short by '+fmtW(c.shortG)+' ≈ '+money0(c.shortValue)+'.'});
  if(c.liveShortWtG>0) w.push({lvl:'red',t:'Live bird weight shortage',m:'Closing birds worked out to 0, but '+fmtW(c.liveShortWtG)+' ≈ '+money0(c.liveShortValue)+' of live bird weight is unaccounted for. Recheck purchases, sales, mortality and dressed counts — this weight will NOT be carried forward to tomorrow.'});
  if(c.yieldHigh) w.push({lvl:'amber',t:'Excess meat — bonus',m:'Yield '+pct(c.yieldPct)+' exceeds the expected '+pct(c.expYield,0)+'. Bonus '+fmtW(c.bonusG)+' ≈ '+money0(c.bonusValue)+'.'});
  if(c.birdVar!==0&&c.hasData) w.push({lvl:'amber',t:'Bird count mismatch',m:'Closing count is '+Math.abs(c.birdVar)+' bird(s) '+(c.birdVar>0?'short of':'above')+' the expected balance.'});
  if(c.mortRate>2) w.push({lvl:'amber',t:'High mortality',m:pct(c.mortRate,2)+' of birds handled ≈ '+money0(c.mortValue)+' lost.'});
  if(c.hasData&&c.netProfit<0) w.push({lvl:'red',t:'Day closed at a loss',m:'Net '+money0(c.netProfit)+' after cost, labour and expenses.'});
  return w;
}

function alertHtml(list,ok){
  if(!list.length) return ok===false?'':'<div class="rounded-lg bg-emerald-50 border-l-4 border-emerald-600 px-3 py-2 text-xs text-emerald-800 font-semibold"><i class="fa-solid fa-circle-check mr-1"></i>All checks passed</div>';
  return list.map(function(w){
    var cl=w.lvl==='red'?'bg-rose-50 border-rose-600 text-rose-800':'bg-amber-50 border-amber-500 text-amber-800';
    var ic=w.lvl==='red'?'fa-triangle-exclamation':'fa-circle-exclamation';
    return '<div role="alert" class="rounded-lg border-l-4 px-3 py-2 text-xs '+cl+'"><p class="font-bold flex items-center gap-1.5"><i class="fa-solid '+ic+'"></i>'+esc(w.t)+'</p><p class="mt-0.5 leading-snug">'+esc(w.m)+'</p></div>';
  }).join('');
}

/* ---------------- activity log (admin visible only) ---------------- */
function logAct(action,detail){
  var arr=S.activity||[];
  arr.push({ id:uid('a'), at:new Date().toISOString(),
    userId:S.user?S.user.id:null, userName:S.user?S.user.name:'(anonymous)',
    role:S.user?S.user.role:'—', branch:S.branch||'—', action:action, detail:detail||'' });
  if(arr.length>3000) arr=arr.slice(arr.length-3000);
  S.activity=arr; DB.write(K.activity,arr);
}

function renderActivity(){
  if(!isAdmin()) return;
  var uSel=$('actUser'), kSel=$('actKind');
  var users={}, kinds={};
  S.activity.forEach(function(a){ users[a.userName]=1; kinds[a.action]=1; });
  var keepU=uSel.value, keepK=kSel.value;
  uSel.innerHTML='<option value="">All users</option>'+Object.keys(users).sort().map(function(x){return '<option>'+esc(x)+'</option>';}).join('');
  kSel.innerHTML='<option value="">All actions</option>'+Object.keys(kinds).sort().map(function(x){return '<option>'+esc(x)+'</option>';}).join('');
  uSel.value=keepU; kSel.value=keepK;
  var list=S.activity.filter(function(a){
    if(keepU&&a.userName!==keepU) return false;
    if(keepK&&a.action!==keepK) return false;
    return true;
  }).slice().reverse();
  $('actCount').textContent=list.length;
  var col={ 'Sign in':'bg-emerald-100 text-emerald-800','Sign out':'bg-slate-200 text-slate-700',
    'Auto logout':'bg-amber-100 text-amber-800','Approved entry':'bg-emerald-100 text-emerald-800',
    'Returned entry':'bg-rose-100 text-rose-800','Deleted entry':'bg-rose-100 text-rose-800',
    'Failed sign in':'bg-rose-100 text-rose-800' };
  $('actBody').innerHTML=list.length?list.slice(0,500).map(function(a){
    var when=String(a.at).slice(0,10)+' '+String(a.at).slice(11,19);
    return '<tr class="rowhover"><td class="px-4 py-2 whitespace-nowrap text-xs num">'+when+'</td>'+
      '<td class="px-4 py-2 font-semibold">'+esc(a.userName)+'</td>'+
      '<td class="px-4 py-2"><span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full '+(a.role==='admin'?'bg-amber-100 text-amber-800':'bg-emerald-100 text-emerald-800')+'">'+esc(a.role)+'</span></td>'+
      '<td class="px-4 py-2 text-xs text-slate-500">'+esc(a.branch)+'</td>'+
      '<td class="px-4 py-2"><span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded '+(col[a.action]||'bg-slate-100 text-slate-700')+'">'+esc(a.action)+'</span></td>'+
      '<td class="px-4 py-2 text-xs text-slate-500">'+esc(a.detail)+'</td></tr>';
  }).join(''):'<tr><td colspan="6" class="px-4 py-10 text-center text-slate-400">No activity recorded.</td></tr>';
}

/* ---------------- session management ---------------- */
function idleMs(){ return (S.user && IDLE_MS[S.user.role]) || IDLE_MS.supervisor; }
function bumpActivity(){ if(S.user) S.lastAct=Date.now(); }

function tickSession(){
  if(!S.user) return;
  if(isAdmin()){
    /* No idle auto-logout for admin at all — no countdown pill, no warning
       modal, nothing to tick. Server-side idle_limit_minutes() agrees. */
    $('sessionPill').classList.add('hidden');
    var idm=$('idleModal'); if(idm && !idm.classList.contains('hidden')) idm.classList.add('hidden');
    return;
  }
  var left=idleMs()-(Date.now()-S.lastAct);
  if(left<=0){ autoLogout(); return; }
  var s=Math.ceil(left/1000);
  $('sessionLeft').textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
  $('sessionPill').className='hidden lg:flex items-center gap-2 text-xs font-semibold rounded-full px-3 py-2 border '+
    (left<=IDLE_WARN?'bg-rose-600/80 text-white border-rose-400 pulse-dot':'bg-slate-900/40 text-emerald-100 border-emerald-700');
  var m=$('idleModal');
  if(left<=IDLE_WARN){ m.classList.remove('hidden'); $('idleCount').textContent=s; }
  else if(!m.classList.contains('hidden')) m.classList.add('hidden');
}

function autoLogout(){
  logAct('Auto logout','Idle for '+(idleMs()/60000)+' minutes');
  LS.del(K.session);
  DB.write(K.logoutReason,'You were signed out automatically after '+(idleMs()/60000)+' minutes of inactivity.');
  location.reload();
}

/* ---------------- auto-filled closing values ---------------- */
/* Only an admin may ever flip a field to manual (the toggle buttons are
   data-admin, hidden from supervisors, and blankForm()/loadEntry() always
   reset S.auto to all-true) — so a supervisor's fields stay readonly and
   server-computed no matter what. */
function setCloseReadonly(ids,on){
  ids.forEach(function(id){ var el=$(id); if(!el) return; el.readOnly=on; el.tabIndex=on?-1:0; });
}
function applyAutoFill(c){
  var hb=$('hint_closeBirds'), hw=$('hint_closeWt');
  var expB=Math.max(Math.round(c.expBirds),0), expW=Math.max(Math.round(c.expCloseWtG),0);

  if(S.auto.closeBirds && !$('f_closeBirds').disabled){ if($('f_closeBirds').value!==String(expB)) $('f_closeBirds').value=expB; }
  if(S.auto.closeWt && !$('f_closeWt_kg').disabled) setG('f_closeWt',expW);

  hb.textContent=S.auto.closeBirds?'Auto: opening + purchased − live sold − mortality − dressed':'Manual — expected '+expB;
  hw.textContent=S.auto.closeWt?'Auto from weights entered above':'Manual — expected '+fmtW(expW);
  [['closeBirds',hb],['closeWt',hw]].forEach(function(x){
    x[1].className='text-[11px] mt-1 '+(S.auto[x[0]]?'text-emerald-600':'text-amber-600');
  });
  // Closing birds worked out to 0 but the weight arithmetic still left
  // something over — that weight is not a real closing balance any more
  // (see calc()'s liveShortWtG), so it is highlighted here rather than
  // shown as an ordinary auto-filled figure, and it is NOT carried to
  // tomorrow (closeWt itself is already zeroed above via expCloseWtG).
  if(c.liveShortWtG>0){
    hw.innerHTML='<span class="font-bold text-rose-600"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Shortage '+fmtW(c.liveShortWtG)+' ≈ '+money0(c.liveShortValue)+' — 0 birds closing, not carried to tomorrow</span>';
    hw.className='text-[11px] mt-1';
  }
  qsa('[data-auto]').forEach(function(b){
    /* This overwrites the whole className every recalc(), which runs on
       every keystroke — so the admin-only 'hidden' class applyRbac() set
       has to be re-applied here too, or a supervisor's button reappears
       the moment they type anything. */
    var on=S.auto[b.getAttribute('data-auto')];
    b.className='autoBtn ml-auto'+(on?'':' off')+(isAdmin()?'':' hidden');
    b.textContent=on?'auto':'manual';
  });
  setCloseReadonly(['f_closeBirds'],S.auto.closeBirds);
  setCloseReadonly(['f_closeWt_kg','f_closeWt_g'],S.auto.closeWt);
  // Closing meat has no auto/manual toggle any more — it's always a direct
  // physical count, entered in Section G. Mirror it (read-only) into
  // Section I alongside birds/weight, and mirror the reconciled actual
  // meat obtained (Section G's skin+skinless+liver+closing, plus hotel and
  // damage) back up into Section F's read-only display.
  setG('f_closeMeatMirror', Math.round(c.expCloseMeatG));
  setG('f_actualMeat', Math.max(Math.round(c.actualMeatG),0));
}

/* ---------------- auth & RBAC ---------------- */
function isAdmin(){ return S.user && S.user.role==='admin'; }
function myBranches(){ return isAdmin()?Object.keys(S.branches):(S.user.branches||[]).filter(function(b){return S.branches[b];}); }
function existingEntry(branch,cat,date,exceptId){
  return S.entries.filter(function(x){
    return x.branch===branch && x.category===cat && dOf(x.datetime)===date && x.id!==exceptId;
  })[0]||null;
}
function canEdit(e){
  if(!e) return true;
  if(isAdmin()) return true;
  // A supervisor only ever has today — matches can_edit() server-side.
  return (e.status==='draft'||e.status==='rejected') && e.createdBy===S.user.id
    && e.businessDate===todayISO();
}
function userName(id){ var u=S.users.filter(function(x){return x.id===id;})[0]; return u?u.name:'—'; }

function applyRbac(){
  qsa('[data-admin]').forEach(function(el){ el.classList.toggle('hidden',!isAdmin()); });
  qsa('[data-sup]').forEach(function(el){ el.classList.toggle('hidden',isAdmin()); });
  $('idleLimitTxt').textContent=(idleMs()/60000);
  /* No countdown pill for admin — there's nothing counting down (see
     tickSession(), which also hides it on every tick as a backstop). */
  $('sessionPill').classList.toggle('hidden', isAdmin());
  $('navRecordsLabel').textContent=isAdmin()?'Approvals':'My Entries';
  $('userName').textContent=S.user.name;
  $('userRole').textContent=S.user.role;
  $('userInitials').textContent=S.user.name.split(/\s+/).map(function(x){return x[0];}).join('').slice(0,2).toUpperCase();
  /* A supervisor only ever works today's attendance/wages — no browsing or
     editing a past day's worker records (see markAttendance/adjustWage,
     which both key off this field, and the ledgerModal/advanceModal date
     boxes below, which default from it). */
  var wkd=$('wkDate');
  if(wkd){ wkd.disabled=!isAdmin(); wkd.title=isAdmin()?'':'Supervisors can only work today’s attendance and wages.'; }
}

function refreshBranchSelects(){
  var codes=myBranches();
  if(S.branches[S.branch]===undefined||codes.indexOf(S.branch)<0) S.branch=codes[0]||null;
  var opts=codes.map(function(k){ return '<option value="'+esc(k)+'">'+esc(S.branches[k])+'</option>'; }).join('');
  $('branchSelect').innerHTML=opts; if(S.branch) $('branchSelect').value=S.branch;
  /* Remembered so a reload lands back on the same branch — see startApp().
     Rebuilding this <select>'s options and re-setting .value here is also
     what keeps it from ever silently drifting out of sync with S.branch (and
     therefore with f_branchLabel below, and with whatever entry is loaded on
     screen) the way it could when a caller updated S.branch and the select's
     DOM value through two different, not-always-both-taken code paths. */
  if(S.branch) LS.set(K.lastBranch,S.branch);
  var rb=$('recBranch'), keep=rb.value;
  rb.innerHTML='<option value="">All my branches</option>'+opts;
  rb.value=codes.indexOf(keep)>=0?keep:'';
  $('f_branchLabel').textContent=S.branch?S.branches[S.branch]:'—';
  $('wkBranchLabel').textContent=S.branch?S.branches[S.branch]:'—';
}

/* ---------------- purchases ---------------- */
/* Buy-kind purchase lines still open to return against, for the current
   branch — fetched lazily the first time a row is switched to "Return"
   and cached until explicitly refreshed. Admin only, like returns
   themselves (see _replace_purchases() in api.py). */
function loadOpenPurchases(branch){
  if(!branch || !isAdmin()) return Promise.resolve([]);
  if(S.openPurchases[branch]) return Promise.resolve(S.openPurchases[branch]);
  return api('GET','/purchases/open?branch='+encodeURIComponent(branch)).then(function(d){
    S.openPurchases[branch]=d.rows||[];
    return S.openPurchases[branch];
  }).catch(function(){ return []; });
}

function renderPurchases(){
  var locked=S.editing?!canEdit(S.editing):false;
  var box=$('purchaseRows');
  if(!S.purchases.length){
    box.innerHTML='<p class="text-xs text-slate-400 italic">No purchases recorded for this day. Click “Add purchase” when birds are bought in.'+(isAdmin()?'':' Enter birds and weight only — the admin fills the rate when approving.')+'</p>';
    return;
  }
  var open=S.openPurchases[S.branch]||[];
  box.innerHTML=S.purchases.map(function(p,i){
    var isReturn=p.kind==='return';
    var against=isReturn ? open.filter(function(o){ return o.id===p.returnOf; })[0] : null;
    return '<div class="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end '+(isReturn?'bg-rose-50 border-rose-200':'bg-slate-50 border-slate-200')+' border rounded-lg p-3 pop">'+
      (isAdmin() ? '<div class="sm:col-span-12 flex items-center gap-2">'+
        '<span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full '+(isReturn?'bg-rose-600 text-white':'bg-emerald-100 text-emerald-800')+'">'+(isReturn?'Return to supplier':'Purchase')+'</span>'+
        (locked?'':'<button type="button" data-pret="'+i+'" class="text-[11px] font-bold text-slate-500 hover:text-emerald-700 underline">'+(isReturn?'Switch to purchase':'Mark as a return')+'</button>')+
      '</div>' : '')+
      (isReturn ?
        ('<div class="sm:col-span-5"><label class="lbl">Return against</label><select data-p="returnOf" data-i="'+i+'" class="inp" '+(locked?'disabled':'')+'>'+
          '<option value="">Choose the original purchase…</option>'+
          open.map(function(o){ return '<option value="'+o.id+'" '+(o.id===p.returnOf?'selected':'')+'>'+o.date+' · '+esc(o.supplier||'—')+' · '+o.remainingBirds+' birds / '+fmtW(o.remainingWtG)+' left @ '+money(o.rate)+'/kg</option>'; }).join('')+
        '</select>'+(open.length?'':'<p class="text-[11px] text-slate-400 mt-1">No open purchases in the last 60 days for this branch.</p>')+'</div>'+
        '<div class="sm:col-span-2"><label class="lbl">Birds returned</label><input type="number" min="0" step="1" data-p="birds" data-i="'+i+'" class="inp num" value="'+(p.birds||'')+'" '+(locked?'disabled':'')+' /></div>'+
        '<div class="sm:col-span-3"><label class="lbl">Weight returned</label><div class="kgg"><input type="number" min="0" step="1" data-p="kg" data-i="'+i+'" class="inp num" value="'+(p.wtG?Math.floor(p.wtG/1000):'')+'" '+(locked?'disabled':'')+' /><span>kg</span><input type="number" min="0" max="999" step="1" data-p="g" data-i="'+i+'" class="inp num" value="'+(p.wtG?p.wtG%1000:'')+'" '+(locked?'disabled':'')+' /><span>g</span></div></div>'+
        '<div class="sm:col-span-1"><label class="lbl">Rate ₹/kg</label><p class="inp !bg-slate-100 text-slate-500 text-xs">'+(against?money(against.rate):(p.rate?money(p.rate):'—'))+'</p></div>')
      :
        ('<div class="sm:col-span-4"><label class="lbl">Supplier</label><input data-p="supplier" data-i="'+i+'" class="inp" value="'+esc(p.supplier||'')+'" placeholder="Supplier name" '+(locked?'disabled':'')+' /></div>'+
        '<div class="sm:col-span-2"><label class="lbl">Birds</label><input type="number" min="0" step="1" data-p="birds" data-i="'+i+'" class="inp num" value="'+(p.birds||'')+'" '+(locked?'disabled':'')+' /></div>'+
        '<div class="sm:col-span-3"><label class="lbl">Weight</label><div class="kgg"><input type="number" min="0" step="1" data-p="kg" data-i="'+i+'" class="inp num" value="'+(p.wtG?Math.floor(p.wtG/1000):'')+'" '+(locked?'disabled':'')+' /><span>kg</span><input type="number" min="0" max="999" step="1" data-p="g" data-i="'+i+'" class="inp num" value="'+(p.wtG?p.wtG%1000:'')+'" '+(locked?'disabled':'')+' /><span>g</span></div></div>'+
        (isAdmin()
          ? '<div class="sm:col-span-2"><label class="lbl">Rate ₹/kg</label><input type="number" min="0" step="0.01" data-p="rate" data-i="'+i+'" class="inp num" value="'+(p.rate||'')+'" '+(locked?'disabled':'')+' /></div>'
          : '<div class="sm:col-span-2"><label class="lbl">Rate</label><p class="inp !bg-slate-100 text-slate-400 text-xs italic">admin only</p></div>')))+
      '<div class="sm:col-span-1 flex justify-end">'+(locked?'':'<button type="button" data-prm="'+i+'" class="h-9 w-9 rounded-lg text-rose-600 hover:bg-rose-100"><i class="fa-solid fa-trash"></i></button>')+'</div>'+
      (isAdmin() && !isReturn?'<div class="sm:col-span-12 text-right text-xs font-bold text-emerald-800">Line value: '+money(num(p.wtG)/1000*num(p.rate))+'</div>':'')+
      (isAdmin() && isReturn && against?'<div class="sm:col-span-12 text-right text-xs font-bold text-rose-700">Deducted from ledger: −'+money(num(p.wtG)/1000*against.rate)+'</div>':'')+
    '</div>';
  }).join('');
}

/* ---------------- hotel & hostel sale lines ---------------- */
function branchCustomers(){
  return S.customers.filter(function(c){ return c.branch===S.branch && c.active!==false; });
}
function customerById(id){ return S.customers.filter(function(c){ return c.id===id; })[0]||null; }

/* Pull the deal terms off the customer record onto the line, so the row can be
   priced without another lookup and the server sees what the user was shown. */
function applyDeal(line){
  var c=customerById(line.customerId);
  var def=productDef(line.product);
  line.mode  = c?c.mode:'less';
  line.less  = c?num(c[def.less]):0;
  line.fixed = c?num(c[def.fixed]):0;
  line.customerName = c?c.name:'';
  line.kind = c?c.kind:'hotel';
  return line;
}

/* The strip under each row: what the deal works out to, and what it earned.
   Kept separate from the row markup so it can be refreshed on every keystroke
   without rebuilding the inputs and stealing focus. */
function hotelRowSummary(l,e){
  var p=priceHotelLine(l,e);
  var c=customerById(l.customerId);
  var lessVal=num(l.less);
  var dealTxt = !c ? 'choose a customer'
    : c.mode==='fixed' ? 'fixed '+money(p.rate)+'/kg'
    : 'market '+money(p.market)+(lessVal>=0?' less '+money(lessVal):' plus '+money(-lessVal))+' = '+money(p.rate)+'/kg';
  return '<span class="text-slate-500">'+esc(dealTxt)+'</span>'+
    (p.product==='live'
      ? '<span class="text-amber-800 font-semibold">'+num(p.birds)+' bird(s) off the shed</span>'
      : '')+
    (p.concession>0?'<span class="text-amber-700 font-semibold">concession '+money(p.concession)+'</span>'
      :p.concession<0?'<span class="text-emerald-700 font-semibold">premium '+money(-p.concession)+'</span>':'')+
    '<span class="ml-auto font-bold text-indigo-900">'+money(p.amount)+'</span>'+
    '<span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full '+
      (l.settled?'bg-emerald-100 text-emerald-800':'bg-rose-100 text-rose-700')+'">'+
      (l.settled?'paid':'on account')+'</span>';
}

function refreshHotelTotals(e){
  qsa('#hotelRows [data-hsum]').forEach(function(el){
    var l=S.hotelSales[+el.getAttribute('data-hsum')];
    if(l) el.innerHTML=hotelRowSummary(l,e);
  });
}

function renderHotelRows(){
  var box=$('hotelRows'); if(!box) return;
  var locked=S.editing?!canEdit(S.editing):false;
  var list=branchCustomers();

  if(!list.length){
    box.innerHTML='<p class="text-xs text-slate-400 italic">No hotels, hostels or functions registered for this branch yet. '+
      'Add them under <b>Hotels, Hostels &amp; Functions</b> first, along with the price agreed for skin, skinless, liver and live birds.</p>';
    return;
  }
  if(!S.hotelSales.length){
    box.innerHTML='<p class="text-xs text-slate-400 italic">Nothing sold to a hotel, hostel or function today. Click &ldquo;Add sale&rdquo; when one of them takes stock.</p>';
    return;
  }

  var e=readForm();
  box.innerHTML=S.hotelSales.map(function(l,i){
    var p=priceHotelLine(l,e);
    var override=(l.rateOverride!==null&&l.rateOverride!==undefined&&l.rateOverride!=='');
    var isLive=(l.product==='live');
    var dis=locked?'disabled':'';
    /* live rows carry an extra "birds" box, so the widths shift to keep the
       12-column grid adding up on one line */
    var wCust=3, wItem=2, wBirds=isLive?2:0, wWt=isLive?2:3, wRate=2, wPaid=1;
    return '<div class="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end border rounded-lg p-3 pop '+
        (isLive?'bg-amber-50/70 border-amber-200':'bg-indigo-50/60 border-indigo-200')+'">'+
      '<div class="sm:col-span-'+wCust+'"><label class="lbl">Customer</label><select data-h="customerId" data-i="'+i+'" class="inp" '+dis+'>'+
        '<option value="">— choose —</option>'+
        list.map(function(x){ return '<option value="'+esc(x.id)+'"'+(l.customerId===x.id?' selected':'')+'>'+esc(x.name)+' · '+esc(kindDef(x.kind).t.toLowerCase())+'</option>'; }).join('')+
      '</select></div>'+
      '<div class="sm:col-span-'+wItem+'"><label class="lbl">Item</label><select data-h="product" data-i="'+i+'" class="inp" '+dis+'>'+
        PRODUCTS.map(function(x){ return '<option value="'+x.v+'"'+(l.product===x.v?' selected':'')+'>'+x.t+'</option>'; }).join('')+
      '</select></div>'+
      (isLive?'<div class="sm:col-span-'+wBirds+'"><label class="lbl">Birds <span class="req">*</span></label>'+
        '<input type="number" min="0" step="1" data-h="birds" data-i="'+i+'" class="inp num" value="'+(l.birds||'')+'" placeholder="0" '+dis+' /></div>':'')+
      '<div class="sm:col-span-'+wWt+'"><label class="lbl">Weight</label><div class="kgg">'+
        '<input type="number" min="0" step="1" data-h="kg" data-i="'+i+'" class="inp num" value="'+(l.weightG?Math.floor(l.weightG/1000):'')+'" '+dis+' /><span>kg</span>'+
        '<input type="number" min="0" max="999" step="1" data-h="g" data-i="'+i+'" class="inp num" value="'+(l.weightG?l.weightG%1000:'')+'" '+dis+' /><span>g</span></div></div>'+
      '<div class="sm:col-span-'+wRate+'"><label class="lbl">Rate ₹/kg '+(override?'<span class="text-amber-600 font-bold">manual</span>':'')+'</label>'+
        '<input type="number" min="0" step="0.01" data-h="rateOverride" data-i="'+i+'" class="inp num" value="'+(override?l.rateOverride:'')+'" placeholder="'+p.rate.toFixed(2)+'" '+dis+' /></div>'+
      '<div class="sm:col-span-'+wPaid+' flex items-center justify-center pb-2"><label class="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-600 cursor-pointer" title="Tick when the money was taken on the day. Untick to put it on their account.">'+
        '<input type="checkbox" data-h="settled" data-i="'+i+'" class="h-4 w-4 rounded border-slate-300" '+(l.settled?'checked':'')+' '+dis+' /> Paid</label></div>'+
      '<div data-hsum="'+i+'" class="sm:col-span-12 flex flex-wrap items-center gap-2 text-xs border-t '+(isLive?'border-amber-200':'border-indigo-200')+' pt-2">'+
        hotelRowSummary(l,e)+
      '</div>'+
      (locked?'':'<div class="sm:col-span-12 flex justify-end -mt-8 pointer-events-none"><button type="button" data-hrm="'+i+'" class="pointer-events-auto h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-100"><i class="fa-solid fa-trash"></i></button></div>')+
    '</div>';
  }).join('');
}

/* ---------------- form <-> record ---------------- */
function readForm(){
  var e=S.editing?JSON.parse(JSON.stringify(S.editing)):{};
  e.branch=S.branch; e.category=S.cat;
  e.datetime=tv('f_datetime')||nowLocal();
  e.openBirds=v('f_openBirds'); e.openWtG=gv('f_openWt'); e.openRate=v('f_openRate'); e.openMeatG=gv('f_openMeat');
  e.purchases=S.purchases.slice();
  e.rateSkin=v('f_rateSkin'); e.rateSkinless=v('f_rateSkinless'); e.rateLiver=v('f_rateLiver'); e.rateLive=v('f_rateLive');
  e.liveSoldCount=v('f_liveSoldCount'); e.liveSoldWtG=gv('f_liveSoldWt'); e.cutCharges=v('f_cutCharges');
  e.mortCount=v('f_mortCount'); e.mortWtG=gv('f_mortWt'); e.damageG=gv('f_damage');
  // actualMeatG is not read here: it's reconciled server-side from
  // skin+skinless+liver+hotel meat+damage+closing meat (see calc.py), never
  // taken from the client — the readonly Section F box is just a preview.
  e.dressedCount=v('f_dressedCount'); e.dressedWtG=gv('f_dressedWt');
  e.skinSoldG=gv('f_skinSold'); e.skinlessSoldG=gv('f_skinlessSold'); e.liverSoldG=gv('f_liverSold');
  e.closeBirds=v('f_closeBirds'); e.closeWtG=gv('f_closeWt'); e.closeMeatG=gv('f_closeMeat');
  e.feedBags=v('f_feedBags'); e.feedRate=v('f_feedRate'); e.feedSupplier=tv('f_feedSupplier');
  /* tells the server which (if any) of these two the admin set by hand this
     save, rather than have it recompute them — see _manual_close_keys().
     Closing meat isn't part of this: it's always taken directly from
     f_closeMeat above, the same as skin/skinless/liver sold. */
  e.closeAuto={ birds:S.auto.closeBirds, wt:S.auto.closeWt };
  e.notes=tv('f_notes'); e.explanation=tv('f_explanation');
  e.photos=S.photos.slice();
  /* tells the server these images are real and not an empty list from a
     screen that never fetched them — see update_entry() */
  e.photosLoaded=!!S.photosLoaded;
  e.hotelSales=S.hotelSales.slice();
  return e;
}

function fillForm(e){
  setV('f_datetime',e.datetime||nowLocal());
  setV('f_openBirds',e.openBirds); setG('f_openWt',e.openWtG); setV('f_openRate',e.openRate); setG('f_openMeat',e.openMeatG);
  setV('f_rateSkin',e.rateSkin); setV('f_rateSkinless',e.rateSkinless); setV('f_rateLiver',e.rateLiver); setV('f_rateLive',e.rateLive);
  setV('f_liveSoldCount',e.liveSoldCount); setG('f_liveSoldWt',e.liveSoldWtG); setV('f_cutCharges',e.cutCharges);
  setV('f_mortCount',e.mortCount); setG('f_mortWt',e.mortWtG); setG('f_damage',e.damageG);
  setV('f_dressedCount',e.dressedCount); setG('f_dressedWt',e.dressedWtG); setG('f_actualMeat',e.actualMeatG);
  setG('f_skinSold',e.skinSoldG); setG('f_skinlessSold',e.skinlessSoldG); setG('f_liverSold',e.liverSoldG);
  setV('f_closeBirds',e.closeBirds); setG('f_closeWt',e.closeWtG); setG('f_closeMeat',e.closeMeatG);
  setV('f_feedBags',e.feedBags); setV('f_feedRate',e.feedRate);
  setV('f_feedSupplier',e.feedSupplier!==undefined?e.feedSupplier:'Shiva Traders');
  setV('f_notes',e.notes); setV('f_explanation',e.explanation);
  S.photos=(e.photos||[]).slice(); S.purchases=(e.purchases||[]).slice();
  S.photosLoaded = (e.photosLoaded!==false) || !num(e.photoCount);
  /* re-read the deal from the customer record: the agreed concession may have
     changed since this entry was first written */
  S.hotelSales=(e.hotelSales||[]).map(function(l){ return applyDeal(Object.assign({},l)); });
  renderPhotos(); renderPurchases(); renderHotelRows();
}

/* Previous approved day for this branch+category, used for carry-forward.
   A supervisor can no longer see past entries at all (today-only — see
   can_edit()/get_entry() server-side), so this can't be found by scanning
   S.entries any more; it comes from a dedicated endpoint that hands over
   just the closing stock and rates, not the whole record. Cached per
   branch+category in S.carryForward so isFirstEntry()/validation below can
   read it synchronously once the fetch settles. */
function previousDay(){ return S.carryForward; }

function blankForm(){
  fillForm({ datetime:nowLocal(), photos:[], purchases:[], hotelSales:[] });
  S.carryForward = null;
  $('carryNote').textContent = 'Checking for a previous day to carry forward…';
  var branch=S.branch, cat=S.cat;
  api('GET', '/entries/carry-forward?branch='+encodeURIComponent(branch)+'&category='+encodeURIComponent(cat))
    .then(function(cf){
      /* the branch/category may have changed again while this was in flight */
      if(S.branch!==branch || S.cat!==cat) return;
      if(cf.found){
        S.carryForward=cf;
        /* Only fill a field the user hasn't already started typing into. On
           a slow connection this fetch can resolve well after someone has
           begun the day's entry, and overwriting what they just typed —
           especially the skin/skinless rate — is exactly the "values change
           on their own" bug this guards against. */
        if(!filled('f_openBirds')) setV('f_openBirds',cf.closeBirds);
        if(!filledG('f_openWt')) setG('f_openWt',cf.closeWtG);
        if(!filledG('f_openMeat')) setG('f_openMeat',cf.closeMeatG);
        if(!filled('f_openRate')) setV('f_openRate',cf.avgRate?Number(cf.avgRate).toFixed(2):'');
        if(!filled('f_rateSkin')) setV('f_rateSkin',cf.rateSkin);
        if(!filled('f_rateSkinless')) setV('f_rateSkinless',cf.rateSkinless);
        if(!filled('f_rateLiver')) setV('f_rateLiver',cf.rateLiver);
        if(!filled('f_rateLive')) setV('f_rateLive',cf.rateLive);
        $('carryNote').textContent='Carried forward from '+cf.date+' — '+num(cf.closeBirds)+' birds'+(isAdmin()?' @ '+money(cf.avgRate)+'/kg':'');
      } else {
        S.carryForward=null;
        $('carryNote').textContent='First entry for this branch — opening figures are optional';
      }
      recalc();
    })
    .catch(function(){
      if(S.branch!==branch || S.cat!==cat) return;
      S.carryForward=null;
      $('carryNote').textContent='Could not check the previous day — opening figures may need a manual check.';
    });
}

/* ---------------- unsaved-changes autosave ----------------
   A refresh (accidental reload, browser crash, phone locking mid-typing)
   used to wipe out anything not already saved to the server — everything
   in the form since the last click of Save/Submit, gone. This mirrors
   readForm()'s snapshot into localStorage as the admin/supervisor types,
   keyed to whichever entry (or, for a brand new one, branch+category+date)
   is currently open, and offers it back the next time that same slot is
   loaded — including right after a reload, since loadEntry() calls
   tryRestoreDraft() itself. Photos are deliberately left out of the
   snapshot: they're already attached (not "unsaved typing" in the same
   sense) and re-saving a handful of base64 images on every keystroke risks
   the same "Storage full" wall LS.set() already has to guard against. */
function draftKey(){
  return 'vcc_draft_'+(S.editing?S.editing.id:('new_'+S.branch+'_'+S.cat+'_'+dOf(tv('f_datetime')||nowLocal())));
}
var draftTimer=null;
function saveDraftSoon(){
  if(!S.user||!$('view-entry')||$('view-entry').classList.contains('hidden')) return;
  clearTimeout(draftTimer);
  draftTimer=setTimeout(function(){
    var snap=readForm();
    delete snap.photos; delete snap.photosLoaded;
    DB.write(draftKey(),{ savedAt:Date.now(), data:snap });
  },800);
}
function clearDraft(key){ LS.del(key||draftKey()); }
var DRAFT_MAX_AGE_MS=7*24*60*60*1000;   // a week — older than that, assume abandoned
function tryRestoreDraft(){
  var raw=DB.read(draftKey(),null);
  if(!raw||!raw.data) return;
  if(Date.now()-(raw.savedAt||0)>DRAFT_MAX_AGE_MS){ clearDraft(); return; }
  var restored=Object.assign({},raw.data);
  // keep whatever photos actually loaded from the server — the draft never
  // carried them in the first place (see the note above)
  restored.photos=S.photos.slice(); restored.photosLoaded=S.photosLoaded;
  fillForm(restored);
  recalc();
  toast('Restored what you were typing before the page reloaded.','warn');
}

/* ---------------- mandatory field validation ---------------- */
/* True when this branch + category has no approved history yet, i.e. the very
   first day of data entry. Opening figures cannot be known on that day.        */
function isFirstEntry(){ return !S.editing && !previousDay(); }

var REQUIRED = [
  {id:'f_datetime',  label:'Date & time',             test:function(){ return filled('f_datetime'); }},
  {id:'f_openBirds', label:'Opening birds',           test:function(){ return filled('f_openBirds'); }, firstDayOptional:true},
  {id:'f_openWt_kg', label:'Opening bird weight',     test:function(){ return gv('f_openWt')>0; }, firstDayOptional:true},
  {id:'f_rateSkin',  label:'Skin rate',               test:function(){ return v('f_rateSkin')>0; }},
  {id:'f_rateSkinless',label:'Skinless rate',         test:function(){ return v('f_rateSkinless')>0; }},
  {id:'f_rateLive',  label:'Live bird price',         test:function(){ return v('f_rateLive')>0; }},
  {id:'f_dressedCount',label:'Number of dressed birds',test:function(){ return filled('f_dressedCount'); }},
  {id:'f_dressedWt_kg',label:'Live weight of dressed birds',test:function(){ return v('f_dressedCount')===0 || gv('f_dressedWt')>0; }},
  {id:'f_closeMeat_kg',label:'Closing meat (Section G)', test:function(){ return v('f_dressedCount')===0 || filledG('f_closeMeat'); }},
  {id:'f_closeBirds',label:'Closing birds',           test:function(){ return filled('f_closeBirds'); }},
  {id:'f_closeWt_kg',label:'Closing bird weight',     test:function(){ return v('f_closeBirds')===0 || gv('f_closeWt')>0; }, firstDayOptional:true},
  {id:'f_feedRate',  label:'Feed purchase — price per bag', test:function(){ return v('f_feedBags')===0 || v('f_feedRate')>0; }}
];

function validate(showMarks){
  var miss=[];
  qsa('#entryForm .inp').forEach(function(el){ el.classList.remove('missing'); });
  var first=isFirstEntry();
  REQUIRED.forEach(function(r){
    if(first && r.firstDayOptional) return;          /* day one: no history to draw on */
    if(!r.test()){ miss.push(r.label); if(showMarks && $(r.id)) $(r.id).classList.add('missing'); }
  });
  S.purchases.forEach(function(p,i){
    /* the purchase RATE is the admin's to enter at approval, never the supervisor's */
    if(isAdmin() && (num(p.birds)>0||num(p.wtG)>0) && num(p.rate)<=0) miss.push('Purchase line '+(i+1)+' — rate per kg');
    if(num(p.birds)>0 && num(p.wtG)<=0) miss.push('Purchase line '+(i+1)+' — weight');
  });
  var formNow=readForm();
  S.hotelSales.forEach(function(l,i){
    var g=num(l.weightG);
    if(g>0 && !l.customerId) miss.push('Hotel/hostel line '+(i+1)+' — choose the hotel or hostel');
    if(l.customerId && g<=0) miss.push('Hotel/hostel line '+(i+1)+' — enter the weight sold');
    if(g>0 && priceHotelLine(l,formNow).rate<=0)
      miss.push('Hotel/hostel line '+(i+1)+' — the price works out to ₹0. Set the '+
        productDef(l.product).t.toLowerCase()+' rate in Section C, or give this customer a fixed rate.');
    if(g>0 && l.product==='live' && num(l.birds)<=0)
      miss.push('Hotel/hostel line '+(i+1)+' — how many live birds were sold?');
  });
  if(v('f_mortCount')>0 && !S.photos.length) miss.push('Mortality photo (mortality is above zero)');
  if(S.editing && S.editing.status==='rejected' && !tv('f_explanation')) miss.push('Explanation for the returned entry');
  return miss;
}

function showValidation(miss){
  var box=$('validationBox');
  if(!miss.length){ box.classList.add('hidden'); return; }
  $('validationList').innerHTML=miss.map(function(m){ return '<li>'+esc(m)+'</li>'; }).join('');
  box.classList.remove('hidden');
  if(box.scrollIntoView) box.scrollIntoView({behavior:'smooth',block:'center'});
}

/* ---------------- entry lifecycle ---------------- */
function lockForm(locked){
  qsa('#entryForm input, #entryForm textarea, #entryForm select').forEach(function(el){
    if(el.id==='f_explanation') return; el.disabled=locked;
  });
  $('btnAddPurchase').disabled=locked;
  if($('btnAddHotelSale')) $('btnAddHotelSale').disabled=locked;
  renderPurchases(); renderHotelRows();
}

function loadEntry(id){
  S.editing=id?(S.entries.filter(function(x){return x.id===id;})[0]||null):null;
  // Closing birds/weight are computed by the server and shown read-only by
  // default, whether this is a new entry or one being reopened. An admin
  // (and only an admin — the toggle buttons are data-admin) can flip either
  // to manual from here; a supervisor never sees the toggle so theirs stays
  // on regardless. Closing meat has no such toggle — it's always a direct
  // physical count, entered in Section G.
  S.auto={ closeBirds:true, closeWt:true };
  S.warnedLiveShort=false;   // reset so the shortage popup can fire again for whatever's loaded now
  /* Remembered so a reload reopens the same record instead of always
     landing on a blank new entry — see startApp(). '' (not omitted) means
     "definitely a blank new entry", so restoring it doesn't fall through to
     some earlier id that no longer applies. */
  LS.set(K.lastEntry,id||'');
  if(S.editing){
    S.cat=S.editing.category; S.branch=S.editing.branch;
    // refreshBranchSelects() (not a bare .value assignment) so the header
    // dropdown, f_branchLabel and S.branch can never drift apart the way
    // they could here before — the exact mismatch reported live 2026-08-25
    // (header showing one branch, the entry's own Branch field showing the
    // one it actually belongs to).
    refreshBranchSelects(); syncSegs(); fillForm(S.editing); $('carryNote').textContent='';
  } else { blankForm(); }
  var e=S.editing, locked=e?!canEdit(e):false;
  lockForm(locked);
  if(!locked) tryRestoreDraft();

  var st=e?e.status:'new';
  var labels={ draft:'Draft — not submitted', pending:'Pending admin approval',
    approved: isAdmin() ? 'Approved — admin may amend' : 'Approved & locked',
    rejected:'Returned for correction', 'new':'New entry' };
  var cls={ draft:'bg-slate-100 text-slate-600', pending:'bg-amber-50 text-amber-700', approved:'bg-emerald-50 text-emerald-800', rejected:'bg-rose-50 text-rose-700', 'new':'bg-slate-100 text-slate-600' };
  $('f_statusLabel').textContent=labels[st];
  $('f_statusLabel').className='inp font-semibold '+cls[st];
  $('f_byLabel').textContent=e?(userName(e.createdBy)+(e.reviewedBy?' · reviewed by '+userName(e.reviewedBy):'')):S.user.name;
  $('rejectNotice').classList.toggle('hidden',!(e&&e.status==='rejected'));
  if(e&&e.status==='rejected') $('rejectReasonText').textContent=e.rejectReason||'—';
  /* A supervisor never picks the date — new or saved, they only ever work
     today, so the field is locked either way. An admin can move it, saved
     entries included. */
  var dateLocked = !isAdmin();
  $('f_datetime').disabled = locked || dateLocked;
  $('f_datetime').title = dateLocked
    ? 'Supervisors can only work today’s entry'
    : '';

  /* Opening birds/weight/meat are carried forward from the previous approved
     day by the server (see _carry_forward_opening() in api.py) — a supervisor
     can see the figure but never key over it, same reasoning as the date
     above. The value itself still shows, just not editable, so keep it
     readonly rather than disabled (disabled inputs are skipped by some
     browsers' form-read logic and grey out harder than needed here). */
  ['f_openBirds','f_openWt_kg','f_openWt_g','f_openMeat_kg','f_openMeat_g'].forEach(function(id){
    var el=$(id); if(!el) return;
    el.readOnly = !isAdmin();
    el.title = isAdmin() ? '' : 'Carried forward automatically — only an admin can change opening figures';
    el.classList.toggle('bg-slate-50', !isAdmin());
  });

  $('entryLockNotice').classList.toggle('hidden',!locked);
  if(locked) $('entryLockNotice').innerHTML='<i class="fa-solid fa-lock mr-1"></i>'+(st==='approved'?'Approved records can only be modified by an admin.':'Submitted — only an admin can modify it now.');
  if(!locked && e && isAdmin()){
    $('entryLockNotice').classList.remove('hidden');
    $('entryLockNotice').innerHTML='<i class="fa-solid fa-user-shield mr-1"></i>Admin: you may change the date, time and figures on this record.';
  }
  $('validationBox').classList.add('hidden');
  renderActions(); recalc();
}

function renderActions(){
  var e=S.editing, st=e?e.status:'new', h='';
  var B=function(id,cls,icon,label){ return '<button type="button" id="'+id+'" class="inline-flex items-center gap-2 '+cls+' font-bold text-sm px-5 py-3 rounded-lg shadow-sm transition"><i class="fa-solid '+icon+'"></i> '+label+'</button>'; };
  if(st==='new'||st==='draft'){
    h+=B('actDraft','bg-white text-slate-600 border border-slate-300 hover:bg-slate-50','fa-floppy-disk','Save draft');
    h+=B('actSubmit','bg-emerald-700 hover:bg-emerald-800 text-white','fa-paper-plane','Send to admin for approval');
  } else if(st==='rejected'){
    h+=B('actSubmit','bg-emerald-700 hover:bg-emerald-800 text-white','fa-rotate-right','Resubmit with explanation');
  } else if(st==='pending'&&isAdmin()){
    h+=B('actSave','bg-white text-slate-600 border border-slate-300 hover:bg-slate-50','fa-floppy-disk','Save changes');
    h+=B('actApprove','bg-emerald-700 hover:bg-emerald-800 text-white','fa-circle-check','Approve');
    h+=B('actReject','bg-rose-600 hover:bg-rose-700 text-white','fa-circle-xmark','Return for correction');
  } else if(st==='approved'&&isAdmin()){
    h+=B('actSave','bg-emerald-700 hover:bg-emerald-800 text-white','fa-floppy-disk','Save changes (admin)');
  }
  if(e) h+=B('actNew','bg-white text-emerald-700 border border-emerald-300 hover:bg-emerald-50','fa-plus','New entry');
  $('formActions').innerHTML=h;
  bind('actDraft',function(){ saveEntry('draft'); });
  bind('actSubmit',function(){ saveEntry('pending'); });
  bind('actSave',function(){ saveEntry(S.editing.status); });
  bind('actApprove',function(){ decide(S.editing.id,'approved'); });
  bind('actReject',function(){ askReject(S.editing.id); });
  bind('actNew',function(){ loadEntry(null); });
}
function bind(id,fn){ var el=$(id); if(el) el.addEventListener('click',fn); }

function saveEntry(status){
  if(status==='pending'){
    var miss=validate(true);
    if(miss.length){ showValidation(miss); toast(miss.length+' required field(s) still missing.','error'); return; }
  }
  $('validationBox').classList.add('hidden');
  var e=readForm();

  /* Re-read from storage first — the record may have been approved elsewhere
     since this form was opened. With a real API this becomes a server re-check. */
  S.entries=DB.read(K.entries,S.entries);
  if(S.editing){
    var fresh=S.entries.filter(function(x){ return x.id===S.editing.id; })[0];
    if(!fresh){ toast('That entry no longer exists.','error'); loadEntry(null); return; }
    if(!canEdit(fresh)){
      toast('This entry was '+fresh.status+' — only an admin can modify it now.','error');
      logAct('Blocked edit attempt', fresh.category+' · '+dOf(fresh.datetime)+' · status '+fresh.status);
      loadEntry(fresh.id); return;
    }
  }

  /* One record per branch + category + day. */
  var dup=existingEntry(e.branch,e.category,dOf(e.datetime),S.editing?S.editing.id:null);
  if(dup){
    if(!isAdmin()){
      toast('A '+dup.status+' entry already exists for '+dOf(e.datetime)+'. Ask an admin to change it.','error');
      logAct('Blocked duplicate entry', e.category+' · '+dOf(e.datetime)+' · existing is '+dup.status);
      return;
    }
    if(!confirm('An entry already exists for '+dOf(e.datetime)+' ('+dup.status+').\n\nSave this as a second, separate record?')) return;
  }

  if(S.editing){
    var idx=S.entries.findIndex(function(x){ return x.id===S.editing.id; });
    e.id=S.editing.id; e.createdBy=S.editing.createdBy; e.createdAt=S.editing.createdAt;
    e.reviewedBy=S.editing.reviewedBy; e.reviewedAt=S.editing.reviewedAt; e.rejectReason=S.editing.rejectReason;
    e.status=status; e.updatedAt=new Date().toISOString(); e.updatedBy=S.user.id;
    if(status==='pending'){ e.reviewedBy=null; e.reviewedAt=null; }
    S.entries[idx]=e;
  } else {
    e.id=uid('e'); e.createdBy=S.user.id; e.createdAt=new Date().toISOString(); e.status=status; S.entries.push(e);
  }
  DB.write(K.entries,S.entries);
  logAct(status==='pending'?'Submitted entry':status==='draft'?'Saved draft':(status==='approved'?'Modified APPROVED record':'Edited entry'),
    (e.category)+' · '+dOf(e.datetime)+' · '+(S.branches[e.branch]||e.branch));
  toast(status==='draft'?'Draft saved.':status==='pending'?'Sent to admin for approval.':'Changes saved.');
  loadEntry(e.id); renderRecords(); renderDashboard(); updatePendingBadge();
}

function costingGaps(e){
  var gaps=[];
  (e.purchases||[]).forEach(function(p,i){
    if((num(p.birds)>0||num(p.wtG)>0) && num(p.rate)<=0) gaps.push('purchase line '+(i+1)+' rate');
  });
  if(num(e.openWtG)>0 && num(e.openRate)<=0) gaps.push('opening cost rate');
  return gaps;
}

function decide(id,verdict,reason){
  S.entries=DB.read(K.entries,S.entries);
  var e=S.entries.filter(function(x){return x.id===id;})[0]; if(!e) return;
  if(verdict==='approved'){
    var gaps=costingGaps(e);
    if(gaps.length){
      toast('Enter the '+gaps.join(' and ')+' before approving — the profit figures depend on it.','error');
      return;
    }
  }
  e.status=verdict==='approved'?'approved':'rejected';
  e.reviewedBy=S.user.id; e.reviewedAt=new Date().toISOString();
  e.rejectReason=verdict==='approved'?'':(reason||'');
  DB.write(K.entries,S.entries);
  logAct(verdict==='approved'?'Approved entry':'Returned entry',
    e.category+' · '+dOf(e.datetime)+' · '+(S.branches[e.branch]||e.branch)+(reason?' — '+reason:''));
  toast(verdict==='approved'?'Approved and saved as a record.':'Returned to supervisor.',verdict==='approved'?'success':'warn');
  closeModal('reviewModal');
  if(S.editing&&S.editing.id===id) loadEntry(id);
  renderRecords(); renderDashboard(); updatePendingBadge();
}

function askReject(id){
  openGen('Return entry for correction',
    '<p class="text-sm text-slate-600 mb-3">The supervisor must supply a written explanation before resubmitting.</p>'+
    '<label class="lbl" for="rejReason">Reason / what to check</label>'+
    '<textarea id="rejReason" rows="3" class="inp" placeholder="e.g. Mortality photo unclear; explain the 8 kg meat shortfall."></textarea>'+
    '<div class="flex gap-3 mt-4"><button id="rejGo" class="bg-rose-600 hover:bg-rose-700 text-white font-bold text-sm px-5 py-2.5 rounded-lg">Return entry</button>'+
    '<button data-close="1" class="border border-slate-300 text-slate-600 font-bold text-sm px-5 py-2.5 rounded-lg">Cancel</button></div>');
  bind('rejGo',function(){
    var r=tv('rejReason'); if(!r){ toast('Give a reason.','error'); return; }
    closeModal('genModal'); decide(id,'rejected',r);
  });
}

/* ---------------- photos ---------------- */
function compress(file,cb){
  var fr=new FileReader();
  fr.onload=function(){
    var img=new Image();
    img.onload=function(){
      var max=900,w=img.width,h=img.height;
      if(w>max||h>max){ if(w>h){ h=Math.round(h*max/w); w=max; } else { w=Math.round(w*max/h); h=max; } }
      var cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      try{ cb(cv.toDataURL('image/jpeg',0.6)); }catch(err){ cb(fr.result); }
    };
    img.onerror=function(){ cb(fr.result); };
    img.src=fr.result;
  };
  fr.readAsDataURL(file);
}
function renderPhotos(){
  var strip=$('photoStrip'); if(!strip) return;
  var locked=S.editing?!canEdit(S.editing):false;
  strip.innerHTML=S.photos.map(function(src,i){
    return '<div class="relative group pop"><img src="'+src+'" alt="Mortality photo '+(i+1)+'" data-view="'+i+'" class="h-24 w-24 object-cover rounded-lg border-2 border-slate-200 cursor-zoom-in" />'+
      (locked?'':'<button type="button" data-rm="'+i+'" class="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-rose-600 text-white text-xs shadow grid place-items-center opacity-0 group-hover:opacity-100 transition"><i class="fa-solid fa-xmark"></i></button>')+'</div>';
  }).join('')||'<p class="text-xs text-slate-400 italic">No photos attached.</p>';
}

/* ---------------- live recalc ---------------- */
function recalc(){
  var e=readForm(), c=calc(e);
  /* write the auto-filled closing fields first, then re-read so every
     variance figure below reflects what is actually on screen */
  applyAutoFill(c);
  e=readForm(); c=calc(e);
  // recalc() runs after every field edit and after every add/remove of a
  // purchase, hotel-sale or photo row — the one place that already sees
  // every way the form can change — so it's also the one place autosave
  // needs to hook in, rather than duplicating a save call at each of those
  // call sites individually.
  saveDraftSoon();
  $('o_buyBirds').textContent=c.buyBirds.toLocaleString('en-IN');
  $('o_buyWt').textContent=fmtW(c.buyWtG);
  $('o_buyAmt').textContent=money(c.buyAmt);
  $('o_avgRate').textContent=money(c.avgRate)+' / kg';

  $('o_wastePct').textContent=c.wastePct;
  $('o_expMeat').textContent=fmtW(c.expectedMeatG);
  $('o_wasteMeat').textContent=fmtW(c.wasteMeatG);
  $('o_yieldPct').textContent=pct(c.yieldPct);
  $('o_yieldPct').className='ml-auto font-bold num '+(c.yieldLow?'text-rose-600':c.yieldHigh?'text-amber-600':'text-slate-800');
  $('o_bonusMeat').textContent=c.bonusG>0?fmtW(c.bonusG):(c.shortG>0?'−'+fmtW(c.shortG):fmtW(0));
  $('o_bonusMeat').className='ml-auto font-bold num '+(c.bonusG>0?'text-emerald-700':c.shortG>0?'text-rose-600':'text-slate-800');
  $('o_bonusBox').className='calcbox border '+(c.bonusG>0?'bg-emerald-50 border-emerald-200':c.shortG>0?'bg-rose-50 border-rose-200':'bg-slate-50 border-slate-200');

  $('o_liveAmt').textContent=money(c.liveAmt);
  $('o_skinAmt').textContent=c.skinAmt.toFixed(2);
  $('o_skinlessAmt').textContent=c.skinlessAmt.toFixed(2);
  $('o_liverAmt').textContent=c.liverAmt.toFixed(2);

  $('o_handled').textContent=c.handled.toLocaleString('en-IN');
  $('o_expBirds').textContent=c.expBirds.toLocaleString('en-IN');
  $('o_birdVar').textContent=(c.birdVar>0?'−':c.birdVar<0?'+':'')+Math.abs(c.birdVar);
  $('o_birdVar').className='font-bold num '+(c.birdVar===0?'text-emerald-700':'text-rose-600');
  $('o_meatAvail').textContent=fmtW(c.meatAvailG);
  $('o_expCloseMeat').textContent=fmtW(c.expCloseMeatG);

  refreshHotelTotals(e);
  if($('o_hotelWt')) $('o_hotelWt').textContent=fmtW(c.hotelTotalG);
  if($('o_hotelAmt')) $('o_hotelAmt').textContent=money(c.hotelAmt);
  if($('o_hotelConc')) $('o_hotelConc').textContent=money(c.hotelConcession);
  if($('o_hotelCredit')) $('o_hotelCredit').textContent=money(c.hotelCredit);
  if($('o_counterAmt')) $('o_counterAmt').textContent=money(c.counterSaleAmt);
  if($('o_hotelAmt2')) $('o_hotelAmt2').textContent=money(c.hotelAmt);
  if($('o_hotelConc2')) $('o_hotelConc2').textContent=money(c.hotelConcession);

  $('o_revenue').textContent=money(c.revenue);
  $('o_cogs').textContent=money(c.cogs);
  $('o_labour').textContent=money(c.labour);
  if($('o_advances')) $('o_advances').textContent=money(c.advances);
  if($('o_overheads')) $('o_overheads').textContent=money(c.overheads);
  $('o_otherExp').textContent=money(c.otherExp);
  $('o_feedAmt').textContent=money(c.feedAmt);
  if($('o_feedAmtSummary')) $('o_feedAmtSummary').textContent=money(c.feedAmt);
  $('o_netProfit').textContent=money(c.netProfit);
  $('o_netProfit').className='font-bold num text-xl '+(c.netProfit<0?'text-rose-600':'text-emerald-700');
  $('o_closeValue').textContent=money(c.closeValue);

  $('o_liveRetail').textContent=num(e.liveSoldCount).toLocaleString('en-IN')+' birds · '+fmtW(e.liveSoldWtG);
  $('o_dressedCt').textContent=num(e.dressedCount).toLocaleString('en-IN')+' birds';

  var dupWarn='';
  if(!S.editing){
    var dupe=existingEntry(S.branch,S.cat,dOf(e.datetime),null);
    if(dupe){
      var locked=dupe.status==='approved';
      dupWarn='<div role="alert" class="rounded-lg border-l-4 px-3 py-2 text-xs '+
        (locked?'bg-rose-50 border-rose-600 text-rose-800':'bg-amber-50 border-amber-500 text-amber-800')+'">'+
        '<p class="font-bold flex items-center gap-1.5"><i class="fa-solid fa-lock"></i>'+dOf(e.datetime)+' already recorded</p>'+
        '<p class="mt-0.5 leading-snug">This '+S.cat+' day is '+dupe.status+'. '+
        (isAdmin()?'Open it from Approvals to amend it.':'Approved days are locked — ask an admin to make any change.')+'</p></div>';
    }
  }
  $('liveAlerts').innerHTML=dupWarn+alertHtml(warnings(e,c));

  // One-time popup for whoever is entering TODAY's data — the inline
  // liveAlerts banner above already shows this every time the entry is
  // opened (including on later review), but a supervisor mid-entry is
  // easy to miss a banner from; a popup on the actual day it happens gets
  // their attention without nagging on every keystroke or on days that
  // are just being looked back at. S.warnedLiveShort is reset in
  // loadEntry() whenever a different entry/new entry is loaded.
  if(c.liveShortWtG>0 && dOf(e.datetime)===todayISO() && !S.warnedLiveShort){
    S.warnedLiveShort=true;
    openGen('Live bird weight shortage',
      '<div class="space-y-3 text-sm">'+
        '<div class="rounded-lg bg-rose-50 border-l-4 border-rose-600 px-3 py-2 text-rose-800">'+
          '<p class="font-bold flex items-center gap-1.5"><i class="fa-solid fa-triangle-exclamation"></i>Closing birds worked out to 0</p>'+
          '<p class="mt-0.5 leading-snug">…but '+fmtW(c.liveShortWtG)+' ≈ '+money0(c.liveShortValue)+' of live bird weight is still unaccounted for.</p>'+
        '</div>'+
        '<p class="text-slate-600 leading-snug">This has been recorded as a live bird weight shortage and will <b>not</b> be carried forward — tomorrow’s opening weight starts at 0 kg. Please recheck today’s purchases, live sales, mortality and dressed counts before submitting.</p>'+
        '<button type="button" data-close class="w-full bg-slate-800 hover:bg-slate-900 text-white font-bold text-sm px-4 py-2.5 rounded-lg">Understood</button>'+
      '</div>');
  }
}

/* ---------------- dashboard ---------------- */
function dashRange(){
  var f=$('dashFrom').value||monthStart(), t=$('dashTo').value||todayISO();
  return { from:f, to:t };
}
function dashEntries(){
  var r=dashRange(), mine=myBranches();
  return S.entries.filter(function(e){
    if(e.status!=='approved') return false;
    if(mine.indexOf(e.branch)<0) return false;
    if(S.dashScope==='branch' && e.branch!==S.branch) return false;
    if(S.dashCat!=='all' && e.category!==S.dashCat) return false;
    var d=dOf(e.datetime);
    return d>=r.from && d<=r.to;
  });
}

function aggregate(list){
  var a={ revenue:0, cogs:0, labour:0, other:0, net:0, buyBirds:0, buyWtG:0, buyAmt:0,
    dressed:0, dressedWtG:0, meatG:0, liveBirds:0, liveAmt:0, cutAmt:0, mortCount:0, mortWtG:0, mortValue:0,
    damageValue:0, shortValue:0, bonusValue:0, wasteG:0, bonusG:0, shortG:0, expMeatG:0,
    skinAmt:0, skinlessAmt:0, liverAmt:0, manDays:0, days:0, avgRateNum:0, avgRateDen:0,
    counterAmt:0, hotelAmt:0, hotelConcession:0, hotelCash:0, hotelCredit:0, hotelG:0,
    byCustomer:{} };
  list.forEach(function(e){
    var c=calc(e);
    a.counterAmt+=c.counterSaleAmt; a.hotelAmt+=c.hotelAmt;
    a.hotelConcession+=c.hotelConcession; a.hotelCash+=c.hotelCash;
    a.hotelCredit+=c.hotelCredit; a.hotelG+=c.hotelTotalG;
    (e.hotelSales||[]).forEach(function(l,i){
      var p=c.hotelLines[i]; if(!p||!l.customerId) return;
      var b=a.byCustomer[l.customerId]||(a.byCustomer[l.customerId]={ g:0, amount:0, concession:0 });
      b.g+=p.grams; b.amount+=p.amount; b.concession+=p.concession;
    });
    a.revenue+=c.revenue; a.cogs+=c.cogs;
    a.buyBirds+=c.buyBirds; a.buyWtG+=c.buyWtG; a.buyAmt+=c.buyAmt;
    a.dressed+=num(e.dressedCount); a.dressedWtG+=num(e.dressedWtG); a.meatG+=num(e.actualMeatG);
    a.expMeatG+=c.expectedMeatG; a.wasteG+=c.wasteMeatG; a.bonusG+=c.bonusG; a.shortG+=c.shortG;
    a.liveBirds+=num(e.liveSoldCount); a.liveAmt+=c.liveAmt; a.cutAmt+=c.cutAmt;
    a.mortCount+=num(e.mortCount); a.mortWtG+=num(e.mortWtG); a.mortValue+=c.mortValue;
    a.damageValue+=c.damageValue; a.shortValue+=c.shortValue; a.bonusValue+=c.bonusValue;
    a.skinAmt+=c.skinAmt; a.skinlessAmt+=c.skinlessAmt; a.liverAmt+=c.liverAmt;
    a.avgRateNum+=c.availValue; a.avgRateDen+=c.availWtG/1000;
    a.days++;
  });
  a.avgRate=a.avgRateDen>0?a.avgRateNum/a.avgRateDen:0;
  a.yieldPct=a.dressedWtG>0?(a.meatG/a.dressedWtG)*100:0;
  a.net=a.revenue-a.cogs; a.margin=a.revenue>0?(a.net/a.revenue)*100:0;
  return a;
}

/* Labour is tracked in its own ledger, so for the 'all' scope it is summed
   over the date range independently of whether a daily entry exists or has
   been approved — a worker who was paid is a real cost even before the
   admin gets around to approving that day's entry.

   When the Dashboard is filtered to ONE category (Broiler or Parents),
   that shortcut breaks: wages aren't tagged by category, so a day where
   BOTH broiler and parents have an entry would show the WHOLE day's wages
   under "Broiler" alone, then the WHOLE day's wages again under "Parents"
   alone — the exact double-deduction this mirrors dayCostsFor() to avoid
   at the single-entry level. So a category filter walks day by day: a day
   only counts toward a category if that category actually has an entry
   that day. If the OTHER category also has one, they were worked by the
   same crew — broiler carries that whole day's wages, parents carries
   none of it, same rule as dayCostsFor(). */
function labourRange(codes,from,to,cat){
  if(!cat || cat==='all'){
    var wages=0,other=0,manDays=0,paid=0,advances=0;
    S.ledger.forEach(function(l){
      if(codes.indexOf(l.branch)<0) return;
      if(l.date<from||l.date>to) return;
      var def=LEDGER_TYPES[l.type]||{};
      if(l.type==='work'){ wages+=num(l.amount); manDays+=num(l.days); }
      else if(l.type==='advance'){ advances+=num(l.amount); paid+=num(l.amount); }
      else if(l.type==='paid'){ paid+=num(l.amount); }
      else if(def.shop) other+=num(l.amount);
    });
    return { wages:wages, advances:advances, other:other, manDays:manDays, paid:paid };
  }
  var wages=0, other=0, manDays=0, advances=0, paid=0;
  codes.forEach(function(branch){
    for(var d=from; d<=to; d=addDays(d,1)){
      var sameDay=S.entries.filter(function(e){ return e.branch===branch && dOf(e.datetime)===d; });
      if(!sameDay.some(function(e){ return e.category===cat; })) continue;
      if(cat==='parents' && sameDay.some(function(e){ return e.category==='broiler'; })) continue;
      var lab=labourFor(d,branch);
      wages+=lab.wages; other+=lab.other; manDays+=lab.manDays; advances+=lab.advances;
    }
  });
  /* 'paid' is an actual settlement made to a worker, not tied to any one
     day's entries — stays a flat, category-agnostic cash figure, same as
     the 'all' scope above (see the "advances are cash, not cost" note in
     withLabour()). */
  S.ledger.forEach(function(l){
    if(codes.indexOf(l.branch)<0 || l.date<from || l.date>to || l.type!=='paid') return;
    paid+=num(l.amount);
  });
  return { wages:wages, advances:advances, other:other, manDays:manDays, paid:paid };
}

/* fold labour into an aggregate for a given scope + range */
function withLabour(a,codes,from,to){
  var cat=S.dashCat;
  var l=labourRange(codes,from,to,cat);
  a.labour=l.wages; a.advances=l.advances; a.other=l.other;
  a.manDays=l.manDays; a.paidOut=l.paid;
  a.overheads=overheadsFor(codes,monthsInRange(from,to),from,to,cat).total;
  a.beforeOverheads=a.revenue-a.cogs-a.labour-a.other;
  /* advances are cash, not cost; overheads are a real cost */
  a.net=a.beforeOverheads-a.overheads;
  a.margin=a.revenue>0?(a.net/a.revenue)*100:0;
  return a;
}

/* An admin billing adjustment (add/reduce a hotel or hostel's billed amount)
   is not tied to any DailyEntry, so aggregate() — which only ever walks
   entries — can never see it. Folded in here the same way labourRange()
   folds in wages: for the 'all' scope every adjustment in the branch+range
   counts; for a single-category filter, only on a day that category
   actually has an entry, and if both categories share the day, broiler
   carries it — same rule as dayCostsFor()/labourRange(), since it's the
   same crew/shop either way. */
function customerAdjRange(codes,from,to,cat){
  var cash=0, credit=0;
  (S.customerAdjustments||[]).forEach(function(x){
    if(codes.indexOf(x.branch)<0) return;
    if(x.date<from||x.date>to) return;
    if(cat && cat!=='all'){
      var sameDay=S.entries.filter(function(e){ return e.branch===x.branch && dOf(e.datetime)===x.date; });
      if(!sameDay.some(function(e){ return e.category===cat; })) return;
      if(cat==='parents' && sameDay.some(function(e){ return e.category==='broiler'; })) return;
    }
    if(x.settled) cash+=num(x.amount); else credit+=num(x.amount);
  });
  return { cash:cash, credit:credit, total:cash+credit };
}

/* fold billing adjustments into an aggregate for a given scope + range —
   call this before withLabour() so its net/margin recompute sees the
   adjusted revenue. */
function withAdjustments(a,codes,from,to){
  var adj=customerAdjRange(codes,from,to,S.dashCat);
  a.revenue+=adj.total; a.hotelAmt+=adj.total;
  a.hotelCash+=adj.cash; a.hotelCredit+=adj.credit;
  a.net=a.revenue-a.cogs;
  a.margin=a.revenue>0?(a.net/a.revenue)*100:0;
  return a;
}

/* Closing stock is a point-in-time balance, not a sum: take the latest approved
   day inside the range for each branch + category and add those together.     */
function closingStock(codes,from,to,cat){
  var out={ birds:0, wtG:0, meatG:0, value:0, asAt:'' };
  codes.forEach(function(code){
    ['broiler','parents'].forEach(function(k){
      if(cat!=='all' && k!==cat) return;
      var last=S.entries.filter(function(e){
        if(e.status!=='approved'||e.branch!==code||e.category!==k) return false;
        var d=dOf(e.datetime); return d>=from&&d<=to;
      }).sort(function(a,b){ return a.datetime<b.datetime?1:-1; })[0];
      if(!last) return;
      out.birds+=num(last.closeBirds); out.wtG+=num(last.closeWtG); out.meatG+=num(last.closeMeatG);
      out.value+=calc(last).closeValue;
      var d=dOf(last.datetime); if(d>out.asAt) out.asAt=d;
    });
  });
  return out;
}

function mainReason(a){
  var d=[];
  if(a.shortValue>0) d.push({k:'Meat yield below expected',v:a.shortValue});
  if(a.mortValue>0) d.push({k:'Mortality',v:a.mortValue});
  if(a.damageValue>0) d.push({k:'Damaged meat',v:a.damageValue});
  if(a.labour>0) d.push({k:'Labour wages',v:a.labour});
  if(a.other>0) d.push({k:'Tea, tiffin & shop costs',v:a.other});
  d.sort(function(x,y){ return y.v-x.v; });
  if(a.net>=0) return { txt:'Profitable — biggest cost: '+(d[0]?d[0].k:'stock'), cls:'text-emerald-700' };
  return { txt:(d[0]?d[0].k+' '+money0(d[0].v):'Selling below cost'), cls:'text-rose-600' };
}

function scopeCodes(){ return S.dashScope==='all' ? myBranches() : [S.branch]; }

/* Who bought over the selected period, what it earned and what they still owe.
   The balance column comes from the server's running total, not this range,
   because a debt is a position rather than a period figure. */
function renderHotelPanel(a){
  if(!$('dhBody')) return;
  var ids=Object.keys(a.byCustomer||{});
  var rows=ids.map(function(id){
    var c=customerById(id)||{ name:'(removed)', kind:'hotel' };
    var t=S.custTotals[id]||{};
    return { id:id, name:c.name, kind:c.kind, g:a.byCustomer[id].g,
             amount:a.byCustomer[id].amount, concession:a.byCustomer[id].concession,
             balance:num(t.balance) };
  }).sort(function(x,y){ return y.amount-x.amount; });

  $('dhNote').textContent=rows.length
    ? rows.length+' customer(s) bought in this period'
    : 'no hotel or hostel sales in this period';

  var t={ g:0, amount:0, concession:0, balance:0 };
  $('dhBody').innerHTML=rows.length?rows.map(function(r){
    t.g+=r.g; t.amount+=r.amount; t.concession+=r.concession; t.balance+=r.balance;
    return '<tr class="rowhover"><td class="px-4 py-2.5 font-semibold">'+esc(r.name)+'</td>'+
      '<td class="px-4 py-2.5"><span class="text-[10px] font-bold uppercase px-2 py-1 rounded '+kindDef(r.kind).cls+'">'+esc(kindDef(r.kind).t)+'</span></td>'+
      '<td class="px-4 py-2.5 text-right num">'+fmtW(r.g)+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold text-emerald-700">'+money0(r.amount)+'</td>'+
      '<td class="px-4 py-2.5 text-right num '+(r.concession>0?'text-amber-700':r.concession<0?'text-emerald-700':'text-slate-400')+'">'+
        (r.concession>0?'−'+money0(r.concession):r.concession<0?'+'+money0(-r.concession):'—')+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold '+(r.balance>0?'text-rose-600':'text-emerald-700')+'">'+money0(r.balance)+'</td></tr>';
  }).join(''):'<tr><td colspan="6" class="px-4 py-10 text-center text-slate-400">Nothing sold to a hotel or hostel between '+dashRange().from+' and '+dashRange().to+'.</td></tr>';

  $('dhFoot').innerHTML=rows.length?'<tr><td class="px-4 py-2.5" colspan="2">Totals</td>'+
    '<td class="px-4 py-2.5 text-right num">'+fmtW(t.g)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(t.amount)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+(t.concession>=0?'−'+money0(t.concession):'+'+money0(-t.concession))+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(t.balance)+'</td></tr>':'';

  $('dhCounter').textContent=money0(a.counterAmt);
  $('dhHotel').textContent=money0(a.hotelAmt);
  $('dhCash').textContent=money0(a.hotelCash);
  $('dhCredit').textContent=money0(a.hotelCredit);
  $('dhConc').textContent=money0(Math.abs(a.hotelConcession));
  if($('dhConcLabel')){
    $('dhConcLabel').textContent=a.hotelConcession>=0?'Concession given':'Premium earned';
    $('dhConc').className='font-bold num '+(a.hotelConcession>=0?'text-amber-700':'text-emerald-700');
  }
  var counterEquiv=a.hotelAmt+a.hotelConcession;
  var concPhrase = a.hotelConcession>=0
    ? money0(a.hotelConcession)+' was given away as concession to hold this business.'
    : money0(-a.hotelConcession)+' was earned above the counter rate as a premium on these accounts.';
  $('dhExplain').textContent=a.hotelAmt>0
    ? 'These sales are already inside the '+money0(a.revenue)+' revenue above. Had the same '
      +fmtW(a.hotelG)+' gone over the counter it would have fetched '+money0(counterEquiv)
      +', so '+concPhrase
    : 'Concession (or premium) is the gap between the counter rate and what these customers actually pay. Nothing sold to them in this period.';
}

/* Bonus meat, branch and day wise — admin only (the whole dashboard already
   is). Walks the same `list` (dashEntries()) the rest of the dashboard uses,
   so it respects whatever branch/category/date-range is currently selected,
   and lists every day actual meat obtained came in above the expected
   yield. Purely informational: it does NOT change closing/opening meat —
   see the note printed on the card itself. Carrying forward less than the
   real physical remainder just to "book" the bonus separately would create
   the exact same kind of drift a stale opening-meat figure already can. */
function renderBonusMeatReport(list){
  if(!$('bmBody')) return;
  var rows=list.map(function(e){
    var c=calc(e);
    return { date:dOf(e.datetime), branch:e.branch, category:e.category,
             dressedWtG:num(e.dressedWtG), expectedMeatG:c.expectedMeatG,
             actualMeatG:num(e.actualMeatG), bonusG:c.bonusG, bonusValue:c.bonusValue };
  }).filter(function(r){ return r.bonusG>0; })
    .sort(function(a,b){ return a.date<b.date?1:-1; });

  $('bmNote').textContent = rows.length ? rows.length+' day(s) with bonus meat' : 'no bonus meat in this range';

  $('bmBody').innerHTML = rows.length ? rows.map(function(r){
    return '<tr class="rowhover"><td class="px-4 py-2.5 whitespace-nowrap">'+r.date+'</td>'+
      '<td class="px-4 py-2.5 text-xs text-slate-500">'+esc(S.branches[r.branch]||r.branch)+'</td>'+
      '<td class="px-4 py-2.5 text-xs text-slate-500 capitalize">'+esc(r.category)+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+fmtW(r.dressedWtG)+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+fmtW(r.expectedMeatG)+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+fmtW(r.actualMeatG)+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold text-emerald-700">+'+fmtW(r.bonusG)+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold text-emerald-700">'+money0(r.bonusValue)+'</td></tr>';
  }).join('') : '<tr><td colspan="8" class="px-4 py-10 text-center text-slate-400">No day in this range obtained more meat than the expected yield.</td></tr>';

  var t={ bonusG:0, bonusValue:0 };
  rows.forEach(function(r){ t.bonusG+=r.bonusG; t.bonusValue+=r.bonusValue; });
  $('bmFoot').innerHTML = rows.length ? '<tr><td class="px-4 py-2.5" colspan="6">Totals</td>'+
    '<td class="px-4 py-2.5 text-right num">+'+fmtW(t.bonusG)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(t.bonusValue)+'</td></tr>' : '';
}

/* Meat shortfall, branch and day wise — the mirror image of the bonus meat
   report above. Lists every day more meat was recorded sold/gone (counter +
   hotel + damage) than was actually obtained from dressing that day —
   calc()'s meatDeficitG, the amount that gets floored away rather than
   left negative. Also purely informational: it does NOT change closing/
   opening meat, which is already floored at zero regardless of whether
   this card is ever opened. */
function renderMeatShortfallReport(list){
  if(!$('msBody')) return;
  var rows=list.map(function(e){
    var c=calc(e);
    return { date:dOf(e.datetime), branch:e.branch, category:e.category,
             actualMeatG:num(e.actualMeatG), soldOutG:num(e.skinSoldG)+num(e.skinlessSoldG)+num(e.liverSoldG)+c.hotelMeatG+num(e.damageG),
             deficitG:c.meatDeficitG, deficitValue:c.meatDeficitValue };
  }).filter(function(r){ return r.deficitG>0; })
    .sort(function(a,b){ return a.date<b.date?1:-1; });

  $('msNote').textContent = rows.length ? rows.length+' day(s) with a meat shortfall' : 'no meat shortfall in this range';

  $('msBody').innerHTML = rows.length ? rows.map(function(r){
    return '<tr class="rowhover"><td class="px-4 py-2.5 whitespace-nowrap">'+r.date+'</td>'+
      '<td class="px-4 py-2.5 text-xs text-slate-500">'+esc(S.branches[r.branch]||r.branch)+'</td>'+
      '<td class="px-4 py-2.5 text-xs text-slate-500 capitalize">'+esc(r.category)+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+fmtW(r.actualMeatG)+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+fmtW(r.soldOutG)+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold text-rose-600">−'+fmtW(r.deficitG)+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold text-rose-600">'+money0(r.deficitValue)+'</td></tr>';
  }).join('') : '<tr><td colspan="7" class="px-4 py-10 text-center text-slate-400">No day in this range sold/lost more meat than it actually obtained.</td></tr>';

  var t={ deficitG:0, deficitValue:0 };
  rows.forEach(function(r){ t.deficitG+=r.deficitG; t.deficitValue+=r.deficitValue; });
  $('msFoot').innerHTML = rows.length ? '<tr><td class="px-4 py-2.5" colspan="5">Totals</td>'+
    '<td class="px-4 py-2.5 text-right num">−'+fmtW(t.deficitG)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(t.deficitValue)+'</td></tr>' : '';
}

/* Live bird weight shortage, branch and day wise — the same pattern as the
   bonus meat / meat shortfall reports above: walks the same `list`
   (dashEntries()), so it respects whatever branch/category/date-range is
   currently selected. Lists every day closing birds worked out to 0 while
   the weight arithmetic still left something over (calc()'s liveShortWtG).
   Purely informational — the shortage is already zeroed out of closing
   weight and never carried forward regardless of whether this card is ever
   opened; see the note on the card itself. */
function renderLiveShortReport(list){
  if(!$('lwBody')) return;
  var rows=list.map(function(e){
    var c=calc(e);
    return { date:dOf(e.datetime), branch:e.branch, category:e.category,
             closeBirds:num(e.closeBirds), shortG:c.liveShortWtG, shortValue:c.liveShortValue };
  }).filter(function(r){ return r.shortG>0; })
    .sort(function(a,b){ return a.date<b.date?1:-1; });

  $('lwNote').textContent = rows.length ? rows.length+' day(s) with a live bird weight shortage' : 'no live bird weight shortage in this range';

  $('lwBody').innerHTML = rows.length ? rows.map(function(r){
    return '<tr class="rowhover"><td class="px-4 py-2.5 whitespace-nowrap">'+r.date+'</td>'+
      '<td class="px-4 py-2.5 text-xs text-slate-500">'+esc(S.branches[r.branch]||r.branch)+'</td>'+
      '<td class="px-4 py-2.5 text-xs text-slate-500 capitalize">'+esc(r.category)+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+r.closeBirds.toLocaleString('en-IN')+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold text-rose-600">−'+fmtW(r.shortG)+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold text-rose-600">'+money0(r.shortValue)+'</td></tr>';
  }).join('') : '<tr><td colspan="6" class="px-4 py-10 text-center text-slate-400">No day in this range closed with 0 birds and leftover weight.</td></tr>';

  var t={ shortG:0, shortValue:0 };
  rows.forEach(function(r){ t.shortG+=r.shortG; t.shortValue+=r.shortValue; });
  $('lwFoot').innerHTML = rows.length ? '<tr><td class="px-4 py-2.5" colspan="4">Totals</td>'+
    '<td class="px-4 py-2.5 text-right num">−'+fmtW(t.shortG)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(t.shortValue)+'</td></tr>' : '';
}

function renderDashboard(){
  if(!isAdmin()) return;          /* dashboard is admin-only */
  if(!S.branch) return;
  var r=dashRange();
  var list=dashEntries();
  var a=withLabour(withAdjustments(aggregate(list), scopeCodes(), r.from, r.to),
                   scopeCodes(), r.from, r.to);
  $('dashScopeLabel').textContent=(S.dashScope==='all'?'All branches':S.branches[S.branch])+
    ' · '+(S.dashCat==='all'?'broiler + parents':S.dashCat)+' · '+dashRange().from+' → '+dashRange().to;

  $('plRevenue').textContent=money0(a.revenue);
  $('plCogs').textContent=money0(a.cogs);
  $('plLabour').textContent=money0(a.labour);
  $('plAdvances').textContent=money0(a.advances||0);
  (function(){
    var days={}, r2=dashRange(), codes=scopeCodes();
    S.ledger.forEach(function(l){
      if(l.type!=='advance') return;
      if(codes.indexOf(l.branch)<0) return;
      if(l.date<r2.from||l.date>r2.to) return;
      days[l.date]=1;
    });
    var nd=Object.keys(days).length;
    var el=$('plAdvancesNote');
    if(el) el.textContent = nd ? 'cash out on '+nd+' day'+(nd>1?'s':'')+' — not a cost' : 'cash out — not a cost, already in wages';
  })();
  $('plOther').textContent=money0(a.other);
  $('plNet').textContent=money0(a.net);
  $('plNet').className='mt-1 text-3xl xl:text-4xl font-bold num '+(a.net<0?'text-rose-300':'text-white');
  $('plMargin').textContent=pct(a.margin);
  $('plMargin').className='num font-bold '+(a.net<0?'text-rose-300':'text-emerald-200');
  $('plDays').textContent=a.days;
  $('plAvgRate').textContent=money0(a.avgRate);
  $('plManDays').textContent=a.manDays;
  $('plHero').className='rounded-2xl shadow-lg overflow-hidden mb-5 text-white bg-gradient-to-br '+
    (a.net<0?'from-rose-800 to-rose-950':'from-emerald-800 to-emerald-900')+(isAdmin()?'':' hidden');
  $('plNet').classList.add('glow'); setTimeout(function(){ $('plNet').classList.remove('glow'); },850);

  $('kBuyBirds').textContent=a.buyBirds.toLocaleString('en-IN');
  $('kBuyWt').textContent=fmtW(a.buyWtG);
  $('kBuyAmt').textContent=money0(a.buyAmt);
  $('kDressed').textContent=a.dressed.toLocaleString('en-IN');
  $('kDressedWt').textContent=fmtW(a.dressedWtG);
  $('kMeat').textContent=fmtW(a.meatG);
  $('kLiveBirds').textContent=a.liveBirds.toLocaleString('en-IN');
  $('kLiveAmt').textContent=money0(a.liveAmt);
  $('kCutAmt').textContent=money0(a.cutAmt);
  $('kMortCount').textContent=a.mortCount.toLocaleString('en-IN');
  $('kMortWt').textContent=fmtW(a.mortWtG);
  $('kMortVal').textContent=money0(a.mortValue);
  $('kYield').textContent=pct(a.yieldPct);
  $('kExpYield').textContent=S.dashCat==='parents'?(100-num(S.settings.wasteParents)):(100-num(S.settings.wasteBroiler));
  $('kWaste').textContent=fmtW(a.wasteG);
  renderHotelPanel(a);
  renderBonusMeatReport(list);
  renderMeatShortfallReport(list);
  renderLiveShortReport(list);

  var net=a.bonusG-a.shortG;
  var bEl=$('kBonus'), bd=$('kBonusBadge');
  if(net>0){ bEl.textContent=fmtW(net); bEl.className='mt-2 text-2xl font-bold num text-emerald-700';
    bd.textContent='Bonus '+money0(a.bonusValue); bd.className='mt-2 inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full bg-emerald-100 text-emerald-800';
    $('kBonusNote').textContent='above expected yield'; $('kBonusCard').className='card p-4 border-t-4 border-t-emerald-600'; }
  else if(net<0){ bEl.textContent='−'+fmtW(-net); bEl.className='mt-2 text-2xl font-bold num text-rose-600';
    bd.textContent='Short '+money0(a.shortValue); bd.className='mt-2 inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full bg-rose-600 text-white';
    $('kBonusNote').textContent='below expected yield'; $('kBonusCard').className='card p-4 border-t-4 border-t-rose-600'; }
  else { bEl.textContent=fmtW(0); bEl.className='mt-2 text-2xl font-bold num text-slate-400';
    bd.textContent='—'; bd.className='mt-2 inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full bg-slate-100 text-slate-600';
    $('kBonusNote').textContent='no data'; $('kBonusCard').className='card p-4 border-t-4 border-t-slate-400'; }

  $('opHandled').textContent=(a.buyBirds+a.liveBirds+a.dressed).toLocaleString('en-IN');
  $('opDays').textContent=a.days;
  $('opLive').textContent=a.liveBirds.toLocaleString('en-IN');
  $('opDressed').textContent=a.dressed.toLocaleString('en-IN');
  $('opMeat').textContent=fmtW(a.meatG);
  $('opSales').textContent=money0(a.revenue);
  $('opYield').textContent=pct(a.yieldPct);
  $('opExpYield').textContent=S.dashCat==='parents'?(100-num(S.settings.wasteParents)):(100-num(S.settings.wasteBroiler));

  /* Overheads are month-level: charged once, never spread across days. */
  var months=monthsInRange(r.from,r.to);
  var ovh=overheadsFor(scopeCodes(),months);
  var beforeOvh=(a.beforeOverheads!==undefined)?a.beforeOverheads:(a.net+ovh.total);
  var afterOvh=a.net;                      /* overheads are already inside a.net */
  $('ovhOperating').textContent=money0(beforeOvh);
  $('ovhOperating').className='font-bold num '+(beforeOvh<0?'text-rose-600':'text-emerald-700');
  $('ovhTotal').textContent=ovh.total?'−'+money0(ovh.total):'₹0';
  $('ovhNet').textContent=money0(afterOvh);
  $('ovhNet').className='font-bold num text-xl '+(afterOvh<0?'text-rose-600':'text-emerald-700');
  $('ovhNote').textContent=(months.length>1
      ? months.length+' months ('+months[0]+' → '+months[months.length-1]+')'
      : months[0])+' · '+ovh.count+' approved item(s) · already deducted above';
  var ovhMax=Math.max.apply(null,Object.keys(ovh.by).map(function(k){return ovh.by[k];}).concat([1]));
  $('ovhBreakdown').innerHTML=Object.keys(ovh.by).length
    ? Object.keys(ovh.by).sort(function(x,y){return ovh.by[y]-ovh.by[x];}).map(function(k){
        return '<div><div class="flex items-center gap-2 text-xs mb-1">'+
          '<i class="fa-solid '+ovhCatIcon(k)+' text-amber-600"></i>'+
          '<span class="font-semibold text-slate-600">'+esc(ovhCatName(k))+'</span>'+
          '<span class="ml-auto font-bold num text-amber-700">'+money0(ovh.by[k])+'</span></div>'+
          '<div class="h-1.5 rounded-full bg-slate-100 overflow-hidden"><div class="h-full bg-amber-500" style="width:'+(ovh.by[k]/ovhMax*100).toFixed(1)+'%"></div></div></div>';
      }).join('')
    : '<p class="text-xs text-slate-400 italic">No approved overheads for this period. Rent, electricity and supervisor salary are entered on the Overheads tab.</p>';

  var cs=closingStock(scopeCodes(),r.from,r.to,S.dashCat);
  $('kCloseBirds').textContent=cs.birds.toLocaleString('en-IN');
  $('kCloseWt').textContent=fmtW(cs.wtG);
  $('kCloseMeat').textContent=fmtW(cs.meatG);
  $('kCloseValue').textContent=money0(cs.value);
  $('closingAsAt').textContent=cs.asAt
    ? 'as at '+cs.asAt+(S.dashScope==='all'?' · all branches combined':'')+' · carried into the next day'
    : 'no approved day in this range';

  $('dashAlerts').innerHTML = a.days? '' :
    '<div class="card px-4 py-3 text-sm text-slate-500"><i class="fa-solid fa-circle-info mr-2"></i>No approved records in this range. Approve entries to populate the profit figures.</div>';

  renderBranchPerf(); renderReasons(a); renderCharts();
}

function renderBranchPerf(){
  var r=dashRange(), mine=myBranches();
  var codes=(S.dashScope==='all')?mine:[S.branch];
  $('branchPerfHint').textContent=S.dashScope==='all'?'comparing '+codes.length+' branches':'switch to “All branches” to compare';
  var tot={revenue:0,cogs:0,labour:0,other:0,net:0};
  $('branchPerfBody').innerHTML=codes.map(function(code){
    var list=S.entries.filter(function(e){
      if(e.status!=='approved'||e.branch!==code) return false;
      if(S.dashCat!=='all'&&e.category!==S.dashCat) return false;
      var d=dOf(e.datetime); return d>=r.from&&d<=r.to;
    });
    var a=withLabour(aggregate(list),[code],r.from,r.to), rs=mainReason(a);
    var bcs=closingStock([code],r.from,r.to,S.dashCat);
    tot.revenue+=a.revenue; tot.cogs+=a.cogs; tot.labour+=a.labour; tot.other+=a.other; tot.net+=a.net;
    return '<tr class="rowhover">'+
      '<td class="px-4 py-2.5 font-semibold">'+esc(S.branches[code]||code)+'<span class="block text-xs text-slate-400">'+a.days+' day(s)</span></td>'+
      '<td class="px-4 py-2.5 text-right num">'+money0(a.revenue)+'</td>'+
      '<td class="px-4 py-2.5 text-right num text-slate-600">'+money0(a.cogs)+'</td>'+
      '<td class="px-4 py-2.5 text-right num text-slate-600">'+money0(a.labour+a.other)+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold '+(a.net<0?'text-rose-600':'text-emerald-700')+'">'+money0(a.net)+'</td>'+
      '<td class="px-4 py-2.5 text-right num '+(a.net<0?'text-rose-600':'text-emerald-700')+'">'+pct(a.margin)+'</td>'+
      '<td class="px-4 py-2.5 text-right num text-slate-600">'+bcs.birds+' birds<span class="block text-xs text-slate-400">'+fmtW(bcs.wtG)+' · meat '+fmtW(bcs.meatG)+'</span></td>'+
      '<td class="px-4 py-2.5 text-xs font-semibold '+rs.cls+'">'+esc(rs.txt)+'</td></tr>';
  }).join('')||'<tr><td colspan="8" class="px-4 py-8 text-center text-slate-400">No data.</td></tr>';

  $('branchPerfFoot').innerHTML=codes.length>1?'<tr><td class="px-4 py-2.5">All branches</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(tot.revenue)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(tot.cogs)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(tot.labour+tot.other)+'</td>'+
    '<td class="px-4 py-2.5 text-right num '+(tot.net<0?'text-rose-700':'')+'">'+money0(tot.net)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+pct(tot.revenue>0?tot.net/tot.revenue*100:0)+'</td><td></td><td></td></tr>':'';
}

function renderReasons(a){
  var items=[
    {k:'Stock cost (birds sold)',v:a.cogs,ic:'fa-basket-shopping',c:'slate'},
    {k:'Labour wages',v:a.labour,ic:'fa-people-group',c:'amber'},
    {k:'Tea, tiffin & shop costs',v:a.other,ic:'fa-mug-hot',c:'amber'},
    {k:'Overheads (rent, power, salary)',v:a.overheads||0,ic:'fa-file-invoice-dollar',c:'amber'},
    {k:'Mortality loss',v:a.mortValue,ic:'fa-heart-crack',c:'rose'},
    {k:'Damaged meat',v:a.damageValue,ic:'fa-ban',c:'rose'},
    {k:'Yield shortfall',v:a.shortValue,ic:'fa-arrow-trend-down',c:'rose'},
    {k:'Bonus meat gained',v:-a.bonusValue,ic:'fa-arrow-trend-up',c:'emerald'}
  ].filter(function(x){ return Math.abs(x.v)>0.5; });
  var max=Math.max.apply(null,items.map(function(x){return Math.abs(x.v);}).concat([1]));
  $('reasonList').innerHTML=items.length?items.map(function(x){
    var col={slate:'bg-slate-400',amber:'bg-amber-500',rose:'bg-rose-500',emerald:'bg-emerald-500'}[x.c];
    var txt={slate:'text-slate-700',amber:'text-amber-700',rose:'text-rose-600',emerald:'text-emerald-700'}[x.c];
    return '<div><div class="flex items-center gap-2 text-xs mb-1"><i class="fa-solid '+x.ic+' '+txt+'"></i>'+
      '<span class="font-semibold text-slate-600">'+x.k+'</span>'+
      '<span class="ml-auto font-bold num '+txt+'">'+money0(Math.abs(x.v))+'</span></div>'+
      '<div class="h-1.5 rounded-full bg-slate-100 overflow-hidden"><div class="h-full '+col+'" style="width:'+(Math.abs(x.v)/max*100).toFixed(1)+'%"></div></div></div>';
  }).join(''):'<p class="text-xs text-slate-400 italic">No cost data in this range.</p>';
}

function renderCharts(){
  if(typeof Chart==='undefined') return;
  var r=dashRange(), days=[], cur=r.from, guard=0;
  while(cur<=r.to && guard++<120){ days.push(cur); cur=addDays(cur,1); }
  if(days.length>31) days=days.slice(days.length-31);

  var mine=myBranches(), codes=scopeCodes();
  var series=days.map(function(d){
    var list=S.entries.filter(function(e){
      if(e.status!=='approved'||dOf(e.datetime)!==d) return false;
      if(mine.indexOf(e.branch)<0) return false;
      if(S.dashScope==='branch'&&e.branch!==S.branch) return false;
      if(S.dashCat!=='all'&&e.category!==S.dashCat) return false;
      return true;
    });
    return { d:d, a:withLabour(aggregate(list),codes,d,d) };
  });
  var labels=series.map(function(x){ return shortD(x.d); });
  var grid={grid:{color:'#e2e8f0'},ticks:{color:'#64748b',font:{size:10}}};
  var base={responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{boxWidth:12,font:{size:11},color:'#475569'}}},scales:{x:grid,y:Object.assign({beginAtZero:true},grid)}};
  function mk(k,id,cfg){ if(S.charts[k]) S.charts[k].destroy(); S.charts[k]=new Chart($(id),cfg); }

  mk('profit','chartProfit',{ type:'bar', data:{ labels:labels, datasets:[
    { label:'Revenue', data:series.map(function(x){return Math.round(x.a.revenue);}), backgroundColor:'#a7f3d0', borderRadius:3, order:2 },
    { label:'Net profit', type:'line', data:series.map(function(x){return Math.round(x.a.net);}),
      borderColor:'#046C4E', backgroundColor:'rgba(4,108,78,.15)', fill:true, tension:.3, borderWidth:2.5, pointRadius:2, order:1 }
  ]}, options:base });

  var agg=withLabour(aggregate(dashEntries()),codes,r.from,r.to);
  var vals=[agg.skinAmt,agg.skinlessAmt,agg.liverAmt,agg.liveAmt,agg.cutAmt];
  var tot=vals.reduce(function(a,b){return a+b;},0);
  mk('split','chartSplit',{ type:'doughnut', data:{ labels:['Skin','Skinless','Liver','Live birds','Cutting'],
    datasets:[{ data: tot>0?vals.map(function(x){return Math.round(x);}):[1],
      backgroundColor: tot>0?['#046C4E','#10b981','#F59E0B','#fbbf24','#94a3b8']:['#e2e8f0'], borderWidth:2, borderColor:'#fff' }]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'58%',plugins:{legend:{position:'bottom',labels:{boxWidth:12,font:{size:11},color:'#475569',padding:10}}}} });

  var expY=S.dashCat==='parents'?100-num(S.settings.wasteParents):100-num(S.settings.wasteBroiler);
  mk('yield','chartYield',{ type:'bar', data:{ labels:labels, datasets:[
    { label:'Actual yield %', data:series.map(function(x){ return x.a.dressedWtG>0?+x.a.yieldPct.toFixed(1):null; }),
      backgroundColor:series.map(function(x){ return x.a.yieldPct<expY-num(S.settings.tolerance)?'#e11d48':x.a.yieldPct>expY+num(S.settings.tolerance)?'#F59E0B':'#046C4E'; }), borderRadius:4, maxBarThickness:26 },
    { label:'Expected '+expY+'%', type:'line', data:series.map(function(){return expY;}), borderColor:'#64748b', borderDash:[5,4], borderWidth:2, pointRadius:0, fill:false }]},
    options:Object.assign({},base,{scales:{x:grid,y:Object.assign({suggestedMin:50,suggestedMax:90},grid)}}) });

  mk('loss','chartLoss',{ type:'bar', data:{ labels:labels, datasets:[
    { label:'Mortality ₹', data:series.map(function(x){return Math.round(x.a.mortValue);}), backgroundColor:'#e11d48', borderRadius:3, stack:'a' },
    { label:'Damage ₹', data:series.map(function(x){return Math.round(x.a.damageValue);}), backgroundColor:'#fb7185', borderRadius:3, stack:'a' },
    { label:'Yield short ₹', data:series.map(function(x){return Math.round(x.a.shortValue);}), backgroundColor:'#F59E0B', borderRadius:3, stack:'a' }]},
    options:Object.assign({},base,{scales:{x:Object.assign({stacked:true},grid),y:Object.assign({stacked:true,beginAtZero:true},grid)}}) });
}

/* ---------------- records ---------------- */
function visibleEntries(){
  var mine=myBranches();
  return S.entries.filter(function(e){
    if(mine.indexOf(e.branch)<0) return false;
    if(!isAdmin()&&e.createdBy!==S.user.id) return false;
    return true;
  });
}
function filteredEntries(){
  var from=$('recFrom').value,to=$('recTo').value,br=$('recBranch').value,cat=$('recCat').value,st=$('recStatus').value;
  return visibleEntries().filter(function(e){
    var d=dOf(e.datetime);
    if(from&&d<from) return false; if(to&&d>to) return false;
    if(br&&e.branch!==br) return false; if(cat&&e.category!==cat) return false; if(st&&e.status!==st) return false;
    return true;
  }).sort(function(a,b){ return a.datetime<b.datetime?1:a.datetime>b.datetime?-1:0; });
}
function statusChip(st){
  var m={ draft:['bg-slate-100 text-slate-700','fa-pencil','Draft'], pending:['bg-amber-100 text-amber-800','fa-hourglass-half','Pending'],
    approved:['bg-emerald-100 text-emerald-800','fa-circle-check','Approved'], rejected:['bg-rose-100 text-rose-800','fa-circle-xmark','Returned'] }[st]||['bg-slate-100','fa-question','—'];
  return '<span class="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full '+m[0]+'"><i class="fa-solid '+m[1]+'"></i>'+m[2]+'</span>';
}
function renderRecords(){
  var list=filteredEntries(); $('recCount').textContent=list.length;
  $('recordsTitle').textContent=isAdmin()?'Approvals & Records':'My Entries';

  /* The nav tab's badge counts every pending entry you can see, with no
     date/branch/category limit — the list below only shows what matches
     the filters above it. When those disagree (e.g. an old or
     different-branch entry is still pending), say so plainly and offer a
     one-click way to see it, instead of leaving the badge's promise
     looking like a bug. */
  var allPending=visibleEntries().filter(function(e){return e.status==='pending';}).length;
  var shownPending=list.filter(function(e){return e.status==='pending';}).length;
  var hidden=allPending-shownPending;
  var hint=$('recHiddenHint'), showAllBtn=$('recShowAllPending');
  if(hint) hint.classList.toggle('hidden',hidden<=0);
  if(hint && hidden>0) hint.textContent=' — '+hidden+' more pending entr'+(hidden===1?'y':'ies')+' outside these filters';
  if(showAllBtn) showAllBtn.classList.toggle('hidden',hidden<=0 || !isAdmin());

  var body=$('recBody');
  if(!list.length){ body.innerHTML='<tr><td colspan="'+(isAdmin()?11:10)+'" class="px-4 py-12 text-center text-slate-400"><i class="fa-solid fa-inbox text-3xl mb-2 block"></i>No entries match the filters.</td></tr>'; return; }
  body.innerHTML=list.map(function(e){
    var c=calc(e);
    return '<tr class="rowhover transition">'+
      '<td class="px-4 py-3 font-semibold whitespace-nowrap">'+dOf(e.datetime)+'<span class="block text-xs text-slate-400">'+String(e.datetime||'').slice(11,16)+'</span></td>'+
      '<td class="px-4 py-3 text-slate-600 whitespace-nowrap">'+esc(S.branches[e.branch]||e.branch)+'</td>'+
      '<td class="px-4 py-3"><span class="text-[10px] font-bold uppercase px-2 py-1 rounded '+(e.category==='parents'?'bg-amber-100 text-amber-800':'bg-emerald-100 text-emerald-800')+'">'+(e.category==='parents'?'Parents':'Broiler')+'</span></td>'+
      '<td class="px-4 py-3 text-right num">'+c.buyBirds+'<span class="block text-xs text-slate-400">'+money0(c.buyAmt)+'</span></td>'+
      '<td class="px-4 py-3 text-right num">'+fmtW(e.actualMeatG)+'</td>'+
      '<td class="px-4 py-3 text-right num font-semibold '+(c.yieldLow?'text-rose-600':c.yieldHigh?'text-amber-600':'text-emerald-700')+'">'+pct(c.yieldPct)+'</td>'+
      '<td class="px-4 py-3 text-right num">'+money0(c.revenue)+'</td>'+
      (isAdmin()?'<td class="px-4 py-3 text-right num font-bold '+(c.netProfit<0?'text-rose-600':'text-emerald-700')+'">'+money0(c.netProfit)+'</td>':'')+
      '<td class="px-4 py-3 text-xs text-slate-500">'+esc(userName(e.createdBy))+'</td>'+
      '<td class="px-4 py-3">'+statusChip(e.status)+'</td>'+
      '<td class="px-4 py-3 text-right whitespace-nowrap">'+
        '<button data-act="review" data-id="'+e.id+'" title="Review" class="h-8 w-8 rounded-lg text-emerald-700 hover:bg-emerald-100"><i class="fa-solid fa-eye"></i></button>'+
        (canEdit(e)?'<button data-act="edit" data-id="'+e.id+'" title="Edit" class="h-8 w-8 rounded-lg text-slate-600 hover:bg-slate-100"><i class="fa-solid fa-pen-to-square"></i></button>':'')+
        (isAdmin()?'<button data-act="del" data-id="'+e.id+'" title="Delete" class="h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-100"><i class="fa-solid fa-trash"></i></button>':'')+
      '</td></tr>';
  }).join('');
}
function updatePendingBadge(){
  var n=visibleEntries().filter(function(e){return e.status==='pending';}).length;
  var b=$('pendingBadge'); b.textContent=n; b.classList.toggle('hidden',n===0);
  var o=visibleOverheads().filter(function(x){return x.status==='pending';}).length;
  var ob=$('ovhBadge'); if(ob){ ob.textContent=o; ob.classList.toggle('hidden',o===0); }
}

/* Admin fills the buying rates here, at approval time. Everything downstream
   (weighted average cost, stock cost, profit) recalculates from these.        */
function costingPanel(e,c){
  if(!isAdmin()) return '';
  var gaps=costingGaps(e);
  var rows=(e.purchases||[]).map(function(p,i){
    return '<div><label class="lbl">'+esc(p.supplier||'Purchase '+(i+1))+' — '+num(p.birds)+' birds · '+fmtW(p.wtG)+'</label>'+
      '<div class="flex items-center gap-2"><span class="text-xs font-bold text-slate-400">₹</span>'+
      '<input type="number" min="0" step="0.01" data-rvrate="'+i+'" class="inp num'+(num(p.rate)<=0?' missing':'')+'" value="'+(p.rate||'')+'" placeholder="rate / kg" />'+
      '<span class="text-xs font-bold text-slate-400">/kg</span></div>'+
      '<p class="text-[11px] text-slate-500 mt-1">Line value <span class="num font-semibold" data-rvline="'+i+'">'+money(num(p.wtG)/1000*num(p.rate))+'</span></p></div>';
  }).join('');
  return '<div class="card p-4 border-2 border-slate-300 bg-slate-50 mb-4">'+
      '<h4 class="font-bold text-xs uppercase tracking-wider mb-1 text-slate-700">'+
        '<i class="fa-solid fa-calendar-day mr-1"></i>Record date &amp; time — admin may correct it</h4>'+
      '<p class="text-xs text-slate-500 mb-2">Moving the entry changes which day these figures belong to, '+
      'and what carries into the next day. Approved records may be amended.</p>'+
      '<div class="flex items-center gap-3 flex-wrap">'+
        '<input type="datetime-local" id="rvDate" class="inp num" style="max-width:240px" value="'+esc(String(e.datetime||'').slice(0,16))+'" />'+
        '<span class="text-xs font-semibold" id="rvDateNote">currently '+esc(String(e.datetime||'').replace('T',' '))+'</span>'+
      '</div>'+
    '</div>'+
    '<div class="card p-4 border-2 '+(gaps.length?'border-amber-400 bg-amber-50':'border-emerald-300 bg-emerald-50')+'">'+
    '<h4 class="font-bold text-xs uppercase tracking-wider mb-1 '+(gaps.length?'text-amber-800':'text-emerald-800')+'">'+
      '<i class="fa-solid fa-indian-rupee-sign mr-1"></i>Buying rates — admin entry</h4>'+
    '<p class="text-xs mb-3 '+(gaps.length?'text-amber-700':'text-emerald-700')+'">'+
      (gaps.length?'Enter the '+gaps.join(' and ')+' to unlock approval. Profit and loss is calculated from these rates.'
                  :'Rates recorded. Profit and loss below reflects them.')+'</p>'+
    '<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">'+
      '<div><label class="lbl">Opening stock cost</label>'+
        '<div class="flex items-center gap-2"><span class="text-xs font-bold text-slate-400">₹</span>'+
        '<input type="number" min="0" step="0.01" id="rvOpenRate" class="inp num'+(num(e.openWtG)>0&&num(e.openRate)<=0?' missing':'')+'" value="'+(e.openRate||'')+'" placeholder="rate / kg" />'+
        '<span class="text-xs font-bold text-slate-400">/kg</span></div>'+
        '<p class="text-[11px] text-slate-500 mt-1">'+fmtW(e.openWtG)+' in hand</p></div>'+
      rows+
    '</div>'+
    '<div class="mt-3 flex items-center gap-2 rounded-lg bg-slate-800 text-white px-4 py-2.5 text-sm">'+
      '<i class="fa-solid fa-scale-balanced text-amber-400"></i><span class="font-semibold">Weighted average cost</span>'+
      '<span class="ml-auto font-bold num text-amber-300" id="rvAvg">'+money(c.avgRate)+' / kg</span></div>'+
  '</div>';
}

function repriceReview(id){
  var e=S.entries.filter(function(x){return x.id===id;})[0]; if(!e) return;
  var c=calc(e);
  if($('rvAvg')) $('rvAvg').textContent=money(c.avgRate)+' / kg';
  if($('rvRevenue')) $('rvRevenue').textContent=money0(c.revenue);
  if($('rvCogs')) $('rvCogs').textContent=money0(c.cogs);
  if($('rvNet')) $('rvNet').textContent=money0(c.netProfit);
  (e.purchases||[]).forEach(function(p,i){
    var el=document.querySelector('[data-rvline="'+i+'"]');
    if(el) el.textContent=money(num(p.wtG)/1000*num(p.rate));
  });
  var gaps=costingGaps(e), btn=$('rvApprove');
  if(btn){
    btn.disabled=gaps.length>0;
    btn.className='inline-flex items-center gap-2 font-bold text-sm px-5 py-2.5 rounded-lg '+
      (gaps.length?'bg-slate-300 text-slate-500 cursor-not-allowed':'bg-emerald-700 hover:bg-emerald-800 text-white');
    btn.title=gaps.length?'Enter the '+gaps.join(' and ')+' first':'';
  }
}

function openReview(id){
  var e=S.entries.filter(function(x){return x.id===id;})[0]; if(!e) return;
  var c=calc(e);
  $('reviewTitle').textContent=(e.category==='parents'?'Parents':'Broiler')+' — '+dOf(e.datetime);
  $('reviewSub').textContent=(S.branches[e.branch]||e.branch)+' · by '+userName(e.createdBy)+' · '+e.status;
  function row(l,val,cls){ return '<div class="flex justify-between py-1.5 border-b border-slate-100 text-sm"><span class="text-slate-500">'+l+'</span><span class="font-semibold num '+(cls||'')+'">'+val+'</span></div>'; }
  function block(t,rows){ return '<div class="card p-4"><h4 class="font-bold text-xs uppercase tracking-wider text-slate-600 mb-2">'+t+'</h4>'+rows+'</div>'; }
  var purch=(e.purchases||[]).map(function(p){
    var isRet=p.kind==='return';
    return row((isRet?'↩ RETURN to ':'')+esc(p.supplier||'Supplier')+' — '+num(p.birds)+' birds',
      fmtW(p.wtG)+' @ '+money(p.rate)+' = '+(isRet?'−':'')+money(num(p.wtG)/1000*num(p.rate)), isRet?'text-rose-700':'');
  }).join('')||'<p class="text-xs text-slate-400 italic">No purchases.</p>';
  var photos=(e.photos||[]).map(function(src,i){ return '<img src="'+src+'" data-view="'+i+'" alt="Mortality photo '+(i+1)+'" class="h-28 w-28 object-cover rounded-lg border-2 border-slate-200 cursor-zoom-in" />'; }).join('');
  var hotelBlock=(e.hotelSales||[]).length
    ? (e.hotelSales||[]).map(function(l,i){
        var p=c.hotelLines[i]||priceHotelLine(l,e);
        return row(esc(l.customerName||'—')+' — '+productDef(l.product).t+
          ' <span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded '+
          (l.settled?'bg-emerald-100 text-emerald-800':'bg-rose-100 text-rose-700')+'">'+
          (l.settled?'paid':'on account')+'</span>',
          fmtW(p.grams)+' @ '+money(p.rate)+' = '+money(p.amount)+
          (p.concession>0?' <span class="text-amber-700">(−'+money(p.concession)+')</span>'
            :p.concession<0?' <span class="text-emerald-700">(+'+money(-p.concession)+')</span>':''));
      }).join('')+
      row('Total billed',money(c.hotelAmt),'text-indigo-700')+
      row('Of which on account',money(c.hotelCredit),c.hotelCredit>0?'text-rose-600':'')+
      row(c.hotelConcession>=0?'Concession given':'Premium earned',
          money(Math.abs(c.hotelConcession)),c.hotelConcession>=0?'text-amber-700':'text-emerald-700')
    : '<p class="text-xs text-slate-400 italic">Nothing sold to a hotel or hostel on this day.</p>';

  $('reviewBody').innerHTML=alertHtml(warnings(e,c),false)+
    (!isAdmin()?'':'<div class="rounded-xl p-4 text-white '+(c.netProfit<0?'bg-rose-700':'bg-emerald-700')+'">'+
      '<div class="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">'+
      '<div><p class="text-[10px] uppercase tracking-wider opacity-75">Revenue</p><p class="font-bold num text-lg" id="rvRevenue">'+money0(c.revenue)+'</p></div>'+
      '<div><p class="text-[10px] uppercase tracking-wider opacity-75">Stock cost</p><p class="font-bold num text-lg" id="rvCogs">'+money0(c.cogs)+'</p></div>'+
      '<div><p class="text-[10px] uppercase tracking-wider opacity-75">Labour</p><p class="font-bold num text-lg">'+money0(c.labour)+'</p></div>'+
      '<div><p class="text-[10px] uppercase tracking-wider opacity-75">Other</p><p class="font-bold num text-lg">'+money0(c.otherExp)+'</p></div>'+
      '<div><p class="text-[10px] uppercase tracking-wider opacity-75">Net P/L</p><p class="font-bold num text-xl" id="rvNet">'+money0(c.netProfit)+'</p></div>'+
      '</div></div>')+
    costingPanel(e,c)+
    '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">'+
      block('Opening stock', row('Opening birds',num(e.openBirds))+row('Opening weight',fmtWs(e.openWtG))+row('Open meat',fmtWs(e.openMeatG))+
        (isAdmin()?row('Opening rate',money(e.openRate)+'/kg')+row('Weighted avg cost',money(c.avgRate)+'/kg','text-emerald-700'):''))+
      block('Purchases', purch+row('Total purchased',c.buyBirds+' birds · '+fmtW(c.buyWtG)+(isAdmin()?' · '+money(c.buyAmt):''),'text-emerald-700'))+
      block('Live retail sales (no dressing)', row('Live birds sold',num(e.liveSoldCount)+' birds')+row('Live weight sold',fmtWs(e.liveSoldWtG))+row('Live sale amount',money(c.liveAmt),'text-emerald-700')+row('Cutting charges',money(e.cutCharges)))+
      block('Dressing', row('Dressed birds',num(e.dressedCount))+row('Live weight',fmtWs(e.dressedWtG))+row('Expected meat @'+(100-c.wastePct)+'%',fmtWs(c.expectedMeatG))+row('Waste @'+c.wastePct+'%',fmtWs(c.wasteMeatG))+row('Actual meat',fmtWs(c.actualMeatG))+row('Yield',pct(c.yieldPct),c.yieldLow?'text-rose-600':c.yieldHigh?'text-amber-600':'text-emerald-700')+row(c.bonusG>0?'Bonus meat':'Shortfall',(c.bonusG>0?fmtWs(c.bonusG):fmtWs(c.shortG))+(isAdmin()?' ≈ '+money0(c.bonusG>0?c.bonusValue:c.shortValue):''),c.bonusG>0?'text-emerald-700':'text-rose-600'))+
      block('Sales', row('Skin (counter)',fmtW(e.skinSoldG)+' · '+money(c.skinAmt))+row('Skinless (counter)',fmtW(e.skinlessSoldG)+' · '+money(c.skinlessAmt))+row('Liver (counter)',fmtW(e.liverSoldG)+' · '+money(c.liverAmt))+row('Hotels &amp; hostels',fmtW(c.hotelTotalG)+' · '+money(c.hotelAmt),'text-indigo-700')+row('Live birds',num(e.liveSoldCount)+' · '+money(c.liveAmt))+row('Cutting',money(e.cutCharges))+row('Total revenue',money(c.revenue),'text-emerald-700'))+
      block('Hotels &amp; hostels', hotelBlock)+
      block('Mortality & damage', row('Mortality',num(e.mortCount)+' birds')+row('Weight',fmtWs(e.mortWtG))+row('Rate',pct(c.mortRate,2))+
        (isAdmin()?row('Value lost',money0(c.mortValue),'text-rose-600'):'')+row('Damage meat',fmtWs(e.damageG)+(isAdmin()?' ≈ '+money0(c.damageValue):'')))+
      block('Closing (carried forward)', row('Closing birds',num(e.closeBirds))+row('Expected',c.expBirds)+row('Variance',c.birdVar,c.birdVar?'text-rose-600':'text-emerald-700')+row('Closing weight',fmtWs(e.closeWtG))+row('Closing meat',fmtWs(e.closeMeatG))+(isAdmin()?row('Closing stock value',money(c.closeValue),'text-emerald-700'):''))+
    '</div>'+
    (e.notes?'<div class="card p-4"><h4 class="font-bold text-xs uppercase tracking-wider text-slate-600 mb-1">Remarks</h4><p class="text-sm">'+esc(e.notes)+'</p></div>':'')+
    (e.explanation?'<div class="card p-4 bg-amber-50 border-amber-200"><h4 class="font-bold text-xs uppercase tracking-wider text-amber-800 mb-1">Supervisor explanation</h4><p class="text-sm text-amber-900">'+esc(e.explanation)+'</p></div>':'')+
    (e.rejectReason?'<div class="card p-4 bg-rose-50 border-rose-200"><h4 class="font-bold text-xs uppercase tracking-wider text-rose-800 mb-1">Admin reason for return</h4><p class="text-sm text-rose-900">'+esc(e.rejectReason)+'</p></div>':'')+
    '<div class="card p-4"><h4 class="font-bold text-xs uppercase tracking-wider text-slate-600 mb-2">Mortality photos '+(num(e.mortCount)>0?'<span class="text-rose-600">(verify before approving)</span>':'')+'</h4><div class="flex flex-wrap gap-3">'+(photos||'<p class="text-xs text-slate-400 italic">No photos.</p>')+'</div></div>';

  var foot='';
  if(isAdmin()&&(e.status==='pending'||e.status==='rejected')){
    foot+='<button id="rvApprove" class="inline-flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg"><i class="fa-solid fa-circle-check"></i> Approve &amp; save record</button>';
    foot+='<button id="rvReject" class="inline-flex items-center gap-2 bg-rose-600 hover:bg-rose-700 text-white font-bold text-sm px-5 py-2.5 rounded-lg"><i class="fa-solid fa-circle-xmark"></i> Return for correction</button>';
  }
  if(isAdmin()&&e.status==='approved') foot+='<span class="text-xs text-emerald-700 font-semibold self-center"><i class="fa-solid fa-lock mr-1"></i>Approved '+String(e.reviewedAt||'').slice(0,10)+' by '+esc(userName(e.reviewedBy))+'</span>';
  if(canEdit(e)) foot+='<button id="rvEdit" class="inline-flex items-center gap-2 border border-slate-300 text-slate-600 font-bold text-sm px-5 py-2.5 rounded-lg"><i class="fa-solid fa-pen-to-square"></i> Edit</button>';
  foot+='<button id="rvPrint" class="inline-flex items-center gap-2 border border-slate-300 text-slate-600 font-bold text-sm px-5 py-2.5 rounded-lg"><i class="fa-solid fa-print"></i> Print voucher</button>';
  foot+='<button data-close="1" class="ml-auto border border-slate-300 text-slate-600 font-bold text-sm px-5 py-2.5 rounded-lg">Close</button>';
  $('reviewFoot').innerHTML=foot;
  bind('rvApprove',function(){ decide(e.id,'approved'); });
  bind('rvPrint',function(){ printEntryVoucher(e.id); });
  $('reviewBody').addEventListener('input',function(ev){
    var t=ev.target;
    if(t.id==='rvDate'){
      var nd=t.value; if(!nd || nd.length<16) return;
      api('PUT','/entries/'+e.id+'/costing',{ datetime:nd })
        .then(function(rec){
          upsertEntry(rec);
          e.datetime=rec.datetime; e.businessDate=rec.businessDate;
          $('rvDateNote').textContent='moved to '+String(rec.datetime||'').replace('T',' ');
          $('rvDateNote').className='text-xs font-semibold text-emerald-700';
          $('reviewTitle').textContent=(rec.category==='parents'?'Parents':'Broiler')+' — '+dOf(rec.datetime);
          $('rvDate').value=String(rec.datetime||'').slice(0,16);
          renderRecords(); renderDashboard();
          toast('Business date changed to '+nd+'.');
        })
        .catch(function(err){
          $('rvDateNote').textContent=(err&&err.message)||'Could not move the entry';
          $('rvDateNote').className='text-xs font-semibold text-rose-600';
          t.value=String(e.datetime||'').slice(0,16);
          apiFail(err);
        });
      return;
    }
    if(t.id==='rvOpenRate'){ e.openRate=num(t.value); }
    else if(t.hasAttribute&&t.hasAttribute('data-rvrate')){
      var i=+t.getAttribute('data-rvrate');
      if(e.purchases&&e.purchases[i]) e.purchases[i].rate=num(t.value);
    } else return;
    t.classList.toggle('missing',num(t.value)<=0);
    DB.write(K.entries,S.entries);
    repriceReview(e.id);
  });
  repriceReview(e.id);
  bind('rvReject',function(){ closeModal('reviewModal'); askReject(e.id); });
  bind('rvEdit',function(){ closeModal('reviewModal'); showView('entry'); loadEntry(e.id); });
  $('reviewModal').classList.remove('hidden');
}

/* A one-page printable voucher for a single daily entry — the full breakdown
   (opening stock, purchases, sales, hotel lines, mortality, closing) someone
   would file or hand to another branch/office. Reuses exactly what
   openReview() already rendered into #reviewBody rather than rebuilding the
   same layout twice, so the voucher always matches what's on screen. */
function printEntryVoucher(id){
  var e=S.entries.filter(function(x){return x.id===id;})[0]; if(!e) return;
  var head='<div style="border-bottom:3px solid #046C4E;padding-bottom:10px;margin-bottom:14px">'+
    '<h1 style="margin:0;font:700 20px sans-serif;color:#046C4E">Venus Chicken Centers</h1>'+
    '<p style="margin:3px 0 0;font:400 12px sans-serif;color:#475569">'+
      esc((e.category==='parents'?'Parents':'Broiler')+' — '+dOf(e.datetime))+' · '+
      esc(S.branches[e.branch]||e.branch)+' · '+esc(e.status)+' · by '+esc(userName(e.createdBy))+
      ' · voucher generated '+new Date().toLocaleString()+'</p></div>';
  var body=$('reviewBody')?$('reviewBody').innerHTML:'<p>Nothing to show.</p>';
  var sign='<div style="margin-top:34px;font:400 10px sans-serif;display:flex;gap:50px">'+
    '<div style="border-top:1px solid #475569;padding-top:5px;width:180px">Supervisor</div>'+
    '<div style="border-top:1px solid #475569;padding-top:5px;width:180px">Admin approval</div></div>';
  $('printArea').innerHTML=head+'<div style="font:400 11px sans-serif">'+body+'</div>'+sign;
  window.print();
}

/* ---------------- labour ---------------- */
function branchWorkers(){ return S.workers.filter(function(w){ return w.branch===S.branch && w.active!==false; }); }
function workerStats(id){
  var earned=0,paid=0,ded=0,days=0;
  S.ledger.forEach(function(l){
    if(l.workerId!==id) return;
    if(l.type==='work'){ earned+=num(l.amount); days+=num(l.days); }
    else if(l.type==='paid'){ paid+=num(l.amount); }
    else if(l.type==='advance'){ ded+=num(l.amount); }
  });
  var w=S.workers.filter(function(x){return x.id===id;})[0];
  var adj=w?num(w.balanceAdjustment):0;
  return { earned:earned, paid:paid, ded:ded, days:days, adj:adj, balance:earned-paid-ded+adj };
}

function renderWorkers(){
  if(!S.branch) return;
  var date=$('wkDate').value||todayISO();
  $('wkDateLabel').textContent=date;
  var ws=branchWorkers();

  /* attendance grid */
  $('attendanceGrid').innerHTML=ws.length?ws.map(function(w){
    var l=S.ledger.filter(function(x){ return x.workerId===w.id&&x.date===date&&x.type==='work'; })[0];
    var d=l?num(l.days):0;
    var st=workerStats(w.id);
    var btn=function(val,label,cls){
      var on=d===val;
      return '<button type="button" data-att="'+w.id+'" data-days="'+val+'" class="flex-1 text-xs font-bold py-1.5 rounded-lg transition '+(on?cls:'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50')+'">'+label+'</button>';
    };
    return '<div class="border border-slate-200 rounded-xl p-3 bg-white">'+
      '<div class="flex items-start gap-2 mb-2"><div class="h-9 w-9 rounded-full bg-emerald-100 text-emerald-800 grid place-items-center font-bold text-xs">'+esc(w.name.slice(0,2).toUpperCase())+'</div>'+
      '<div class="leading-tight"><p class="font-bold text-sm">'+esc(w.name)+'</p><p class="text-[11px] text-slate-400 uppercase">'+esc(w.role)+' · '+money0(w.dayWage)+'/day</p></div>'+
      '<div class="ml-auto text-right"><p class="text-[10px] uppercase text-slate-400">Day</p><p class="font-bold num text-emerald-700">'+st.days+'</p></div></div>'+
      '<div class="flex gap-1.5">'+btn(1,'Full day','bg-emerald-700 text-white')+btn(0.5,'Half','bg-amber-500 text-emerald-900')+btn(0,'Absent','bg-slate-600 text-white')+'</div>'+
      '<p class="mt-2 text-[11px] text-slate-500">Balance due <span class="font-bold num '+(st.balance>0?'text-rose-600':'text-emerald-700')+'">'+money0(st.balance)+'</span></p>'+
    '</div>';
  }).join(''):'<p class="text-sm text-slate-400 italic col-span-full">No workers yet. An admin can add dressers and cutters for this branch.</p>';

  /* balances */
  var tot={days:0,earned:0,paid:0,ded:0,bal:0}, presentToday=0, earnToday=0;
  $('workerBody').innerHTML=ws.length?ws.map(function(w){
    var s=workerStats(w.id);
    var td=S.ledger.filter(function(x){ return x.workerId===w.id&&x.date===date&&x.type==='work'; })[0];
    if(td&&num(td.days)>0){ presentToday++; earnToday+=num(td.amount); }
    tot.days+=s.days; tot.earned+=s.earned; tot.paid+=s.paid; tot.ded+=s.ded; tot.bal+=s.balance;
    return '<tr class="rowhover"><td class="px-4 py-2.5 font-semibold">'+esc(w.name)+
      (s.adj?' <span title="'+esc(w.balanceNote||'Balance correction')+'" class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">'+(s.adj>0?'+':'')+money0(s.adj)+'</span>':'')+
      '<span class="block text-xs text-slate-400">'+esc(w.phone||'')+'</span></td>'+
      '<td class="px-4 py-2.5"><span class="text-[10px] font-bold uppercase px-2 py-1 rounded bg-slate-100 text-slate-700">'+esc(w.role)+'</span></td>'+
      '<td class="px-4 py-2.5 text-right num">'+money0(w.dayWage)+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold text-emerald-700">'+s.days+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+money0(s.earned)+'</td>'+
      '<td class="px-4 py-2.5 text-right num text-slate-500">'+money0(s.paid)+'</td>'+
      '<td class="px-4 py-2.5 text-right num text-rose-600">'+(s.ded?'−'+money0(s.ded):'—')+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold '+(s.balance>0?'text-rose-600':'text-emerald-700')+'">'+money0(s.balance)+'</td>'+
      '<td class="px-4 py-2.5 text-right"><button data-wact="pay" data-id="'+w.id+'" title="Pay" class="h-8 w-8 rounded-lg text-emerald-700 hover:bg-emerald-100"><i class="fa-solid fa-hand-holding-dollar"></i></button>'+
      (isAdmin()?'<button data-wact="edit" data-id="'+w.id+'" class="h-8 w-8 rounded-lg text-slate-600 hover:bg-slate-100"><i class="fa-solid fa-pen-to-square"></i></button><button data-wact="del" data-id="'+w.id+'" class="h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-100"><i class="fa-solid fa-trash"></i></button>':'')+'</td></tr>';
  }).join(''):'<tr><td colspan="9" class="px-4 py-10 text-center text-slate-400">No workers for this branch.</td></tr>';

  $('workerFoot').innerHTML=ws.length?'<tr><td class="px-4 py-2.5" colspan="3">Totals</td>'+
    '<td class="px-4 py-2.5 text-right num">'+tot.days+'</td><td class="px-4 py-2.5 text-right num">'+money0(tot.earned)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(tot.paid)+'</td><td class="px-4 py-2.5 text-right num">−'+money0(tot.ded)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(tot.bal)+'</td><td></td></tr>':'';

  /* ---- daily labour sheet: present, wage, advance, balance ---- */
  var sheetAdv=0, sheetEarn=0, sheetBal=0;
  $('sheetNote').textContent='for '+date+' · advances are deducted from that day\u2019s profit';
  $('sheetBody').innerHTML=ws.length?ws.map(function(w){
    var st=workerStats(w.id);
    var wk=S.ledger.filter(function(x){ return x.workerId===w.id&&x.date===date&&x.type==='work'; })[0];
    var d=wk?num(wk.days):0;
    var adv=S.ledger.filter(function(x){ return x.workerId===w.id&&x.date===date&&x.type==='advance'; })
      .reduce(function(s,x){ return s+num(x.amount); },0);
    var earned=wk?num(wk.amount):0;
    sheetAdv+=adv; sheetEarn+=earned; sheetBal+=st.balance;
    var chip=d===1?'<span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-emerald-100 text-emerald-800">Full day</span>'
      :d===0.5?'<span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-amber-100 text-amber-800">Half day</span>'
      :'<span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-slate-200 text-slate-600">Absent</span>';
    return '<tr class="rowhover"><td class="px-4 py-2.5 font-semibold">'+esc(w.name)+'</td>'+
      '<td class="px-4 py-2.5"><span class="text-[10px] font-bold uppercase px-2 py-1 rounded bg-slate-100 text-slate-700">'+esc(w.role)+'</span></td>'+
      '<td class="px-4 py-2.5">'+chip+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+money0(w.dayWage)+'</td>'+
      '<td class="px-4 py-2.5 text-right num '+(earned?'text-emerald-700':'text-slate-400')+'">'+money0(earned)+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold '+(adv?'text-rose-600':'text-slate-400')+'">'+(adv?'−'+money0(adv):'—')+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold '+(st.balance>0?'text-rose-600':'text-emerald-700')+'">'+money0(st.balance)+'</td>'+
      '<td class="px-4 py-2.5 text-right whitespace-nowrap">'+
        '<button data-sheet="wage" data-id="'+w.id+'" title="Adjust today’s wage (e.g. Sunday surge rate)" class="h-8 w-8 rounded-lg text-emerald-700 hover:bg-emerald-100"><i class="fa-solid fa-sliders"></i></button>'+
        '<button data-sheet="adv" data-id="'+w.id+'" title="Give an advance" class="h-8 w-8 rounded-lg text-amber-600 hover:bg-amber-100"><i class="fa-solid fa-money-bill-transfer"></i></button>'+
        (isAdmin()?'<button data-sheet="edit" data-id="'+w.id+'" title="Edit worker" class="h-8 w-8 rounded-lg text-slate-600 hover:bg-slate-100"><i class="fa-solid fa-pen-to-square"></i></button>':'')+
      '</td></tr>';
  }).join(''):'<tr><td colspan="8" class="px-4 py-10 text-center text-slate-400">No workers for this branch.</td></tr>';
  $('sheetFoot').innerHTML=ws.length?'<tr><td class="px-4 py-2.5" colspan="4">Totals for '+date+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(sheetEarn)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+(sheetAdv?'−'+money0(sheetAdv):'₹0')+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(sheetBal)+'</td><td></td></tr>':'';

  renderDayWise();

  $('pkCount').textContent=ws.length;
  $('pkToday').textContent=presentToday;
  $('pkEarnToday').textContent=money0(earnToday);
  $('pkPaid').textContent=money0(tot.paid+tot.ded);
  $('pkBalance').textContent=money0(tot.bal);

  /* ledger — itemized transaction log, admin only; keeps its own from/to
     range instead of piggy-backing on this render's single "date" */
  if($('wkWorkerFilter')){
    var curWkFilter=$('wkWorkerFilter').value;
    $('wkWorkerFilter').innerHTML='<option value="">All workers</option>'+
      ws.map(function(w){ return '<option value="'+w.id+'"'+(w.id===curWkFilter?' selected':'')+'>'+esc(w.name)+'</option>'; }).join('');
  }
  renderLedgerLog();
}

/* One row per day, built straight from the ledger records, so the dashboard
   figure can be traced back to the days it came from. */
function renderDayWise(){
  if(!$('dwBody')) return;
  var from=$('dwFrom').value || monthStart();
  var to=$('dwTo').value || todayISO();
  var codes=[S.branch];
  var byDay={};
  S.ledger.forEach(function(l){
    if(codes.indexOf(l.branch)<0) return;
    if(l.date<from || l.date>to) return;
    var d=byDay[l.date] || (byDay[l.date]={ days:0, wages:0, adv:0, other:0, who:[] });
    if(l.type==='work'){ d.days+=num(l.days); d.wages+=num(l.amount); }
    else if(l.type==='advance'){
      d.adv+=num(l.amount);
      var w=S.workers.filter(function(x){return x.id===l.workerId;})[0];
      d.who.push((w?w.name:'—')+' '+money0(l.amount));
    }
    else if((LEDGER_TYPES[l.type]||{}).shop) d.other+=num(l.amount);
  });

  var dates=Object.keys(byDay).sort().reverse();
  var t={ days:0, wages:0, adv:0, other:0 };
  $('dwNote').textContent=dates.length+' day(s) with labour activity';
  $('dwBody').innerHTML=dates.length?dates.map(function(d){
    var r=byDay[d], charged=r.wages+r.other;   /* advances are not a cost */
    t.days+=r.days; t.wages+=r.wages; t.adv+=r.adv; t.other+=r.other;
    return '<tr class="rowhover"><td class="px-4 py-2.5 font-semibold whitespace-nowrap">'+d+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+r.days+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+money0(r.wages)+'</td>'+
      '<td class="px-4 py-2.5 text-right num '+(r.other?'text-amber-700':'text-slate-400')+'">'+(r.other?money0(r.other):'—')+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold text-rose-700">'+money0(charged)+'</td>'+
      '<td class="px-4 py-2.5 text-right num '+(r.adv?'text-slate-600':'text-slate-400')+'">'+(r.adv?money0(r.adv):'—')+'</td>'+
      '<td class="px-4 py-2.5 text-xs text-slate-500">'+esc(r.who.join(', ')||'—')+'</td></tr>';
  }).join(''):'<tr><td colspan="7" class="px-4 py-10 text-center text-slate-400">No labour activity between '+from+' and '+to+'.</td></tr>';

  var grand=t.wages+t.other;   /* what actually hits the P&L */
  $('dwFoot').innerHTML=dates.length?'<tr><td class="px-4 py-2.5">Totals '+from+' → '+to+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+t.days+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(t.wages)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(t.other)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(grand)+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(t.adv)+'</td><td></td></tr>':'';

  $('dwReconcile').textContent=dates.length
    ? 'Charged to profit: '+money0(t.wages)+' wages + '+money0(t.other)+' overheads = '+money0(grand)
      +' for '+(S.branches[S.branch]||S.branch)+'. The '+money0(t.adv)+' of advances is cash paid against '
      +'wages already counted, so it is not deducted again — it only reduces what each worker is still owed.'
    : 'Nothing recorded in this range.';
}

function markAttendance(workerId,days){
  var date=$('wkDate').value||todayISO();
  var w=S.workers.filter(function(x){return x.id===workerId;})[0]; if(!w) return;
  var i=S.ledger.findIndex(function(l){ return l.workerId===workerId&&l.date===date&&l.type==='work'; });
  logAct('Attendance', w.name+' · '+date+' · '+(days===0?'absent':days===0.5?'half day':'full day'));
  if(days===0){ if(i>=0) S.ledger.splice(i,1); }
  else {
    var rec={ id:i>=0?S.ledger[i].id:uid('l'), branch:w.branch, workerId:workerId, date:date, type:'work',
              days:days, amount:num(w.dayWage)*days, note:days===0.5?'Half day':'Full day' };
    if(i>=0) S.ledger[i]=rec; else S.ledger.push(rec);
  }
  DB.write(K.ledger,S.ledger);
  renderWorkers(); recalc(); renderDashboard();
}

function workerModal(w){
  w=w||{};
  openGen(w.id?'Edit worker':'Add worker',
    '<div class="space-y-3">'+
    '<div><label class="lbl" for="wkName">Name</label><input id="wkName" class="inp" value="'+esc(w.name||'')+'" /></div>'+
    '<div class="grid grid-cols-2 gap-3">'+
      '<div><label class="lbl" for="wkRole">Role</label><select id="wkRole" class="inp">'+
        ['dresser','cutter','helper','cashier','driver'].map(function(r){ return '<option value="'+r+'"'+(w.role===r?' selected':'')+'>'+r.charAt(0).toUpperCase()+r.slice(1)+'</option>'; }).join('')+'</select></div>'+
      '<div><label class="lbl" for="wkWage">Wage per day (₹)</label><input type="number" min="0" step="10" id="wkWage" class="inp num" value="'+(w.dayWage||S.settings.dayWage||700)+'" /></div>'+
    '</div>'+
    '<div><label class="lbl" for="wkPhone">Phone (optional)</label><input id="wkPhone" class="inp" value="'+esc(w.phone||'')+'" /></div>'+
    '<button id="wkSave" class="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg mt-2">Save worker</button></div>');
  bind('wkSave',function(){
    var name=tv('wkName'); if(!name){ toast('Enter a name.','error'); return; }
    if(v('wkWage')<=0){ toast('Enter the daily wage.','error'); return; }
    if(w.id) Object.assign(w,{name:name,role:tv('wkRole'),dayWage:v('wkWage'),phone:tv('wkPhone')});
    else S.workers.push({ id:uid('w'), branch:S.branch, name:name, role:tv('wkRole'), dayWage:v('wkWage'), phone:tv('wkPhone'), joinedOn:todayISO(), active:true });
    DB.write(K.workers,S.workers); logAct(w.id?'Edited worker':'Added worker',name+' · '+tv('wkRole')+' · '+money0(v('wkWage'))+'/day');
    closeModal('genModal'); renderWorkers(); toast('Worker saved.');
  });
}

function ledgerModal(kind,preWorker){
  var ws=branchWorkers();
  if(!ws.length){ toast('Add a worker first.','warn'); return; }
  var types=kind==='pay'?['paid','advance']:['tea','tiffin','advance','other'];
  openGen(kind==='pay'?'Record payment':'Log expense',
    '<div class="space-y-3">'+
    '<div class="grid grid-cols-2 gap-3">'+
      '<div><label class="lbl" for="lgWorker">Worker</label><select id="lgWorker" class="inp">'+ws.map(function(x){ return '<option value="'+x.id+'"'+(preWorker===x.id?' selected':'')+'>'+esc(x.name)+'</option>'; }).join('')+'</select></div>'+
      '<div><label class="lbl" for="lgDate">Date</label><input type="date" id="lgDate" class="inp" value="'+($('wkDate').value||todayISO())+'" /></div>'+
    '</div>'+
    '<div class="grid grid-cols-2 gap-3">'+
      '<div><label class="lbl" for="lgType">Type</label><select id="lgType" class="inp">'+types.map(function(t){ return '<option value="'+t+'">'+LEDGER_TYPES[t].t+'</option>'; }).join('')+'</select></div>'+
      '<div><label class="lbl" for="lgAmt">Amount (₹)</label><input type="number" min="0" step="1" id="lgAmt" class="inp num" /></div>'+
    '</div>'+
    '<div><label class="lbl" for="lgNote">Note</label><input id="lgNote" class="inp" placeholder="Optional" /></div>'+
    '<p id="lgHint" class="text-xs rounded-lg px-3 py-2 font-semibold border"></p>'+
    '<button id="lgSave" class="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg">Save</button></div>');
  var upd=function(){
    var t=tv('lgType'), def=LEDGER_TYPES[t];
    var h=$('lgHint');
    if(def.effect==='settle'){ h.className='text-xs rounded-lg px-3 py-2 font-semibold border bg-slate-100 text-slate-700 border-slate-300'; h.textContent='Reduces the worker’s outstanding balance.'; }
    else { h.className='text-xs rounded-lg px-3 py-2 font-semibold border bg-emerald-50 text-emerald-800 border-emerald-200'; h.textContent='Paid by the shop — NOT deducted from the worker’s wages. Counts as a shop expense in the P&L.'; }
  };
  $('lgType').addEventListener('change',upd); upd();
  bind('lgSave',function(){
    if(v('lgAmt')<=0){ toast('Enter an amount.','error'); return; }
    S.ledger.push({ id:uid('l'), branch:S.branch, workerId:tv('lgWorker'), date:tv('lgDate'), type:tv('lgType'), days:0, amount:v('lgAmt'), note:tv('lgNote') });
    DB.write(K.ledger,S.ledger);
    logAct('Ledger '+tv('lgType'), money0(v('lgAmt'))+' · '+(S.workers.filter(function(x){return x.id===tv('lgWorker');})[0]||{name:'?'}).name);
    closeModal('genModal'); renderWorkers(); recalc(); renderDashboard(); toast('Saved.');
  });
}

/* ---------------- fixed overheads (month-level, never daily) ---------------- */
function ovhCatName(v){ var c=OVERHEAD_CATS.filter(function(x){return x.v===v;})[0]; return c?c.t:v; }
function ovhCatIcon(v){ var c=OVERHEAD_CATS.filter(function(x){return x.v===v;})[0]; return c?c.ic:'fa-receipt'; }

function monthsInRange(from,to){
  var out=[], y=+from.slice(0,4), m=+from.slice(5,7), ey=+to.slice(0,4), em=+to.slice(5,7), guard=0;
  while((y<ey||(y===ey&&m<=em)) && guard++<180){ out.push(y+'-'+String(m).padStart(2,'0')); m++; if(m>12){m=1;y++;} }
  return out;
}

/* Overheads charged inside a date range. Monthly costs are counted whole when
   their month is in range; a dated one only counts if that exact day is.
   Same category-filter problem as labourRange() above, and the same fix:
   walk day by day, and when both categories share a day, broiler carries
   the whole day's overhead share and parents carries none. */
function overheadsFor(codes,months,from,to,cat){
  if(!cat || cat==='all'){
    var by={}, total=0, count=0;
    S.overheads.forEach(function(o){
      if(o.status!=='approved') return;
      if(codes.indexOf(o.branch)<0) return;
      if(o.date){
        if(from && to && (o.date<from || o.date>to)) return;
        if(months.indexOf(String(o.date).slice(0,7))<0) return;
      } else if(months.indexOf(o.month)<0) return;
      by[o.category]=(by[o.category]||0)+num(o.amount);
      total+=num(o.amount); count++;
    });
    return { by:by, total:total, count:count };
  }
  var total=0, count=0;
  codes.forEach(function(branch){
    for(var d=from; d<=to; d=addDays(d,1)){
      var sameDay=S.entries.filter(function(e){ return e.branch===branch && dOf(e.datetime)===d; });
      if(!sameDay.some(function(e){ return e.category===cat; })) continue;
      if(cat==='parents' && sameDay.some(function(e){ return e.category==='broiler'; })) continue;
      total+=overheadDayShare(d,branch); count++;
    }
  });
  return { by:{}, total:total, count:count };
}

function visibleOverheads(){
  var mine=myBranches();
  return S.overheads.filter(function(o){
    if(mine.indexOf(o.branch)<0) return false;
    if(!isAdmin() && o.branch!==S.branch) return false;
    return true;
  });
}

function renderOverheads(){
  if(!S.branch) return;
  $('ovhBranchLabel').textContent=isAdmin()?'All my branches':S.branches[S.branch];
  var m=$('ovhMonth').value||todayISO().slice(0,7);
  var list=visibleOverheads().filter(function(o){
    return (o.date ? String(o.date).slice(0,7) : o.month)===m; })
    .sort(function(a,b){ return (a.createdAt<b.createdAt)?1:-1; });

  var app=0,pend=0,rej=0;
  list.forEach(function(o){
    if(o.status==='approved') app+=num(o.amount);
    else if(o.status==='pending') pend+=num(o.amount);
    else if(o.status==='rejected') rej+=num(o.amount);
  });
  $('ovkApproved').textContent=money0(app);
  $('ovkPending').textContent=money0(pend);
  $('ovkRejected').textContent=money0(rej);
  $('ovkCount').textContent=list.length;

  $('ovhBody').innerHTML=list.length?list.map(function(o){
    var canDel=isAdmin()||(o.status!=='approved'&&o.createdBy===S.user.id);
    // A supervisor may only correct their own, still-pending, TODAY-dated
    // overhead — same floor as everything else on this screen. An admin can
    // always amend. A standing monthly cost has no "today" to pin to, so a
    // supervisor never gets an edit button for one.
    var canEdit=isAdmin()||(o.status==='pending'&&o.createdBy===S.user.id&&o.date===todayISO());
    return '<tr class="rowhover"><td class="px-4 py-2.5 whitespace-nowrap font-semibold">'+(o.date
        ? esc(o.date)+'<span class="block text-[10px] font-bold uppercase text-rose-600">that day</span>'
        : esc(o.month)+'<span class="block text-[10px] font-bold uppercase text-slate-400">spread</span>')+'</td>'+
      '<td class="px-4 py-2.5 text-slate-600">'+esc(S.branches[o.branch]||o.branch)+'</td>'+
      '<td class="px-4 py-2.5"><i class="fa-solid '+ovhCatIcon(o.category)+' text-slate-400 mr-1.5"></i>'+esc(ovhCatName(o.category))+'</td>'+
      '<td class="px-4 py-2.5 text-xs text-slate-500">'+esc(o.note||'')+(o.rejectReason?'<span class="block text-rose-600 font-semibold">Returned: '+esc(o.rejectReason)+'</span>':'')+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold">'+money0(o.amount)+'</td>'+
      '<td class="px-4 py-2.5 text-xs text-slate-500">'+esc(userName(o.createdBy))+'</td>'+
      '<td class="px-4 py-2.5">'+statusChip(o.status)+'</td>'+
      '<td class="px-4 py-2.5 text-right whitespace-nowrap">'+
        (isAdmin()&&o.status!=='approved'?'<button data-ovh="ok" data-id="'+o.id+'" title="Approve" class="h-8 w-8 rounded-lg text-emerald-700 hover:bg-emerald-100"><i class="fa-solid fa-circle-check"></i></button>':'')+
        (isAdmin()&&o.status==='pending'?'<button data-ovh="no" data-id="'+o.id+'" title="Return" class="h-8 w-8 rounded-lg text-amber-600 hover:bg-amber-100"><i class="fa-solid fa-circle-xmark"></i></button>':'')+
        (canEdit?'<button data-ovh="edit" data-id="'+o.id+'" title="Edit amount/note" class="h-8 w-8 rounded-lg text-slate-600 hover:bg-slate-100"><i class="fa-solid fa-pen-to-square"></i></button>':'')+
        (canDel?'<button data-ovh="del" data-id="'+o.id+'" title="Delete" class="h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-100"><i class="fa-solid fa-trash"></i></button>':'')+
      '</td></tr>';
  }).join(''):'<tr><td colspan="8" class="px-4 py-10 text-center text-slate-400"><i class="fa-solid fa-file-invoice text-3xl mb-2 block"></i>No overheads recorded for '+m+'.</td></tr>';

  $('ovhFoot').innerHTML=list.length?'<tr><td class="px-4 py-2.5" colspan="4">Approved total for '+m+'</td>'+
    '<td class="px-4 py-2.5 text-right num">'+money0(app)+'</td><td colspan="3"></td></tr>':'';
  updatePendingBadge();
}

function overheadModal(){
  openGen('Add a monthly overhead',
    '<div class="space-y-3">'+
    '<div class="grid grid-cols-2 gap-3">'+
      '<div><label class="lbl" for="ovMonth">Month</label><input type="month" id="ovMonth" class="inp" value="'+($('ovhMonth').value||todayISO().slice(0,7))+'" /></div>'+
      '<div><label class="lbl" for="ovAmt">Amount (₹)</label><input type="number" min="0" step="1" id="ovAmt" class="inp num" /></div>'+
    '</div>'+
    '<div><label class="lbl" for="ovCat">Category</label><select id="ovCat" class="inp">'+
      OVERHEAD_CATS.map(function(c){ return '<option value="'+c.v+'">'+c.t+'</option>'; }).join('')+'</select></div>'+
    '<div><label class="lbl" for="ovNote">Note / bill reference</label><input id="ovNote" class="inp" placeholder="e.g. electricity bill 4412, August" /></div>'+
    '<p class="text-xs rounded-lg px-3 py-2 bg-amber-50 text-amber-800 border border-amber-200 font-semibold">Charged once at month end. It will not change any single day&rsquo;s profit, and needs admin approval to count.</p>'+
    '<button id="ovSave" class="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg">Submit for approval</button></div>');
  bind('ovSave',function(){
    if(v('ovAmt')<=0){ toast('Enter an amount.','error'); return; }
    var rec={ id:uid('o'), branch:S.branch, month:tv('ovMonth')||todayISO().slice(0,7),
      category:tv('ovCat'), amount:v('ovAmt'), note:tv('ovNote'),
      status:isAdmin()?'approved':'pending', createdBy:S.user.id, createdAt:new Date().toISOString(),
      reviewedBy:isAdmin()?S.user.id:null, reviewedAt:isAdmin()?new Date().toISOString():null, rejectReason:'' };
    S.overheads.push(rec); DB.write(K.overheads,S.overheads);
    logAct('Added overhead', ovhCatName(rec.category)+' · '+rec.month+' · '+money0(rec.amount)+(isAdmin()?' (auto-approved)':' (pending)'));
    closeModal('genModal'); $('ovhMonth').value=rec.month; renderOverheads(); renderDashboard();
    toast(isAdmin()?'Overhead recorded.':'Sent to admin for approval.');
  });
}

function decideOverhead(id,verdict,reason){
  S.overheads=DB.read(K.overheads,S.overheads);
  var o=S.overheads.filter(function(x){return x.id===id;})[0]; if(!o) return;
  o.status=verdict; o.reviewedBy=S.user.id; o.reviewedAt=new Date().toISOString();
  o.rejectReason=verdict==='rejected'?(reason||''):'';
  DB.write(K.overheads,S.overheads);
  logAct(verdict==='approved'?'Approved overhead':'Returned overhead', ovhCatName(o.category)+' · '+o.month+' · '+money0(o.amount)+(reason?' — '+reason:''));
  renderOverheads(); renderDashboard();
  toast(verdict==='approved'?'Overhead approved — charged at month end.':'Overhead returned.', verdict==='approved'?'success':'warn');
}

/* ---------------- admin ---------------- */
function nextBranchCode(){ var i=1,c; do{ c='B'+String(i).padStart(2,'0'); i++; }while(S.branches[c]); return c; }
function renderAdmin(){
  $('branchBody').innerHTML=Object.keys(S.branches).map(function(k){
    var n=S.entries.filter(function(e){return e.branch===k;}).length, only=Object.keys(S.branches).length===1;
    return '<tr class="rowhover"><td class="px-5 py-2.5"><span class="font-bold text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-800">'+esc(k)+'</span></td>'+
      '<td class="px-3 py-2.5"><input data-bname="'+esc(k)+'" class="inp" value="'+esc(S.branches[k])+'" /></td>'+
      '<td class="px-3 py-2.5 text-right num text-slate-500">'+n+'</td>'+
      '<td class="px-5 py-2.5 text-right"><button data-bdel="'+esc(k)+'" '+(only?'disabled':'')+' class="h-8 w-8 rounded-lg '+(only?'text-slate-300':'text-rose-600 hover:bg-rose-100')+'"><i class="fa-solid fa-trash"></i></button></td></tr>';
  }).join('');
  $('userBody').innerHTML=S.users.map(function(u){
    return '<tr class="rowhover"><td class="px-5 py-2.5 font-semibold">'+esc(u.name)+'</td><td class="px-3 py-2.5 font-mono text-xs">'+esc(u.username)+'</td>'+
      '<td class="px-3 py-2.5"><span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full '+(u.role==='admin'?'bg-amber-100 text-amber-800':'bg-emerald-100 text-emerald-800')+'">'+u.role+'</span></td>'+
      '<td class="px-3 py-2.5 text-xs text-slate-500">'+(u.role==='admin'?'All':esc((u.branches||[]).join(', ')||'—'))+'</td>'+
      '<td class="px-5 py-2.5 text-right"><button data-uact="pass" data-id="'+u.id+'" title="Reset password" class="h-8 w-8 rounded-lg text-slate-600 hover:bg-slate-100"><i class="fa-solid fa-key"></i></button>'+
      (u.id!==S.user.id?'<button data-uact="del" data-id="'+u.id+'" class="h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-100"><i class="fa-solid fa-trash"></i></button>':'')+'</td></tr>';
  }).join('');
  $('newUserBranches').innerHTML=Object.keys(S.branches).map(function(k){
    return '<label class="inline-flex items-center gap-1.5 text-xs bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 cursor-pointer"><input type="checkbox" value="'+esc(k)+'" class="ubr" /> '+esc(k)+'</label>';
  }).join('');
  renderActivity();
  setV('setWasteBroiler',S.settings.wasteBroiler); setV('setWasteParents',S.settings.wasteParents);
  setV('setTolerance',S.settings.tolerance); setV('setDayWage',S.settings.dayWage);
  try{ var b=0; Object.keys(K).forEach(function(k){ var r=LS.get(K[k]); if(r) b+=r.length; });
    $('storageInfo').textContent='Local storage in use: '+(b/1024).toFixed(0)+' KB'; }catch(e){}
}

/* ---------------- export ---------------- */
function download(blob,name){ var u=URL.createObjectURL(blob),a=document.createElement('a'); a.href=u; a.download=name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function(){URL.revokeObjectURL(u);},1000); }

/* Every "Export" button in the app funnels through here so the download is a
   real .xlsx workbook, not a CSV file wearing an Excel icon. `rows` is a
   plain 2D array (no header row). Falls back to a CSV download if the
   SheetJS library (loaded from a CDN in index.html) didn't load — offline,
   blocked, whatever — so a button never just does nothing. */
function toXlsx(filename, sheetName, headers, rows) {
  filename = filename.replace(/\.(csv|xlsx)$/i, '');
  if (typeof XLSX === 'undefined') { toCsvFallback(filename, headers, rows); return; }
  try {
    var ws = XLSX.utils.aoa_to_sheet([headers].concat(rows));
    ws['!cols'] = headers.map(function (h, i) {
      var w = String(h == null ? '' : h).length;
      for (var r = 0; r < rows.length; r++) {
        var cell = rows[r][i];
        var len = String(cell == null ? '' : cell).length;
        if (len > w) w = len;
      }
      return { wch: Math.min(Math.max(w + 2, 8), 40) };
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Sheet1').slice(0, 31));
    XLSX.writeFile(wb, filename + '.xlsx');
  } catch (e) {
    toCsvFallback(filename, headers, rows);
  }
}
/* Same idea as toXlsx() above but one workbook, several sheets — used for
   the pre-wipe backup, where "Entries", "Purchases", "Hotel sales" etc. each
   need their own tab rather than being squashed into one. `sheets` is
   [{name, headers, rows}, ...]; a sheet with no rows is still written (with
   just its header row) so the workbook always has every tab, even if a
   table happened to be empty. Falls back to one CSV per sheet if SheetJS
   isn't available, same reasoning as toXlsx(). */
function toXlsxMulti(filename, sheets) {
  filename = filename.replace(/\.(csv|xlsx)$/i, '');
  if (typeof XLSX === 'undefined') {
    sheets.forEach(function (s) { toCsvFallback(filename + '_' + s.name, s.headers, s.rows); });
    return;
  }
  try {
    var wb = XLSX.utils.book_new();
    sheets.forEach(function (s) {
      var ws = XLSX.utils.aoa_to_sheet([s.headers].concat(s.rows));
      ws['!cols'] = s.headers.map(function (h, i) {
        var w = String(h == null ? '' : h).length;
        for (var r = 0; r < s.rows.length; r++) {
          var cell = s.rows[r][i];
          var len = String(cell == null ? '' : cell).length;
          if (len > w) w = len;
        }
        return { wch: Math.min(Math.max(w + 2, 8), 40) };
      });
      XLSX.utils.book_append_sheet(wb, ws, (s.name || 'Sheet1').slice(0, 31));
    });
    XLSX.writeFile(wb, filename + '.xlsx');
  } catch (e) {
    sheets.forEach(function (s) { toCsvFallback(filename + '_' + s.name, s.headers, s.rows); });
  }
}
/* Turns the /admin/wipe-backup payload into a multi-sheet Excel workbook and
   triggers the download — called right before the "Delete all data" button's
   final typed confirmation, so there is always a saved copy on the admin's
   own machine before anything is actually removed. Weights come back in
   grams from the API; every sheet here converts to kg to match what an
   admin actually reads on screen elsewhere in the app. */
function downloadWipeBackup(b) {
  var workerName = {}; (S.workers || []).forEach(function (w) { workerName[w.id] = w.name; });
  var customerName = {}; (S.customers || []).forEach(function (c) { customerName[c.id] = c.name; });
  var entries = b.entries || [];

  var entrySheet = { name: 'Entries',
    headers: ['Date', 'Branch', 'Category', 'Status', 'Open birds', 'Open wt (kg)', 'Open meat (kg)',
      'Dressed count', 'Dressed wt (kg)', 'Actual meat (kg)', 'Skin sold (kg)', 'Skinless sold (kg)',
      'Liver sold (kg)', 'Live sold count', 'Live sold wt (kg)', 'Cutting charges', 'Mortality count',
      'Mortality wt (kg)', 'Damage (kg)', 'Close birds', 'Close wt (kg)', 'Close meat (kg)',
      'Rate skin', 'Rate skinless', 'Rate liver', 'Rate live', 'Open rate', 'Photo count',
      'Created by', 'Reviewed by', 'Notes', 'Explanation'],
    rows: entries.map(function (e) {
      return [e.businessDate, e.branch, e.category, e.status,
        e.openBirds, e.openWtG / 1000, e.openMeatG / 1000,
        e.dressedCount, e.dressedWtG / 1000, e.actualMeatG / 1000,
        e.skinSoldG / 1000, e.skinlessSoldG / 1000, e.liverSoldG / 1000,
        e.liveSoldCount, e.liveSoldWtG / 1000, e.cutCharges,
        e.mortCount, e.mortWtG / 1000, e.damageG / 1000,
        e.closeBirds, e.closeWtG / 1000, e.closeMeatG / 1000,
        e.rateSkin, e.rateSkinless, e.rateLiver, e.rateLive, e.openRate, e.photoCount,
        e.createdByName, e.reviewedByName, e.notes, e.explanation];
    }) };

  var purchaseRows = [];
  entries.forEach(function (e) {
    (e.purchases || []).forEach(function (p) {
      purchaseRows.push([e.businessDate, e.branch, e.category, p.supplier, p.batch,
        p.kind, p.birds, p.wtG / 1000, p.rate]);
    });
  });
  var purchaseSheet = { name: 'Purchases',
    headers: ['Date', 'Branch', 'Category', 'Supplier', 'Batch', 'Kind', 'Birds', 'Weight (kg)', 'Rate'],
    rows: purchaseRows };

  var hotelRows = [];
  entries.forEach(function (e) {
    (e.hotelSales || []).forEach(function (h) {
      hotelRows.push([e.businessDate, e.branch, h.customerName, h.customerCode, h.kind, h.product,
        h.weightG / 1000, h.birds, h.marketRate, h.rate, h.amount, h.settled ? 'Yes' : 'No', h.note]);
    });
  });
  var hotelSheet = { name: 'Hotel sales',
    headers: ['Date', 'Branch', 'Customer', 'Code', 'Kind', 'Product', 'Weight (kg)', 'Birds',
      'Market rate', 'Rate charged', 'Amount', 'Settled', 'Note'],
    rows: hotelRows };

  var paymentSheet = { name: 'Receipts',
    headers: ['Date', 'Branch', 'Customer', 'Amount', 'Mode', 'Note'],
    rows: (b.payments || []).map(function (p) {
      return [p.date, p.branch, customerName[p.customerId] || p.customerId, p.amount, p.mode, p.note];
    }) };

  var adjustmentSheet = { name: 'Billing adjustments',
    headers: ['Date', 'Branch', 'Customer', 'Amount', 'Settled', 'Note'],
    rows: (b.adjustments || []).map(function (a) {
      return [a.date, a.branch, a.customerName, a.amount, a.settled ? 'Yes' : 'No', a.note];
    }) };

  var overheadSheet = { name: 'Overheads',
    headers: ['Month', 'Date', 'Branch', 'Category', 'Amount', 'Status', 'Note'],
    rows: (b.overheads || []).map(function (o) {
      return [o.month, o.date, o.branch, o.category, o.amount, o.status, o.note];
    }) };

  var dayCloseSheet = { name: 'Day Close',
    headers: ['Date', 'Branch', 'Cash', 'UPI', 'Declared', 'Expected at declaration',
      'Declared by', 'Verified by', 'Note'],
    rows: (b.dayCloses || []).map(function (c) {
      return [c.date, c.branch, c.cash, c.upi, c.declared, c.expectedAtDeclaration,
        c.declaredByName, c.verifiedByName, c.note];
    }) };

  var ledgerSheet = { name: 'Labour ledger',
    headers: ['Date', 'Branch', 'Worker', 'Type', 'Days', 'Amount', 'Note'],
    rows: (b.labourLedger || []).map(function (l) {
      return [l.date, l.branch, workerName[l.workerId] || l.workerId, l.type, l.days, l.amount, l.note];
    }) };

  toXlsxMulti('VCC_pre_wipe_backup_' + todayISO(),
    [entrySheet, purchaseSheet, hotelSheet, paymentSheet, adjustmentSheet,
     overheadSheet, dayCloseSheet, ledgerSheet]);
}
function toCsvFallback(filename, headers, rows) {
  var csv = [headers].concat(rows).map(function (r) {
    return r.map(function (c) { var s = String(c == null ? '' : c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',');
  }).join('\r\n');
  download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }), filename + '.csv');
}

/* Scrapes a rendered <table> into a plain 2D array — headers from <thead th>,
   rows from <tbody tr><td>, skipping any row whose cell count doesn't match
   the header count (the "No data yet" placeholder rows use a single colspan
   cell, so they're naturally excluded). This is the common data source for
   both Export and Print on any screen that doesn't already have its own
   S.xxx array to read from — what's on screen is exactly what you get in the
   file or on paper. `sel` can be the <table> itself, or any element inside
   it (a <tbody> id is the usual case). A trailing Actions column (blank
   header, or every cell blank because icon-only buttons have no text) is
   dropped so the export isn't left with a pointless empty last column. */
function tableData(sel) {
  var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  var table = el && (el.tagName === 'TABLE' ? el : el.closest('table'));
  if (!table) return { headers: [], rows: [] };
  var headers = [].slice.call(table.querySelectorAll('thead th')).map(function (th) { return th.textContent.trim(); });
  var rows = [].slice.call(table.querySelectorAll('tbody tr')).map(function (tr) {
    return [].slice.call(tr.children).map(function (td) { return td.textContent.trim().replace(/\s+/g, ' '); });
  }).filter(function (r) { return r.length === headers.length; });
  while (headers.length &&
         (headers[headers.length - 1] === '' || /^actions?$/i.test(headers[headers.length - 1])) &&
         rows.every(function (r) { return r[r.length - 1] === ''; })) {
    headers.pop();
    rows.forEach(function (r) { r.pop(); });
  }
  return { headers: headers, rows: rows };
}

/* Print helper shared by every new "Print" button — same #printArea +
   window.print() convention printReport() already established, just
   generalized to take a plain 2D array instead of building its own HTML
   each time. */
function printTable(title, subtitle, headers, rows) {
  var head = '<div style="border-bottom:3px solid #046C4E;padding-bottom:10px;margin-bottom:14px">' +
    '<h1 style="margin:0;font:700 20px sans-serif;color:#046C4E">Venus Chicken Centers</h1>' +
    '<p style="margin:3px 0 0;font:400 11px sans-serif;color:#475569">' + esc(title) +
    (subtitle ? ' · ' + esc(subtitle) : '') + ' · generated ' + new Date().toLocaleString() + '</p></div>';
  var thead = '<thead><tr style="background:#046C4E;color:#fff">' +
    headers.map(function (h) { return '<th style="padding:5px;text-align:left;border:1px solid #046C4E">' + esc(h) + '</th>'; }).join('') +
    '</tr></thead>';
  var tbody = '<tbody>' + (rows.length ? rows.map(function (r) {
    return '<tr>' + r.map(function (c) { return '<td style="padding:4px;border:1px solid #cbd5e1">' + esc(String(c == null ? '' : c)) + '</td>'; }).join('') + '</tr>';
  }).join('') : '<tr><td colspan="' + Math.max(headers.length, 1) + '" style="padding:10px;text-align:center;color:#94a3b8">No rows in this view.</td></tr>') + '</tbody>';
  $('printArea').innerHTML = head + '<table style="width:100%;border-collapse:collapse;font:400 10px sans-serif">' + thead + tbody + '</table>';
  window.print();
}

function exportCsv(){
  var list=filteredEntries(); if(!list.length){ toast('Nothing to export.','warn'); return; }
  var kg=function(g){ return (num(g)/1000).toFixed(3); };
  var COST=['Opening Rate','Purchase Amount','Avg Cost Rate','Mortality Value','Damage Value',
            'Stock Cost','Labour','Other Exp','Net Profit','Closing Value'];
  var head=['Date','Time','Branch','Category','Opening Birds','Opening Wt','Opening Rate','Open Meat','Purchase Birds','Purchase Wt','Purchase Amount',
    'Avg Cost Rate','Skin Rate','Skinless Rate','Liver Rate','Live Rate','Live Sold Nos','Live Sold Wt','Live Amount','Cutting',
    'Mortality Nos','Mortality Wt','Mortality Value','Photos','Damage Meat','Damage Value','Dressed Birds','Dressed Live Wt',
    'Expected Meat','Waste %','Waste Meat','Actual Meat','Yield %','Bonus Meat','Short Meat','Skin Sold','Skinless Sold','Liver Sold',
    'Counter Sales','Hotel Wt','Hotel Sales','Hotel Paid','Hotel On Account','Concession Given',
    'Revenue','Stock Cost','Labour','Other Exp','Net Profit','Closing Birds','Closing Wt','Closing Meat','Closing Value',
    'Status','Entered By','Reviewed By','Reject Reason','Explanation','Remarks'];
  var drop=isAdmin()?[]:head.map(function(x,i){ return COST.indexOf(x)>=0?i:-1; }).filter(function(i){ return i>=0; });
  var keep=function(arr){ return arr.filter(function(_,i){ return drop.indexOf(i)<0; }); };
  var rows=list.map(function(e){ var c=calc(e); return [
    dOf(e.datetime), String(e.datetime||'').slice(11,16), S.branches[e.branch]||e.branch, e.category,
    num(e.openBirds), kg(e.openWtG), num(e.openRate), kg(e.openMeatG), c.buyBirds, kg(c.buyWtG), c.buyAmt.toFixed(2),
    c.avgRate.toFixed(2), num(e.rateSkin), num(e.rateSkinless), num(e.rateLiver), num(e.rateLive),
    num(e.liveSoldCount), kg(e.liveSoldWtG), c.liveAmt.toFixed(2), num(e.cutCharges),
    num(e.mortCount), kg(e.mortWtG), c.mortValue.toFixed(2), (e.photos||[]).length, kg(e.damageG), c.damageValue.toFixed(2),
    num(e.dressedCount), kg(e.dressedWtG), kg(c.expectedMeatG), c.wastePct, kg(c.wasteMeatG), kg(e.actualMeatG),
    c.yieldPct.toFixed(2), kg(c.bonusG), kg(c.shortG), kg(e.skinSoldG), kg(e.skinlessSoldG), kg(e.liverSoldG),
    c.counterSaleAmt.toFixed(2), kg(c.hotelTotalG), c.hotelAmt.toFixed(2),
    c.hotelCash.toFixed(2), c.hotelCredit.toFixed(2), c.hotelConcession.toFixed(2),
    c.revenue.toFixed(2), c.cogs.toFixed(2), c.labour.toFixed(2), c.otherExp.toFixed(2), c.netProfit.toFixed(2),
    num(e.closeBirds), kg(e.closeWtG), kg(e.closeMeatG), c.closeValue.toFixed(2),
    e.status, userName(e.createdBy), e.reviewedBy?userName(e.reviewedBy):'', e.rejectReason||'', e.explanation||'', e.notes||''
  ];});
  toXlsx('VCC_entries_'+todayISO(), 'Entries', keep(head), rows.map(keep));
  logAct('Exported Excel',list.length+' record(s)'+(isAdmin()?'':' (cost columns excluded)'));
  toast('Exported '+list.length+' record(s).');
}
/* kept as the name bound to btnRecExport — it exports .xlsx now, not CSV;
   see toXlsx() above. */

function printReport(){
  var list=filteredEntries(), agg=aggregate(list.filter(function(e){return e.status==='approved';}));
  var head='<div style="border-bottom:3px solid #046C4E;padding-bottom:10px;margin-bottom:14px">'+
    '<h1 style="margin:0;font:700 20px sans-serif;color:#046C4E">Venus Chicken Centers</h1>'+
    '<p style="margin:3px 0 0;font:400 11px sans-serif;color:#475569">Profit &amp; Loss Report · generated '+new Date().toLocaleString()+'</p></div>';
  var sum=!isAdmin()?'':'<table style="width:100%;border-collapse:collapse;margin-bottom:16px;font:400 11px sans-serif"><tr>'+
    [['Revenue',money0(agg.revenue)],['Stock cost',money0(agg.cogs)],['Labour',money0(agg.labour)],
     ['Other',money0(agg.other)],['Net P/L',money0(agg.net)],['Margin',pct(agg.margin)]]
    .map(function(x){ return '<td style="border:1px solid #cbd5e1;padding:7px"><b>'+x[0]+'</b><br>'+x[1]+'</td>'; }).join('')+'</tr></table>';
  var th=['Date','Branch','Cat','Purchased','Meat','Yield','Revenue'].concat(isAdmin()?['Cost','Labour','Net P/L']:[]).concat(['Status']);
  var rows=list.map(function(e){ var c=calc(e); return '<tr>'+
    '<td>'+dOf(e.datetime)+'</td><td>'+esc(S.branches[e.branch]||e.branch)+'</td><td>'+e.category+'</td>'+
    '<td style="text-align:right">'+c.buyBirds+'</td><td style="text-align:right">'+fmtW(e.actualMeatG)+'</td>'+
    '<td style="text-align:right">'+pct(c.yieldPct)+'</td><td style="text-align:right">'+money0(c.revenue)+'</td>'+
    (isAdmin()?'<td style="text-align:right">'+money0(c.cogs)+'</td><td style="text-align:right">'+money0(c.labour)+'</td>'+
    '<td style="text-align:right">'+money0(c.netProfit)+'</td>':'')+'<td>'+e.status+'</td></tr>'; }).join('');
  $('printArea').innerHTML=head+sum+'<table style="width:100%;border-collapse:collapse;font:400 10px sans-serif">'+
    '<thead><tr style="background:#046C4E;color:#fff">'+th.map(function(h){ return '<th style="padding:5px;text-align:left;border:1px solid #046C4E">'+h+'</th>'; }).join('')+'</tr></thead><tbody>'+rows+'</tbody></table>'+
    '<div style="margin-top:34px;font:400 10px sans-serif;display:flex;gap:50px">'+
    '<div style="border-top:1px solid #475569;padding-top:5px;width:180px">Supervisor</div>'+
    '<div style="border-top:1px solid #475569;padding-top:5px;width:180px">Admin approval</div></div>';
  window.print();
}

/* ---------------- modals / views ---------------- */
function openGen(t,h){ $('genTitle').textContent=t; $('genBody').innerHTML=h; $('genModal').classList.remove('hidden'); }
function closeModal(id){ $(id).classList.add('hidden'); }

function showView(name){
  if(name==='dashboard' && !isAdmin()) name='entry';   /* supervisors have no dashboard */
  if(name==='dayclose' && !isAdmin()) name='entry';    /* nor any view onto Day Close */
  if(name==='purchases' && !isAdmin()) name='entry';   /* nor the supplier purchase ledger */
  if(name==='feedledger' && !isAdmin()) name='entry';  /* nor the feed purchase ledger */
  runChicken();
  qsa('.view').forEach(function(p){ p.classList.add('hidden'); p.classList.remove('view-enter'); });
  var el=$('view-'+name); el.classList.remove('hidden'); void el.offsetWidth; el.classList.add('view-enter');
  qsa('#mainNav .tab-btn').forEach(function(b){ b.classList.toggle('active',b.getAttribute('data-view')===name); });
  if(name==='dashboard') renderDashboard();
  if(name==='records') renderRecords();
  if(name==='customers') renderCustomers();
  if(name==='workers') renderWorkers();
  if(name==='dayclose') renderDayClose();
  if(name==='overheads'){ renderOverheads(); renderOverheadLedger(); }
  if(name==='purchases') renderPurchaseLedger();
  if(name==='feedledger') renderFeedLedger();
  if(name==='admin') renderAdmin();
  window.scrollTo({top:0,behavior:'smooth'});
  // Remembered so a reload comes back to the same screen instead of always
  // resetting to the Dashboard — see startApp(). Stored after the
  // role-based redirects above, so it's always the screen actually shown,
  // never one a supervisor got bounced away from.
  LS.set(K.lastView,name);
}
function syncSegs(){
  qsa('#entryCatSeg button').forEach(function(b){ b.classList.toggle('active',b.getAttribute('data-cat')===S.cat); });
  qsa('#dashCatSeg button').forEach(function(b){ b.classList.toggle('active',b.getAttribute('data-cat')===S.dashCat); });
  qsa('#dashScopeSeg button').forEach(function(b){ b.classList.toggle('active',b.getAttribute('data-scope')===S.dashScope); });
}

/* ---------------- demo data ---------------- */
function seedDemo(){
  var sup=S.users.filter(function(u){return u.role==='supervisor';})[0]||S.users[0];
  var adm=S.users.filter(function(u){return u.role==='admin';})[0];
  var out=[], led=[], wk=[];
  var names=[['Suresh','dresser'],['Mahesh','dresser'],['Anil','cutter'],['Vikram','cutter']];
  Object.keys(S.branches).forEach(function(br){
    names.forEach(function(nm){ wk.push({ id:uid('w'), branch:br, name:nm[0]+' ('+br+')', role:nm[1], dayWage:nm[1]==='dresser'?650:600, phone:'', joinedOn:addDays(todayISO(),-30), active:true }); });
  });
  wk.forEach(function(w){
    for(var i=13;i>=0;i--){
      if(Math.random()<0.12) continue;
      var d=addDays(todayISO(),-i), days=Math.random()<0.1?0.5:1;
      led.push({ id:uid('l'), branch:w.branch, workerId:w.id, date:d, type:'work', days:days, amount:w.dayWage*days, note:days===0.5?'Half day':'Full day' });
      if(i%7===0) led.push({ id:uid('l'), branch:w.branch, workerId:w.id, date:d, type:'paid', days:0, amount:w.dayWage*5, note:'Weekly settlement' });
      if(i%3===0) led.push({ id:uid('l'), branch:w.branch, workerId:w.id, date:d, type:'tea', days:0, amount:30, note:'Morning tea' });
    }
  });

  Object.keys(S.branches).forEach(function(br){
    ['broiler','parents'].forEach(function(cat){
      var openB=80, avg=cat==='parents'?2600:2050, openW=openB*avg, openM=Math.round(Math.random()*6000), openRate=cat==='parents'?135:120;
      for(var i=13;i>=0;i--){
        var d=addDays(todayISO(),-i);
        var buyB=Math.round(180+Math.random()*140);
        var buyW=Math.round(buyB*avg*(0.96+Math.random()*0.08));
        var buyRate=+(openRate*(0.97+Math.random()*0.09)).toFixed(2);
        var purchases=[{ supplier:['Sunrise Poultry','Green Valley','Deccan Agro'][Math.floor(Math.random()*3)], birds:buyB, wtG:buyW, rate:buyRate }];
        var availW=openW+buyW, availV=openW/1000*openRate+buyW/1000*buyRate;
        var avgRate=availV/(availW/1000);
        var mortC=Math.round(Math.random()*4), mortW=mortC*avg;
        var liveC=Math.round((openB+buyB)*(0.16+Math.random()*0.1)), liveW=Math.round(liveC*avg);
        var drC=Math.round((openB+buyB-liveC-mortC)*(0.55+Math.random()*0.25)), drW=Math.round(drC*avg);
        var waste=cat==='parents'?21:31, yf=(100-waste)/100;
        var y=yf+(Math.random()-0.45)*0.05; if(Math.random()<0.15) y-=0.045;
        var meat=Math.round(drW*y);
        var closeB=openB+buyB-liveC-mortC-drC;
        var sellMul=1.55+Math.random()*0.25;
        var rSkin=+(avgRate*sellMul).toFixed(0), rSkinless=rSkin+35, rLive=+(avgRate*1.16).toFixed(0);
        var skin=Math.round((openM+meat)*(0.42+Math.random()*0.2));
        var skinless=Math.round((openM+meat-skin)*(0.55+Math.random()*0.3));
        var dmg=Math.round(Math.random()*900);
        var closeM=Math.max(openM+meat-skin-skinless-dmg,0);
        var st=i>1?'approved':(i===1?'pending':'draft');
        out.push({ id:uid('e'), branch:br, category:cat, datetime:d+'T19:30',
          openBirds:openB, openWtG:openW, openRate:+openRate.toFixed(2), openMeatG:openM, purchases:purchases,
          rateSkin:rSkin, rateSkinless:rSkinless, rateLiver:130, rateLive:rLive,
          liveSoldCount:liveC, liveSoldWtG:liveW, cutCharges:Math.round(liveC*8),
          mortCount:mortC, mortWtG:mortW, damageG:dmg, photos:[],
          dressedCount:drC, dressedWtG:drW, actualMeatG:meat,
          skinSoldG:skin, skinlessSoldG:skinless, liverSoldG:Math.round(drC*35),
          closeBirds:closeB, closeWtG:closeB*avg, closeMeatG:closeM, notes:'',
          status:st, createdBy:sup.id, createdAt:d+'T19:30',
          reviewedBy: st==='approved'?adm.id:null, reviewedAt: st==='approved'?d+'T20:00':null });
        openB=closeB; openW=closeB*avg; openM=closeM; openRate=avgRate;
      }
    });
  });
  S.entries=out; S.workers=wk; S.ledger=led;
  DB.write(K.entries,S.entries); DB.write(K.workers,S.workers); DB.write(K.ledger,S.ledger);
}

/* ---------------- boot ---------------- */
function loadAll(){
  S.users=DB.read(K.users,null)||DEFAULT_USERS.slice();
  S.branches=DB.read(K.branches,null)||JSON.parse(JSON.stringify(DEFAULT_BRANCHES));
  S.entries=DB.read(K.entries,[]);
  S.workers=DB.read(K.workers,[]);
  S.ledger=DB.read(K.ledger,[]);
  S.overheads=DB.read(K.overheads,[]);
  S.activity=DB.read(K.activity,[]);
  S.settings=Object.assign({},DEFAULT_SETTINGS,DB.read(K.settings,{}));
  DB.write(K.users,S.users); DB.write(K.branches,S.branches); DB.write(K.settings,S.settings);
}

function startApp(user,fresh){
  S.user=user;
  logAct(fresh?'Sign in':'Session resumed', user.role+' · idle limit '+(IDLE_MS[user.role]/60000)+' min');
  $('loginScreen').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  applyRbac(); refreshBranchSelects();
  $('dashFrom').value=monthStart(); $('dashTo').value=todayISO();
  $('recFrom').value=addDays(todayISO(),-30); $('recTo').value=todayISO();
  $('wkDate').value=todayISO(); $('wkMonth').value=todayISO().slice(0,7);
  $('dwFrom').value=monthStart(); $('dwTo').value=todayISO();
  $('ovhMonth').value=todayISO().slice(0,7);
  if(isAdmin()) $('recStatus').value='pending';
  bumpActivity(); tickSession();
  syncSegs(); loadEntry(null); updatePendingBadge(); showView(isAdmin()?'dashboard':'entry');
}

function clock(){ var d=new Date();
  $('liveClock').textContent=d.toLocaleDateString(undefined,{weekday:'short',day:'2-digit',month:'short'})+' · '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function net(){ var on=navigator.onLine;
  $('netPill').className='flex items-center gap-2 text-xs font-semibold rounded-full px-3 py-2 border '+(on?'bg-emerald-500/20 text-emerald-100 border-emerald-400/40':'bg-amber-500/25 text-amber-100 border-amber-400/50');
  $('netDot').className='h-2 w-2 rounded-full pulse-dot '+(on?'bg-emerald-300':'bg-amber-400');
  $('netText').textContent=on?'Online':'Offline — Sync Pending'; }

function wire(){
  $('loginForm').addEventListener('submit',function(ev){
    ev.preventDefault();
    var u=S.users.filter(function(x){ return x.username.toLowerCase()===tv('loginUser').toLowerCase()&&x.password===tv('loginPass')&&x.active!==false; })[0];
    if(!u){ $('loginError').textContent='Invalid username or password.'; $('loginError').classList.remove('hidden');
      logAct('Failed sign in','username: '+tv('loginUser')); return; }
    $('loginError').classList.add('hidden'); DB.write(K.session,{id:u.id,at:Date.now()});
    LS.del(K.logoutReason); runChicken(); startApp(u,true);
  });
  $('btnLogout').addEventListener('click',function(){ if(confirm('Sign out?')){ logAct('Sign out','manual'); LS.del(K.session); location.reload(); } });
  $('btnStayIn').addEventListener('click',function(){ bumpActivity(); $('idleModal').classList.add('hidden'); });
  ['mousemove','mousedown','keydown','touchstart','scroll','click'].forEach(function(ev){
    document.addEventListener(ev,function(){ if(Date.now()-S.lastAct>1500) bumpActivity(); },{passive:true});
  });
  // Closing birds/weight/meat are always server-computed and the inputs are
  // readonly — no manual-entry toggle any more.
  $('actUser').addEventListener('change',renderActivity);
  $('actKind').addEventListener('change',renderActivity);
  $('btnActClear').addEventListener('click',function(){
    if(!confirm('Clear the entire activity log?')) return;
    S.activity=[]; DB.write(K.activity,[]); logAct('Cleared activity log',''); renderActivity(); toast('Activity log cleared.','warn');
  });
  $('btnActExport').addEventListener('click',function(){
    var rows=[['When','User','Role','Branch','Action','Detail']].concat(S.activity.map(function(a){
      return [a.at,a.userName,a.role,a.branch,a.action,a.detail]; }));
    var csv=rows.map(function(r){ return r.map(function(c){ var s=String(c==null?'':c); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }).join(','); }).join('\r\n');
    download(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'}),'VCC_activity_'+todayISO()+'.csv');
  });
  qsa('#mainNav .tab-btn').forEach(function(b){ b.addEventListener('click',function(){ showView(b.getAttribute('data-view')); }); });

  $('branchSelect').addEventListener('change',function(){
    S.branch=this.value; refreshBranchSelects(); runChicken();
    loadEntry(null); renderDashboard(); renderRecords(); renderWorkers();
  });
  qsa('#entryCatSeg button').forEach(function(b){ b.addEventListener('click',function(){ S.cat=b.getAttribute('data-cat'); syncSegs(); loadEntry(null); }); });
  qsa('#dashCatSeg button').forEach(function(b){ b.addEventListener('click',function(){ S.dashCat=b.getAttribute('data-cat'); syncSegs(); renderDashboard(); }); });
  qsa('#dashScopeSeg button').forEach(function(b){ b.addEventListener('click',function(){ S.dashScope=b.getAttribute('data-scope'); syncSegs(); renderDashboard(); }); });
  qsa('.qr').forEach(function(b){ b.addEventListener('click',function(){
    var r=b.getAttribute('data-range');
    if(r==='today'){ $('dashFrom').value=todayISO(); $('dashTo').value=todayISO(); }
    else if(r==='7'){ $('dashFrom').value=addDays(todayISO(),-6); $('dashTo').value=todayISO(); }
    else { $('dashFrom').value=monthStart(); $('dashTo').value=todayISO(); }
    renderDashboard();
  }); });
  ['dashFrom','dashTo'].forEach(function(id){ $(id).addEventListener('change',renderDashboard); });

  /* entry */
  $('entryForm').addEventListener('input',recalc);
  $('entryForm').addEventListener('submit',function(ev){ ev.preventDefault(); });
  $('btnAddPurchase').addEventListener('click',function(){
    S.purchases.push({ supplier:'', birds:0, wtG:0, rate:0 }); renderPurchases(); recalc();
  });
  $('purchaseRows').addEventListener('input',function(ev){
    var el=ev.target.closest('[data-p]'); if(!el) return;
    var i=+el.getAttribute('data-i'), f=el.getAttribute('data-p'), p=S.purchases[i]; if(!p) return;
    if(f==='supplier') p.supplier=el.value;
    else if(f==='birds') p.birds=num(el.value);
    else if(f==='rate') p.rate=num(el.value);
    else { var kgEl=$('purchaseRows').querySelector('[data-p="kg"][data-i="'+i+'"]'), gEl=$('purchaseRows').querySelector('[data-p="g"][data-i="'+i+'"]');
      p.wtG=num(kgEl&&kgEl.value)*1000+num(gEl&&gEl.value); }
    recalc();
  });
  $('purchaseRows').addEventListener('click',function(ev){
    var b=ev.target.closest('[data-prm]'); if(!b) return;
    S.purchases.splice(+b.getAttribute('data-prm'),1); renderPurchases(); recalc();
  });

  $('f_photos').addEventListener('change',function(){
    var files=Array.prototype.slice.call(this.files||[]), left=files.length; if(!left) return;
    files.forEach(function(f){ compress(f,function(u){ S.photos.push(u); if(--left===0){ renderPhotos(); recalc(); toast(files.length+' photo(s) attached.'); } }); });
    this.value='';
  });
  $('photoStrip').addEventListener('click',function(ev){
    var rm=ev.target.closest('[data-rm]');
    if(rm){ S.photos.splice(+rm.getAttribute('data-rm'),1); renderPhotos(); recalc(); return; }
    var vw=ev.target.closest('[data-view]');
    if(vw){ $('lightboxImg').src=S.photos[+vw.getAttribute('data-view')]; $('lightbox').classList.remove('hidden'); }
  });

  /* records */
  ['recFrom','recTo','recBranch','recCat','recStatus'].forEach(function(id){ $(id).addEventListener('change',renderRecords); });
  $('btnRecExport').addEventListener('click',exportCsv);
  $('btnRecPrint').addEventListener('click',printReport);
  $('recBody').addEventListener('click',function(ev){
    var b=ev.target.closest('button[data-act]'); if(!b) return;
    var id=b.getAttribute('data-id'), act=b.getAttribute('data-act');
    if(act==='review') openReview(id);
    else if(act==='edit'){ showView('entry'); loadEntry(id); }
    else if(act==='del'&&confirm('Delete this entry permanently?')){
      S.entries=S.entries.filter(function(x){return x.id!==id;}); DB.write(K.entries,S.entries);
      logAct('Deleted entry','id '+id);
      renderRecords(); renderDashboard(); updatePendingBadge(); toast('Entry deleted.','warn'); }
  });
  $('reviewBody').addEventListener('click',function(ev){
    var im=ev.target.closest('img[data-view]'); if(!im) return;
    $('lightboxImg').src=im.src; $('lightbox').classList.remove('hidden');
  });

  /* labour */
  $('wkDate').addEventListener('change',renderWorkers);
  $('wkMonth').addEventListener('change',renderWorkers);
  $('btnAddWorker').addEventListener('click',function(){ workerModal(null); });
  $('btnPayWorker').addEventListener('click',function(){ ledgerModal('pay'); });
  $('btnAddExpense').addEventListener('click',function(){ ledgerModal('exp'); });
  $('attendanceGrid').addEventListener('click',function(ev){
    var b=ev.target.closest('[data-att]'); if(!b) return;
    markAttendance(b.getAttribute('data-att'),parseFloat(b.getAttribute('data-days')));
  });
  $('workerBody').addEventListener('click',function(ev){
    var b=ev.target.closest('button[data-wact]'); if(!b) return;
    var id=b.getAttribute('data-id'), act=b.getAttribute('data-wact');
    var w=S.workers.filter(function(x){return x.id===id;})[0];
    if(act==='pay') ledgerModal('pay',id);
    else if(act==='edit') workerModal(w);
    else if(confirm('Remove '+w.name+'? Their ledger history stays.')){
      S.workers=S.workers.filter(function(x){return x.id!==id;}); DB.write(K.workers,S.workers); renderWorkers(); toast('Worker removed.','warn'); }
  });
  $('ledgerBody').addEventListener('click',function(ev){
    var b=ev.target.closest('button[data-lact]'); if(!b) return;
    S.ledger=S.ledger.filter(function(x){ return x.id!==b.getAttribute('data-id'); });
    DB.write(K.ledger,S.ledger); renderWorkers(); recalc(); renderDashboard(); toast('Ledger entry removed.','warn');
  });

  /* overheads */
  $('ovhMonth').addEventListener('change',renderOverheads);
  $('btnAddOverhead').addEventListener('click',overheadModal);
  $('ovhBody').addEventListener('click',function(ev){
    var b=ev.target.closest('button[data-ovh]'); if(!b) return;
    var id=b.getAttribute('data-id'), act=b.getAttribute('data-ovh');
    if(act==='ok') decideOverhead(id,'approved');
    else if(act==='no'){
      openGen('Return overhead',
        '<label class="lbl" for="ovhReason">Reason</label>'+
        '<textarea id="ovhReason" rows="3" class="inp" placeholder="e.g. attach the bill copy"></textarea>'+
        '<div class="flex gap-3 mt-4"><button id="ovhRejGo" class="bg-rose-600 hover:bg-rose-700 text-white font-bold text-sm px-5 py-2.5 rounded-lg">Return</button>'+
        '<button data-close="1" class="border border-slate-300 text-slate-600 font-bold text-sm px-5 py-2.5 rounded-lg">Cancel</button></div>');
      bind('ovhRejGo',function(){
        var rr=tv('ovhReason'); if(!rr){ toast('Give a reason.','error'); return; }
        closeModal('genModal'); decideOverhead(id,'rejected',rr);
      });
    }
    else if(act==='del'&&confirm('Delete this overhead entry?')){
      var gone=S.overheads.filter(function(x){return x.id===id;})[0];
      S.overheads=S.overheads.filter(function(x){return x.id!==id;});
      DB.write(K.overheads,S.overheads);
      logAct('Deleted overhead', gone?ovhCatName(gone.category)+' · '+gone.month+' · '+money0(gone.amount):id);
      renderOverheads(); renderDashboard(); toast('Overhead deleted.','warn');
    }
  });

  /* admin */
  $('btnAddBranch').addEventListener('click',function(){ $('branchAddForm').classList.toggle('hidden'); });
  $('branchAddForm').addEventListener('submit',function(ev){
    ev.preventDefault();
    var name=tv('newBranchName'); if(!name){ toast('Enter a branch name.','error'); return; }
    var code=tv('newBranchCode').toUpperCase().replace(/[^A-Z0-9_-]/g,'')||nextBranchCode();
    if(S.branches[code]){ toast('Code "'+code+'" already exists.','error'); return; }
    S.branches[code]=name; DB.write(K.branches,S.branches);
    if(S.user.branches) { S.user.branches.push(code); DB.write(K.users,S.users); }
    setV('newBranchName',''); setV('newBranchCode','');
    logAct('Created branch',code+' — '+name);
    renderAdmin(); refreshBranchSelects(); toast('Branch "'+name+'" created.');
  });
  $('branchBody').addEventListener('input',function(ev){
    var i=ev.target.closest('input[data-bname]'); if(!i||!i.value.trim()) return;
    S.branches[i.getAttribute('data-bname')]=i.value.trim(); DB.write(K.branches,S.branches); refreshBranchSelects();
  });
  $('branchBody').addEventListener('click',function(ev){
    var b=ev.target.closest('button[data-bdel]'); if(!b||b.disabled) return;
    var c=b.getAttribute('data-bdel'), n=S.entries.filter(function(e){return e.branch===c;}).length;
    if(!confirm('Delete "'+S.branches[c]+'"?'+(n?'\n\n'+n+' record(s) will also be deleted.':''))) return;
    delete S.branches[c];
    S.entries=S.entries.filter(function(e){return e.branch!==c;});
    S.workers=S.workers.filter(function(w){return w.branch!==c;});
    S.ledger=S.ledger.filter(function(l){return l.branch!==c;});
    S.overheads=S.overheads.filter(function(o){return o.branch!==c;});
    S.users.forEach(function(u){ if(u.branches) u.branches=u.branches.filter(function(x){return x!==c;}); });
    DB.write(K.branches,S.branches); DB.write(K.entries,S.entries); DB.write(K.workers,S.workers);
    DB.write(K.ledger,S.ledger); DB.write(K.overheads,S.overheads); DB.write(K.users,S.users);
    logAct('Deleted branch',c+' with '+n+' record(s)');
    renderAdmin(); refreshBranchSelects(); renderRecords(); renderDashboard(); toast('Branch deleted.','warn');
  });
  $('btnAddUser').addEventListener('click',function(){ $('userAddForm').classList.toggle('hidden'); });
  $('userAddForm').addEventListener('submit',function(ev){
    ev.preventDefault();
    var name=tv('newUserName'), lg=tv('newUserLogin'), pw=tv('newUserPass'), role=tv('newUserRole');
    if(!name||!lg||!pw){ toast('Fill name, username and password.','error'); return; }
    if(S.users.some(function(u){return u.username.toLowerCase()===lg.toLowerCase();})){ toast('Username taken.','error'); return; }
    var brs=qsa('#newUserBranches .ubr').filter(function(c){return c.checked;}).map(function(c){return c.value;});
    if(role==='supervisor'&&!brs.length){ toast('Assign at least one branch.','error'); return; }
    S.users.push({ id:uid('u'), name:name, username:lg, password:pw, role:role, branches: role==='admin'?Object.keys(S.branches):brs, active:true });
    DB.write(K.users,S.users); setV('newUserName',''); setV('newUserLogin',''); setV('newUserPass','');
    logAct('Created user',lg+' ('+role+')');
    renderAdmin(); toast('Account created.');
  });
  $('userBody').addEventListener('click',function(ev){
    var b=ev.target.closest('button[data-uact]'); if(!b) return;
    var id=b.getAttribute('data-id'), u=S.users.filter(function(x){return x.id===id;})[0];
    if(b.getAttribute('data-uact')==='pass'){ var p=prompt('New password for '+u.name+':'); if(p){ u.password=p; DB.write(K.users,S.users); toast('Password updated.'); } }
    else if(confirm('Delete account "'+u.username+'"?')){ S.users=S.users.filter(function(x){return x.id!==id;}); DB.write(K.users,S.users); renderAdmin(); toast('Account deleted.','warn'); }
  });
  $('btnSaveSettings').addEventListener('click',function(){
    S.settings={ wasteBroiler:v('setWasteBroiler'), wasteParents:v('setWasteParents'), tolerance:v('setTolerance'), dayWage:v('setDayWage') };
    DB.write(K.settings,S.settings); logAct('Changed settings',JSON.stringify(S.settings));
    recalc(); renderDashboard(); renderRecords(); toast('Settings saved.');
  });
  $('btnExportAll').addEventListener('click',function(){
    var d={}; Object.keys(K).forEach(function(k){ d[k]=DB.read(K[k],null); });
    download(new Blob([JSON.stringify(d,null,2)],{type:'application/json'}),'VCC_backup_'+todayISO()+'.json'); toast('Backup downloaded.');
  });
  $('importFile').addEventListener('change',function(){
    var f=this.files[0]; if(!f) return; var fr=new FileReader();
    fr.onload=function(){ try{ var d=JSON.parse(fr.result);
      Object.keys(K).forEach(function(k){ if(d[k]!==undefined&&d[k]!==null) DB.write(K[k],d[k]); });
      toast('Import complete — reloading.'); setTimeout(function(){location.reload();},900);
    }catch(err){ toast('Not a valid backup file.','error'); } };
    fr.readAsText(f); this.value='';
  });
  $('btnSeed').addEventListener('click',function(){
    if(confirm('Replace all entries, workers and ledger with a 14-day demo dataset?')){
      seedDemo(); logAct('Loaded demo data',''); renderAdmin(); renderActivity(); renderRecords(); renderDashboard(); renderWorkers(); updatePendingBadge(); loadEntry(null); toast('Demo data loaded.'); }
  });
  ['reviewModal','genModal','lightbox'].forEach(function(id){
    $(id).addEventListener('click',function(ev){ if(ev.target.closest('[data-close]')) closeModal(id); });
  });
  document.addEventListener('keydown',function(ev){
    if(ev.key!=='Escape') return;
    ['lightbox','genModal','reviewModal'].forEach(function(id){ if(!$(id).classList.contains('hidden')) closeModal(id); });
  });
  window.addEventListener('online',net); window.addEventListener('offline',net);

  /* another tab changed the data — pull it in and refresh what is on screen */
  window.addEventListener('storage',function(ev){
    if(!S.user||!ev.key) return;
    if([K.entries,K.workers,K.ledger,K.overheads,K.branches,K.users,K.settings].indexOf(ev.key)<0) return;
    loadAll();
    if(S.editing){
      var still=S.entries.filter(function(x){ return x.id===S.editing.id; })[0];
      if(!still||!canEdit(still)){ loadEntry(still?still.id:null); toast('This entry was updated elsewhere.','warn'); }
    }
    renderRecords(); renderDashboard(); renderWorkers(); renderOverheads(); updatePendingBadge();
  });
}

function init(){
  loadAll(); wire(); net(); clock(); setInterval(clock,1000); setInterval(tickSession,1000);
  var reason=DB.read(K.logoutReason,null);
  if(reason){ $('loginNotice').textContent=reason; $('loginNotice').classList.remove('hidden'); LS.del(K.logoutReason); }
  try{ var l=document.createElement('link'); l.rel='icon'; l.type='image/png'; l.href=$('brandLogo').getAttribute('src'); document.head.appendChild(l); }catch(e){}
  var s=DB.read(K.session,null);
  if(s){ var u=S.users.filter(function(x){return x.id===s.id;})[0]; if(u){ startApp(u); return; } }
  $('loginUser').focus();
}

/* =======================================================================
   API INTEGRATION LAYER
   -----------------------------------------------------------------------
   Everything above this point is the original browser application. The
   function declarations below re-declare the handful of functions that used
   to talk to localStorage so they talk to the Flask API instead. Later
   declarations win at hoist time, so the UI, rendering and all calculations
   are untouched — only persistence changed.
   ======================================================================= */

var API = '/api';

function api(method, path, body) {
  return fetch(API + path, {
    method: method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).then(function (res) {
    if (res.status === 204) return {};
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (res.ok) return data;
      if (res.status === 401) { handleSessionEnd(data.reason); throw { handled: true }; }
      var err = new Error(data.message || data.error || ('Request failed (' + res.status + ')'));
      err.payload = data; err.status = res.status;
      throw err;
    });
  });
}

/* ---------------- double-click protection ----------------
   A tap on a phone often lands twice. Every save goes through once()/done():
   the first click claims the key and disables the button, the second is
   dropped on the floor. The server refuses duplicates as well — this only
   spares the user seeing an error for something they did not mean to do. */
var BUSY = {};
function once(key, btnId) {
  if (BUSY[key]) return false;
  BUSY[key] = true;
  var b = $(btnId || key);
  if (b) { b.disabled = true; b.classList.add('opacity-60', 'cursor-not-allowed'); }
  return true;
}
function done(key, btnId) {
  delete BUSY[key];
  var b = $(btnId || key);
  if (b) { b.disabled = false; b.classList.remove('opacity-60', 'cursor-not-allowed'); }
}

/* once()/done() alone still lets a second tap land inside a slow round-trip,
   since the lock releases the instant the response arrives. spinGuard()/
   spinRelease() add a visible spinner on the button itself AND hold the lock
   for at least `minMs` (default 4s) from the click, not just for however
   long the request takes — used on money-moving actions like Day Close's
   Save/Verify, where firing the same request twice is expensive to undo. */
function spinGuard(key, btn) {
  if (!once(key)) return null;
  var orig = btn ? btn.innerHTML : null;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('opacity-60', 'cursor-not-allowed');
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>' + btn.textContent.trim();
  }
  return { started: Date.now(), btn: btn, orig: orig };
}
function spinRelease(key, ctx, minMs) {
  var restore = function () {
    if (ctx && ctx.btn && document.contains(ctx.btn)) {
      ctx.btn.innerHTML = ctx.orig;
      ctx.btn.disabled = false;
      ctx.btn.classList.remove('opacity-60', 'cursor-not-allowed');
    }
    done(key);
  };
  var wait = ctx ? Math.max(0, (minMs || 4000) - (Date.now() - ctx.started)) : 0;
  if (wait > 0) setTimeout(restore, wait); else restore();
}

/* The server also refuses an identical amount posted seconds apart. When it
   does, say so plainly and close — the money WAS recorded, once, which is
   what the user wanted. Offer the override for a genuine second payment. */
function dupAware(key) {
  return function (err) {
    if (err && err.payload && err.payload.error === 'duplicate') {
      closeModal('genModal');
      toast(err.message, 'warn');
      return;
    }
    apiFail(err);
  };
}

function apiFail(err) {
  if (err && err.handled) return;
  var msg = (err && err.message) || 'Could not reach the server.';
  if (err && err.payload && err.payload.missing) {
    showValidation(err.payload.missing);
    msg = err.payload.missing.length + ' required field(s) still missing.';
  }
  if (err && err.payload && err.payload.gaps) {
    msg = 'Enter the ' + err.payload.gaps.join(' and ') + ' before approving.';
  }
  toast(msg, 'error');
}

function handleSessionEnd(reason) {
  S.user = null;
  $('appShell').classList.add('hidden');
  $('loginScreen').classList.remove('hidden');
  if (reason === 'idle_timeout') {
    $('loginNotice').textContent = 'You were signed out automatically after a period of inactivity.';
    $('loginNotice').classList.remove('hidden');
  }
}

/* The activity log now lives on the server; the client no longer writes it. */
function logAct() { /* server-side via ActivityLog */ }

function loadAll() { /* replaced by bootstrap() */ }

function bootstrap() {
  return api('GET', '/bootstrap').then(function (d) {
    S.user = d.user;
    S.branches = d.branches || {};
    S.entries = d.entries || [];
    S.workers = d.workers || [];
    S.ledger = d.ledger || [];
    S.overheads = d.overheads || [];
    S.customers = d.customers || [];
    S.custTotals = d.customerTotals || {};
    S.receipts = d.receipts || [];
    S.customerAdjustments = d.customerAdjustments || [];
    S.closes = d.closes || [];
    S.window = d.window ? { from: d.window.from, to: d.window.to } : null;
    S.users = d.users || [];
    S.settings = d.settings || {};
    // idleMinutes is null for a role with no idle limit (admin) — Infinity
    // keeps tickSession()'s math sane even if its early admin return above
    // is ever bypassed.
    IDLE_MS[d.user.role] = d.idleMinutes == null ? Infinity : d.idleMinutes * 60 * 1000;
    return d;
  });
}

/* ---------------- loaded window ----------------
   The first load brings a bounded slice of history rather than everything.
   Any screen asking for a date range outside that slice widens it first, so a
   report can never quietly leave out days the browser simply had not fetched. */
function ensureRange(from, to) {
  var w = S.window;
  if (!w) return Promise.resolve(false);
  if (from >= w.from && to <= w.to) return Promise.resolve(false);
  var need = { from: from < w.from ? from : w.from, to: to > w.to ? to : w.to };
  if (S.fetching === need.from + '|' + need.to) return Promise.resolve(false);
  S.fetching = need.from + '|' + need.to;

  return api('GET', '/entries?from=' + need.from + '&to=' + need.to +
                    '&page=1&pageSize=1000')
    .then(function (d) {
      var rows = d.rows || d;
      var seen = {};
      rows.forEach(function (r) { seen[r.id] = 1; });
      /* keep anything outside the newly fetched span, replace what is inside */
      S.entries = S.entries.filter(function (e) {
        if (seen[e.id]) return false;
        var day = dOf(e.datetime);
        return day < need.from || day > need.to;
      }).concat(rows);
      S.window = need;
      if (d.total && d.total > rows.length) {
        toast('Showing the most recent ' + rows.length + ' of ' + d.total +
              ' records in this range. Narrow the dates for a complete view.', 'warn');
      }
      return true;
    })
    .catch(function (err) { apiFail(err); return false; })
    .then(function (changed) { S.fetching = null; return changed; });
}

/* Mortality images are not sent with lists. Pull them when the entry is
   actually opened, and only once. */
function ensurePhotos(id) {
  var e = S.entries.filter(function (x) { return x.id === id; })[0];
  if (!e) return Promise.resolve([]);
  if (e.photosLoaded || !num(e.photoCount)) { e.photosLoaded = true; return Promise.resolve(e.photos || []); }
  return api('GET', '/entries/' + id + '/photos').then(function (d) {
    e.photos = d.photos || [];
    e.photosLoaded = true;
    return e.photos;
  }).catch(function () { return []; });
}

function refreshAllViews() {
  refreshBranchSelects();
  renderRecords();
  renderDashboard();
  renderCustomers();
  renderWorkers();
  renderOverheads();
  renderOverheadLedger();
  updatePendingBadge();
}

function renderActivity() {
  if (!isAdmin() || !$('actBody')) return;
  api('GET', '/activity?limit=500').then(function (rows) {
    S.activity = rows;
    var uSel = $('actUser'), kSel = $('actKind');
    var users = {}, kinds = {};
    rows.forEach(function (a) { users[a.userName] = 1; kinds[a.action] = 1; });
    var keepU = uSel.value, keepK = kSel.value;
    uSel.innerHTML = '<option value="">All users</option>' + Object.keys(users).sort().map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('');
    kSel.innerHTML = '<option value="">All actions</option>' + Object.keys(kinds).sort().map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('');
    uSel.value = keepU; kSel.value = keepK;
    var list = rows.filter(function (a) {
      if (keepU && a.userName !== keepU) return false;
      if (keepK && a.action !== keepK) return false;
      return true;
    });
    $('actCount').textContent = list.length;
    var col = { 'Sign in': 'bg-emerald-100 text-emerald-800', 'Sign out': 'bg-slate-200 text-slate-700',
      'Auto logout': 'bg-amber-100 text-amber-800', 'Approved entry': 'bg-emerald-100 text-emerald-800',
      'Returned entry': 'bg-rose-100 text-rose-800', 'Deleted entry': 'bg-rose-100 text-rose-800',
      'Failed sign in': 'bg-rose-100 text-rose-800' };
    $('actBody').innerHTML = list.length ? list.map(function (a) {
      var when = String(a.at).slice(0, 10) + ' ' + String(a.at).slice(11, 19);
      return '<tr class="rowhover"><td class="px-4 py-2 whitespace-nowrap text-xs num">' + when + '</td>' +
        '<td class="px-4 py-2 font-semibold">' + esc(a.userName) + '</td>' +
        '<td class="px-4 py-2"><span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ' + (a.role === 'admin' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800') + '">' + esc(a.role) + '</span></td>' +
        '<td class="px-4 py-2 text-xs text-slate-500">' + esc(a.branch) + '</td>' +
        '<td class="px-4 py-2"><span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded ' + (col[a.action] || 'bg-slate-100 text-slate-700') + '">' + esc(a.action) + '</span></td>' +
        '<td class="px-4 py-2 text-xs text-slate-500">' + esc(a.detail) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="px-4 py-10 text-center text-slate-400">No activity recorded.</td></tr>';
  }).catch(apiFail);
}

/* ---------------- entries ---------------- */
function upsertEntry(rec) {
  var i = S.entries.findIndex(function (x) { return x.id === rec.id; });
  if (i >= 0) S.entries[i] = rec; else S.entries.push(rec);
}

function saveEntry(status) {
  if (status === 'pending') {
    var miss = validate(true);
    if (miss.length) { showValidation(miss); toast(miss.length + ' required field(s) still missing.', 'error'); return; }
  }
  $('validationBox').classList.add('hidden');
  var e = readForm();
  e.businessDate = dOf(e.datetime);
  e.submit = (status === 'pending');
  var savedDraftKey = draftKey();   // captured now — S.editing (and so draftKey()) changes once loadEntry(rec.id) runs below

  var p = S.editing
    ? api('PUT', '/entries/' + S.editing.id, e)
    : api('POST', '/entries', e);

  var hadHotel = (e.hotelSales || []).length > 0;
  p.then(function (rec) {
    upsertEntry(rec);
    clearDraft(savedDraftKey);   // it's on the server now — nothing left to recover
    toast(status === 'draft' ? 'Draft saved.' : status === 'pending' ? 'Sent to admin for approval.' : 'Changes saved.');
    /* hotel lines move customer balances, so pull the fresh totals back */
    return (hadHotel || (rec.hotelSales || []).length ? bootstrap() : Promise.resolve())
      .then(function () {
        loadEntry(rec.id);
        renderRecords(); renderDashboard(); renderCustomers(); updatePendingBadge();
      });
  }).catch(apiFail);
}

function decide(id, verdict, reason) {
  var payload = { verdict: verdict, reason: reason || '' };
  var e = S.entries.filter(function (x) { return x.id === id; })[0];
  if (e && isAdmin()) {
    payload.openRate = num(e.openRate);
    payload.rates = (e.purchases || []).map(function (p) { return num(p.rate); });
  }
  api('POST', '/entries/' + id + '/decision', payload).then(function (rec) {
    upsertEntry(rec);
    toast(verdict === 'approved' ? 'Approved and saved as a record.' : 'Returned to supervisor.',
      verdict === 'approved' ? 'success' : 'warn');
    closeModal('reviewModal');
    /* approving turns pending hotel bills into real debt */
    return ((rec.hotelSales || []).length ? bootstrap() : Promise.resolve()).then(function () {
      if (S.editing && S.editing.id === id) loadEntry(id);
      renderRecords(); renderDashboard(); renderCustomers(); updatePendingBadge();
    });
  }).catch(apiFail);
}

/* Costing edits in the approval screen are persisted as the admin types. */
function repriceReview(id) {
  var e = S.entries.filter(function (x) { return x.id === id; })[0]; if (!e) return;
  var c = calc(e);
  if ($('rvAvg')) $('rvAvg').textContent = money(c.avgRate) + ' / kg';
  if ($('rvRevenue')) $('rvRevenue').textContent = money0(c.revenue);
  if ($('rvCogs')) $('rvCogs').textContent = money0(c.cogs);
  if ($('rvNet')) $('rvNet').textContent = money0(c.netProfit);
  (e.purchases || []).forEach(function (p, i) {
    var el = document.querySelector('[data-rvline="' + i + '"]');
    if (el) el.textContent = money(num(p.wtG) / 1000 * num(p.rate));
  });
  var gaps = costingGaps(e), btn = $('rvApprove');
  if (btn) {
    btn.disabled = gaps.length > 0;
    btn.className = 'inline-flex items-center gap-2 font-bold text-sm px-5 py-2.5 rounded-lg ' +
      (gaps.length ? 'bg-slate-300 text-slate-500 cursor-not-allowed' : 'bg-emerald-700 hover:bg-emerald-800 text-white');
    btn.title = gaps.length ? 'Enter the ' + gaps.join(' and ') + ' first' : '';
  }
  clearTimeout(repriceReview._t);
  repriceReview._t = setTimeout(function () {
    api('PUT', '/entries/' + id + '/costing', {
      openRate: num(e.openRate),
      rates: (e.purchases || []).map(function (p) { return num(p.rate); })
    }).then(function (rec) { upsertEntry(rec); }).catch(function () { });
  }, 500);
}

/* ---------------- hotels & hostels ---------------- */
function dealText(c, product) {
  var def = productDef(product);
  if (c.mode === 'fixed') {
    var f = num(c[def.fixed]);
    return f > 0 ? '<span class="font-semibold num">' + money(f) + '</span><span class="text-[10px] text-slate-400 block">fixed</span>'
                 : '<span class="text-slate-300">—</span>';
  }
  var l = num(c[def.less]);
  if (l > 0) return '<span class="font-semibold num text-amber-700">−' + money(l) + '</span><span class="text-[10px] text-slate-400 block">off market</span>';
  if (l < 0) return '<span class="font-semibold num text-emerald-700">+' + money(-l) + '</span><span class="text-[10px] text-slate-400 block">above market</span>';
  return '<span class="num">market</span><span class="text-[10px] text-slate-400 block">no concession</span>';
}

function renderCustomers() {
  if (!$('custBody') || !S.branch) return;
  $('custBranchLabel').textContent = S.branches[S.branch] || '—';
  var filter = $('custFilter') ? $('custFilter').value : '';
  var all = S.customers.filter(function (c) { return c.branch === S.branch; });
  var list = all.filter(function (c) {
    if (filter === 'hotel' || filter === 'hostel' || filter === 'function') return c.kind === filter;
    if (filter === 'due') return num((S.custTotals[c.id] || {}).balance) > 0.005;
    return true;
  }).sort(function (a, b) { return a.code < b.code ? -1 : 1; });

  var t = { billed: 0, received: 0, balance: 0, concession: 0, pending: 0 };
  all.forEach(function (c) {
    var x = S.custTotals[c.id] || {};
    t.billed += num(x.credit) + num(x.cash);
    t.received += num(x.receipts);
    t.balance += num(x.balance);
    t.pending += num(x.pending);
  });
  /* concession over all time, straight from the approved entries on hand */
  S.entries.forEach(function (e) {
    if (e.branch !== S.branch || e.status !== 'approved') return;
    var c = calc(e); t.concession += c.hotelConcession;
  });

  $('ckCount').textContent = all.length;
  $('ckBilled').textContent = money0(t.billed);
  $('ckReceived').textContent = money0(t.received);
  $('ckOutstanding').textContent = money0(t.balance);
  $('ckConcession').textContent = money0(Math.abs(t.concession));
  if ($('ckConcessionLabel')) {
    $('ckConcessionLabel').textContent = t.concession >= 0 ? 'Concession given' : 'Premium earned';
    $('ckConcession').className = 'mt-2 text-2xl font-bold num ' + (t.concession >= 0 ? 'text-amber-600' : 'text-emerald-600');
  }
  $('custNote').textContent = list.length + ' shown' +
    (t.pending > 0 ? ' · ' + money0(t.pending) + ' still awaiting approval, not counted in any balance' : '');

  var badge = $('custBadge');
  if (badge) {
    var owing = all.filter(function (c) { return num((S.custTotals[c.id] || {}).balance) > 0.005; }).length;
    badge.textContent = owing;
    badge.classList.toggle('hidden', owing === 0);
  }

  var ft = { billed: 0, received: 0, balance: 0 };
  $('custBody').innerHTML = list.length ? list.map(function (c) {
    var x = S.custTotals[c.id] || {};
    var billed = num(x.credit) + num(x.cash), received = num(x.receipts), bal = num(x.balance);
    ft.billed += billed; ft.received += received; ft.balance += bal;
    return '<tr class="rowhover"><td class="px-4 py-2.5 font-mono text-xs text-slate-500">' + esc(c.code) + '</td>' +
      '<td class="px-4 py-2.5 font-semibold">' + esc(c.name) +
        (c.contact || c.phone ? '<span class="block text-xs text-slate-400">' + esc([c.contact, c.phone].filter(Boolean).join(' · ')) + '</span>' : '') +
        (c.active === false ? '<span class="text-[10px] font-bold uppercase text-slate-400">inactive</span>' : '') + '</td>' +
      '<td class="px-4 py-2.5"><span class="text-[10px] font-bold uppercase px-2 py-1 rounded ' + kindDef(c.kind).cls + '">' +
        '<i class="fa-solid ' + kindDef(c.kind).ic + ' mr-1"></i>' + esc(kindDef(c.kind).t) + '</span></td>' +
      '<td class="px-4 py-2.5 text-xs">' + dealText(c, 'skin') + '</td>' +
      '<td class="px-4 py-2.5 text-xs">' + dealText(c, 'skinless') + '</td>' +
      '<td class="px-4 py-2.5 text-xs">' + dealText(c, 'liver') + '</td>' +
      '<td class="px-4 py-2.5 text-xs">' + dealText(c, 'live') + '</td>' +
      '<td class="px-4 py-2.5 text-right num">' + money0(billed) + '</td>' +
      '<td class="px-4 py-2.5 text-right num text-slate-500">' + money0(received) + '</td>' +
      '<td class="px-4 py-2.5 text-right num font-bold ' + (bal > 0.005 ? 'text-rose-600' : 'text-emerald-700') + '">' + money0(bal) + '</td>' +
      '<td class="px-4 py-2.5 text-right whitespace-nowrap">' +
        '<button data-cact="ledger" data-id="' + c.id + '" title="Ledger" class="h-8 w-8 rounded-lg text-slate-700 hover:bg-slate-100"><i class="fa-solid fa-book-open"></i></button>' +
        '<button data-cact="pay" data-id="' + c.id + '" title="Record a receipt" class="h-8 w-8 rounded-lg text-emerald-700 hover:bg-emerald-100"><i class="fa-solid fa-hand-holding-dollar"></i></button>' +
        (isAdmin() ? '<button data-cact="adjust" data-id="' + c.id + '" title="Add or reduce billed amount" class="h-8 w-8 rounded-lg text-amber-700 hover:bg-amber-100"><i class="fa-solid fa-sliders"></i></button>' : '') +
        '<button data-cact="edit" data-id="' + c.id + '" title="Edit" class="h-8 w-8 rounded-lg text-slate-600 hover:bg-slate-100"><i class="fa-solid fa-pen-to-square"></i></button>' +
        (isAdmin() ? '<button data-cact="del" data-id="' + c.id + '" title="Remove" class="h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-100"><i class="fa-solid fa-trash"></i></button>' : '') +
      '</td></tr>';
  }).join('') : '<tr><td colspan="11" class="px-4 py-10 text-center text-slate-400">' +
      (all.length ? 'No customer matches this filter.' : 'Nothing registered for this branch yet. Add a hotel, hostel or function to start billing at an agreed price.') + '</td></tr>';

  $('custFoot').innerHTML = list.length ? '<tr><td class="px-4 py-2.5" colspan="7">Totals</td>' +
    '<td class="px-4 py-2.5 text-right num">' + money0(ft.billed) + '</td>' +
    '<td class="px-4 py-2.5 text-right num">' + money0(ft.received) + '</td>' +
    '<td class="px-4 py-2.5 text-right num">' + money0(ft.balance) + '</td><td></td></tr>' : '';
}

function customerModal(c) {
  c = c || {};
  var isNew = !c.id;
  var mode = c.mode || 'less';
  var row = function (label, lessId, fixedId, lessVal, fixedVal) {
    /* the "less" box has no min — a negative value is how you charge this
       customer ABOVE market instead of below it (see the hint text) */
    return '<tr><td class="py-2 pr-3 font-semibold text-sm">' + label + '</td>' +
      '<td class="py-2 pr-2"><input type="number" step="0.5" id="' + lessId + '" class="inp num" value="' + (lessVal || '') + '" placeholder="0.00" title="Positive charges less than today\'s market rate, negative charges more" /></td>' +
      '<td class="py-2"><input type="number" min="0" step="0.5" id="' + fixedId + '" class="inp num" value="' + (fixedVal || '') + '" placeholder="0.00" /></td></tr>';
  };
  openGen(isNew ? 'Add a hotel or hostel' : 'Edit ' + c.name,
    '<div class="space-y-3">' +
    '<div class="grid grid-cols-3 gap-3">' +
      '<div class="col-span-2"><label class="lbl" for="cuName">Name</label><input id="cuName" class="inp" value="' + esc(c.name || '') + '" placeholder="e.g. Grand Palace Hotel" /></div>' +
      '<div><label class="lbl" for="cuKind">Type</label><select id="cuKind" class="inp">' +
        CUSTOMER_KINDS.map(function (k) { return '<option value="' + k.v + '"' + (c.kind === k.v ? ' selected' : '') + '>' + k.t + '</option>'; }).join('') +
      '</select></div>' +
    '</div>' +
    '<div class="grid grid-cols-2 gap-3">' +
      '<div><label class="lbl" for="cuContact">Contact person</label><input id="cuContact" class="inp" value="' + esc(c.contact || '') + '" placeholder="Optional" /></div>' +
      '<div><label class="lbl" for="cuPhone">Phone</label><input id="cuPhone" class="inp" value="' + esc(c.phone || '') + '" placeholder="Optional" /></div>' +
    '</div>' +
    '<div><label class="lbl" for="cuMode">How is their price set?</label><select id="cuMode" class="inp">' +
      '<option value="less"' + (mode === 'less' ? ' selected' : '') + '>Adjusted from today\'s market rate (usual)</option>' +
      '<option value="fixed"' + (mode === 'fixed' ? ' selected' : '') + '>A flat contract rate</option>' +
    '</select></div>' +
    '<div class="rounded-lg border border-slate-200 overflow-hidden">' +
      '<div class="bg-slate-100 px-3 py-2 text-xs font-bold uppercase tracking-wide text-slate-600">Agreed price (₹ per kg)</div>' +
      '<div class="p-3"><table class="w-full"><thead><tr class="text-left">' +
        '<th class="pb-1"></th>' +
        '<th class="pb-1 text-[11px] font-bold uppercase text-amber-700" id="thLess">+/− vs market</th>' +
        '<th class="pb-1 text-[11px] font-bold uppercase text-slate-500" id="thFixed">Fixed rate</th>' +
      '</tr></thead><tbody>' +
        row('Skin', 'cuLessSkin', 'cuRateSkin', c.lessSkin, c.rateSkin) +
        row('Skinless', 'cuLessSkinless', 'cuRateSkinless', c.lessSkinless, c.rateSkinless) +
        row('Liver', 'cuLessLiver', 'cuRateLiver', c.lessLiver, c.rateLiver) +
        row('Live birds', 'cuLessLive', 'cuRateLive', c.lessLive, c.rateLive) +
      '</tbody></table>' +
      '<p id="cuHint" class="mt-2 text-xs rounded-lg px-3 py-2 font-semibold border"></p></div>' +
    '</div>' +
    (isNew || isAdmin()
      ? '<div><label class="lbl" for="cuOpening">Balance already owed (₹)</label><input type="number" step="1" id="cuOpening" class="inp num" value="' + (c.openingBalance || '') + '" placeholder="0" />' +
        '<p class="text-[11px] text-slate-400 mt-1">What they owed before this system started. Leave blank if nothing.</p></div>'
      : '') +
    (isNew ? '' : '<label class="inline-flex items-center gap-2 text-sm font-semibold"><input type="checkbox" id="cuActive" class="h-4 w-4 rounded border-slate-300" ' + (c.active !== false ? 'checked' : '') + ' /> Active — show in the daily entry</label>') +
    '<button id="cuSave" class="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg mt-2">' + (isNew ? 'Add customer' : 'Save changes') + '</button></div>');

  var upd = function () {
    var m = tv('cuMode'), h = $('cuHint');
    ['cuLessSkin', 'cuLessSkinless', 'cuLessLiver', 'cuLessLive'].forEach(function (id) { $(id).disabled = (m === 'fixed'); });
    ['cuRateSkin', 'cuRateSkinless', 'cuRateLiver', 'cuRateLive'].forEach(function (id) { $(id).disabled = (m === 'less'); });
    $('thLess').className = 'pb-1 text-[11px] font-bold uppercase ' + (m === 'less' ? 'text-amber-700' : 'text-slate-300');
    $('thFixed').className = 'pb-1 text-[11px] font-bold uppercase ' + (m === 'fixed' ? 'text-emerald-700' : 'text-slate-300');
    if (m === 'fixed') {
      h.className = 'mt-2 text-xs rounded-lg px-3 py-2 font-semibold border bg-emerald-50 text-emerald-800 border-emerald-200';
      h.textContent = 'They pay this rate whatever the counter price does. The difference against the counter rate is still recorded as concession (or premium, if it runs the other way).';
    } else {
      h.className = 'mt-2 text-xs rounded-lg px-3 py-2 font-semibold border bg-amber-50 text-amber-800 border-amber-200';
      h.textContent = 'A positive number is a discount below today\'s market rate; a negative number charges more than market. Example: if skin is ₹250 at the counter today, entering 50 bills them ₹200/kg (₹50 concession given), and entering -50 bills them ₹300/kg (₹50 premium earned). Live birds work the same way against the live rate, updating automatically with each day\'s entry.';
    }
  };
  $('cuMode').addEventListener('change', upd); upd();

  bind('cuSave', function () {
    var name = tv('cuName');
    if (!name) { toast('Enter the name.', 'error'); return; }
    var body = { branch: S.branch, name: name, kind: tv('cuKind'), mode: tv('cuMode'),
      contact: tv('cuContact'), phone: tv('cuPhone'),
      lessSkin: v('cuLessSkin'), lessSkinless: v('cuLessSkinless'),
      lessLiver: v('cuLessLiver'), lessLive: v('cuLessLive'),
      rateSkin: v('cuRateSkin'), rateSkinless: v('cuRateSkinless'),
      rateLiver: v('cuRateLiver'), rateLive: v('cuRateLive') };
    if ($('cuOpening')) body.openingBalance = v('cuOpening');
    if ($('cuActive')) body.active = $('cuActive').checked;

    if (!once('cuSave')) return;
    var p = c.id ? api('PUT', '/customers/' + c.id, body) : api('POST', '/customers', body);
    p.then(function () { return bootstrap(); })
      .then(function () {
        closeModal('genModal');
        renderCustomers(); renderHotelRows(); recalc(); renderDashboard();
        toast(c.id ? 'Saved.' : name + ' added.');
      }).catch(apiFail).then(function () { done('cuSave'); });
  });
}

function receiptModal(cid) {
  var c = customerById(cid); if (!c) return;
  var t = S.custTotals[cid] || {};
  openGen('Receipt from ' + c.name,
    '<div class="space-y-3">' +
    '<div class="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600">' +
      '<b>' + esc(c.name) + '</b> · ' + esc(c.kind) + '<br>' +
      'Billed ' + money0(num(t.credit) + num(t.cash)) + ' · received ' + money0(num(t.receipts)) +
      ' · <b>balance due ' + money0(num(t.balance)) + '</b></div>' +
    '<div class="grid grid-cols-2 gap-3">' +
      '<div><label class="lbl" for="rcDate">Date received</label><input type="date" id="rcDate" class="inp" value="' + todayISO() + '" /></div>' +
      '<div><label class="lbl" for="rcAmt">Amount (₹)</label><input type="number" min="0" step="1" id="rcAmt" class="inp num" /></div>' +
    '</div>' +
    '<div class="grid grid-cols-2 gap-3">' +
      '<div><label class="lbl" for="rcMode">Mode</label><select id="rcMode" class="inp">' +
        [['cash', 'Cash'], ['upi', 'UPI'], ['bank', 'Bank transfer'], ['cheque', 'Cheque']]
          .map(function (m) { return '<option value="' + m[0] + '">' + m[1] + '</option>'; }).join('') + '</select></div>' +
      '<div><label class="lbl" for="rcNote">Reference</label><input id="rcNote" class="inp" placeholder="Optional" /></div>' +
    '</div>' +
    '<button id="rcSave" class="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg">Record receipt</button></div>');
  bind('rcSave', function () {
    if (v('rcAmt') <= 0) { toast('Enter an amount.', 'error'); return; }
    api('POST', '/customers/' + cid + '/payments', { date: tv('rcDate'), amount: v('rcAmt'),
      mode: tv('rcMode'), note: tv('rcNote') })
      .then(function () { return bootstrap(); })
      .then(function () {
        closeModal('genModal'); renderCustomers(); renderDashboard();
        toast(money0(v('rcAmt')) + ' received from ' + c.name + '.');
      }).catch(apiFail);
  });
}

/* Admin-only: fix a receipt that was recorded wrong — a typo'd amount, the
   wrong date, or the wrong mode — instead of deleting and re-adding it by
   hand. `r` is the ledger row for this receipt (has .id/.date/.amount/
   .mode/.note already). Reopens the ledger underneath so the correction
   shows immediately. */
function editReceiptModal(cid, r) {
  var c = customerById(cid); if (!c) return;
  openGen('Edit receipt — ' + c.name,
    '<div class="space-y-3">' +
    '<div class="grid grid-cols-2 gap-3">' +
      '<div><label class="lbl" for="rcEDate">Date received</label><input type="date" id="rcEDate" class="inp" value="' + esc(r.date) + '" /></div>' +
      '<div><label class="lbl" for="rcEAmt">Amount (₹)</label><input type="number" min="0" step="1" id="rcEAmt" class="inp num" value="' + r.amount + '" /></div>' +
    '</div>' +
    '<div class="grid grid-cols-2 gap-3">' +
      '<div><label class="lbl" for="rcEMode">Mode</label><select id="rcEMode" class="inp">' +
        [['cash', 'Cash'], ['upi', 'UPI'], ['bank', 'Bank transfer'], ['cheque', 'Cheque']]
          .map(function (m) { return '<option value="' + m[0] + '"' + (r.mode === m[0] ? ' selected' : '') + '>' + m[1] + '</option>'; }).join('') + '</select></div>' +
      '<div><label class="lbl" for="rcENote">Reference</label><input id="rcENote" class="inp" value="' + esc(r.note || '') + '" placeholder="Optional" /></div>' +
    '</div>' +
    '<button id="rcESave" class="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg">Save changes</button></div>');
  bind('rcESave', function () {
    if (v('rcEAmt') <= 0) { toast('Enter an amount.', 'error'); return; }
    if (!once('rcESave')) return;
    api('PUT', '/payments/' + r.id, { date: tv('rcEDate'), amount: v('rcEAmt'),
      mode: tv('rcEMode'), note: tv('rcENote') })
      .then(function () { return bootstrap(); })
      .then(function () {
        renderCustomers(); renderDashboard();
        openCustomerLedger(cid);
        toast('Receipt updated.');
      }).catch(apiFail).then(function () { done('rcESave'); });
  });
}

/* Admin-only: add to or reduce what a hotel/hostel/function customer has
   been billed, without it being tied to any sale line — e.g. a mischarge
   found after the day was already approved. The date + cash/credit choice
   decide whether it also moves that day's Day Close cash (cash) or only the
   running balance (credit), exactly like a hotel sale line would. */
function adjustBillModal(cid) {
  var c = customerById(cid); if (!c) return;
  var t = S.custTotals[cid] || {};
  openGen('Adjust billed amount — ' + c.name,
    '<div class="space-y-3">' +
    '<div class="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600">' +
      '<b>' + esc(c.name) + '</b> · ' + esc(c.kind) + '<br>' +
      'Billed to date ' + money0(num(t.credit) + num(t.cash)) +
      ' · <b>balance due ' + money0(num(t.balance)) + '</b></div>' +
    '<div class="grid grid-cols-2 gap-3">' +
      '<div><label class="lbl" for="adjDate">Date</label><input type="date" id="adjDate" class="inp" value="' + todayISO() + '" /></div>' +
      '<div><label class="lbl" for="adjAmt">Amount (₹)</label><input type="number" step="1" id="adjAmt" class="inp num" placeholder="e.g. 200 or -200" /></div>' +
    '</div>' +
    '<p class="text-[11px] text-slate-400 -mt-2">Positive raises the bill, negative lowers it.</p>' +
    '<div><label class="lbl" for="adjSettled">Effect</label><select id="adjSettled" class="inp">' +
      '<option value="0">On account — changes the balance only</option>' +
      '<option value="1">Cash — also moves today\'s Day Close and dashboard P&amp;L for that date</option>' +
    '</select></div>' +
    '<div><label class="lbl" for="adjNote">Reason (recommended)</label><input id="adjNote" class="inp" placeholder="e.g. Corrected a mischarge on the 12th" /></div>' +
    '<button id="adjSave" class="w-full bg-amber-700 hover:bg-amber-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg">Save adjustment</button></div>');
  bind('adjSave', function () {
    var amt = v('adjAmt');
    if (!amt) { toast('Enter an amount to add or reduce.', 'error'); return; }
    if (!once('adjSave')) return;
    api('POST', '/customers/' + cid + '/adjustments', { date: tv('adjDate'), amount: amt,
      settled: tv('adjSettled') === '1', note: tv('adjNote') })
      .then(function () { return bootstrap(); })
      .then(function () {
        closeModal('genModal'); renderCustomers(); renderDashboard();
        toast((amt > 0 ? 'Added ' : 'Reduced by ') + money0(Math.abs(amt)) + ' for ' + c.name + '.');
      }).catch(apiFail).then(function () { done('adjSave'); });
  });
}

function openCustomerLedger(cid) {
  api('GET', '/customers/' + cid + '/ledger').then(function (d) {
    var c = d.customer, t = d.totals;
    var head = '<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">' +
      '<div class="rounded-lg bg-slate-50 border border-slate-200 p-3"><p class="text-[10px] font-bold uppercase text-slate-500">Opening</p><p class="font-bold num">' + money0(t.opening) + '</p></div>' +
      '<div class="rounded-lg bg-emerald-50 border border-emerald-200 p-3"><p class="text-[10px] font-bold uppercase text-emerald-700">Billed on account</p><p class="font-bold num">' + money0(t.credit) + '</p></div>' +
      '<div class="rounded-lg bg-slate-50 border border-slate-200 p-3"><p class="text-[10px] font-bold uppercase text-slate-500">Received</p><p class="font-bold num">' + money0(t.receipts) + '</p></div>' +
      '<div class="rounded-lg ' + (t.balance > 0.005 ? 'bg-rose-50 border-rose-200' : 'bg-emerald-50 border-emerald-200') + ' border p-3">' +
        '<p class="text-[10px] font-bold uppercase text-slate-500">Balance due</p><p class="font-bold num text-lg ' + (t.balance > 0.005 ? 'text-rose-600' : 'text-emerald-700') + '">' + money0(t.balance) + '</p></div>' +
      '</div>';

    var note = '<p class="text-xs text-slate-500 mb-3">Cash sales settle on the day and never touch the balance. ' +
      (t.pending > 0 ? 'A further <b>' + money0(t.pending) + '</b> is sold but not yet approved, so it is listed below and excluded from the balance.' : 'Everything sold has been approved.') + '</p>';

    var rows = d.rows.length ? d.rows.map(function (r) {
      if (r.kind === 'receipt') {
        return '<tr class="rowhover bg-emerald-50/40"><td class="px-3 py-2 whitespace-nowrap">' + r.date + '</td>' +
          '<td class="px-3 py-2" colspan="4"><span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">Receipt</span> ' +
          esc(r.mode) + (r.note ? ' · ' + esc(r.note) : '') + '</td>' +
          '<td class="px-3 py-2 text-right num text-emerald-700 font-bold">−' + money0(r.amount) +
          (isAdmin() ? ' <button id="rcEdit_' + r.id + '" title="Edit this receipt" class="h-6 w-6 rounded text-slate-500 hover:bg-slate-100"><i class="fa-solid fa-pen-to-square"></i></button>' +
            '<button id="rcDel_' + r.id + '" title="Delete this receipt" class="h-6 w-6 rounded text-rose-500 hover:bg-rose-100"><i class="fa-solid fa-trash"></i></button>' : '') + '</td>' +
          '<td class="px-3 py-2 text-right num font-bold">' + money0(r.balance) + '</td></tr>';
      }
      if (r.kind === 'adjustment') {
        return '<tr class="rowhover bg-amber-50/40"><td class="px-3 py-2 whitespace-nowrap">' + r.date + '</td>' +
          '<td class="px-3 py-2" colspan="4"><span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-800">Adjustment</span> ' +
          (r.settled ? 'cash' : 'on account') + (r.note ? ' · ' + esc(r.note) : '') + '</td>' +
          '<td class="px-3 py-2 text-right num font-bold ' + (r.amount >= 0 ? 'text-slate-700' : 'text-emerald-700') + '">' +
            (r.amount >= 0 ? '+' : '−') + money0(Math.abs(r.amount)) + '</td>' +
          '<td class="px-3 py-2 text-right num font-bold">' + money0(r.balance) + '</td></tr>';
      }
      var chip = r.status !== 'approved'
        ? '<span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-800">' + esc(r.status) + '</span>'
        : r.settled ? '<span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-slate-200 text-slate-700">paid</span>'
                    : '<span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-rose-100 text-rose-700">on account</span>';
      return '<tr class="rowhover' + (r.status !== 'approved' ? ' opacity-60' : '') + '"><td class="px-3 py-2 whitespace-nowrap">' + r.date + '</td>' +
        '<td class="px-3 py-2">' + esc(productDef(r.product).t) + '</td>' +
        '<td class="px-3 py-2 text-right num">' + fmtW(r.weightG) + '</td>' +
        '<td class="px-3 py-2 text-right num text-xs text-slate-500">' + money(r.marketRate) + '</td>' +
        '<td class="px-3 py-2 text-right num">' + money(r.rate) +
          (r.concession > 0 ? '<span class="block text-[10px] text-amber-700">−' + money(r.concession) + '</span>'
            : r.concession < 0 ? '<span class="block text-[10px] text-emerald-700">+' + money(-r.concession) + '</span>' : '') + '</td>' +
        '<td class="px-3 py-2 text-right num font-semibold">' + money0(r.amount) + ' ' + chip + '</td>' +
        '<td class="px-3 py-2 text-right num font-bold">' + money0(r.balance) + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="px-3 py-10 text-center text-slate-400">Nothing on this ledger yet.</td></tr>';

    openGen(c.name + ' — ledger',
      head + note +
      '<div class="overflow-x-auto max-h-[45vh] overflow-y-auto border border-slate-200 rounded-lg"><table class="min-w-full text-sm">' +
      '<thead class="bg-slate-50 text-slate-600 sticky top-0"><tr class="text-left">' +
        '<th class="px-3 py-2 font-bold text-xs uppercase">Date</th>' +
        '<th class="px-3 py-2 font-bold text-xs uppercase">Item</th>' +
        '<th class="px-3 py-2 font-bold text-xs uppercase text-right">Weight</th>' +
        '<th class="px-3 py-2 font-bold text-xs uppercase text-right">Market</th>' +
        '<th class="px-3 py-2 font-bold text-xs uppercase text-right">Their rate</th>' +
        '<th class="px-3 py-2 font-bold text-xs uppercase text-right">Amount</th>' +
        '<th class="px-3 py-2 font-bold text-xs uppercase text-right">Balance</th>' +
      '</tr></thead><tbody class="divide-y divide-slate-100">' + rows + '</tbody></table></div>' +
      '<div class="flex flex-wrap gap-3 mt-4">' +
        '<button id="cuLedPay" class="bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg"><i class="fa-solid fa-hand-holding-dollar mr-1"></i> Record a receipt</button>' +
        (isAdmin() ? '<button id="cuLedAdjust" class="bg-amber-700 hover:bg-amber-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg"><i class="fa-solid fa-sliders mr-1"></i> Adjust billed amount</button>' : '') +
        '<button id="cuLedPrint" class="border border-slate-300 text-slate-600 font-bold text-sm px-5 py-2.5 rounded-lg"><i class="fa-solid fa-print mr-1"></i> Print</button>' +
        '<button id="cuLedCsv" class="border border-slate-300 text-slate-600 font-bold text-sm px-5 py-2.5 rounded-lg"><i class="fa-solid fa-file-excel mr-1"></i> Excel</button>' +
      '</div>');

    var custLedgerRows = function () {
      var headers = ['Date', 'Kind', 'Item', 'Weight kg', 'Market rate', 'Their rate', 'Concession', 'Amount', 'Status', 'Balance'];
      var rows = d.rows.map(function (r) {
        if (r.kind === 'receipt') return [r.date, 'Receipt', r.mode, '', '', '', '', -r.amount, 'received', r.balance];
        if (r.kind === 'adjustment') return [r.date, 'Adjustment', r.note || '', '', '', '', '', r.amount,
          r.settled ? 'cash' : 'on account', r.balance];
        return [r.date, 'Sale', r.product, (r.weightG / 1000).toFixed(3), r.marketRate, r.rate,
             r.concession, r.amount, r.status + (r.settled ? ' / paid' : ' / on account'), r.balance];
      });
      return { headers: headers, rows: rows };
    };
    bind('cuLedPay', function () { receiptModal(cid); });
    bind('cuLedAdjust', function () { closeModal('genModal'); adjustBillModal(cid); });
    if (isAdmin()) {
      d.rows.filter(function (r) { return r.kind === 'receipt'; }).forEach(function (r) {
        bind('rcEdit_' + r.id, function () { editReceiptModal(cid, r); });
        bind('rcDel_' + r.id, function () {
          if (!confirm('Delete this ' + money0(r.amount) + ' receipt (' + r.date + ')?')) return;
          api('DELETE', '/payments/' + r.id).then(function () { return bootstrap(); })
            .then(function () {
              renderCustomers(); renderDashboard();
              openCustomerLedger(cid);
              toast('Receipt deleted.', 'warn');
            }).catch(apiFail);
        });
      });
    }
    bind('cuLedCsv', function () {
      var x = custLedgerRows();
      toXlsx('VCC_ledger_' + c.code + '_' + todayISO(), 'Ledger', x.headers, x.rows);
    });
    bind('cuLedPrint', function () {
      var x = custLedgerRows();
      printTable(c.name + ' — ledger', 'Balance due ' + money0(t.balance), x.headers, x.rows);
    });
  }).catch(apiFail);
}

/* ---------------- end-of-day cash handover ---------------- */
function diffChip(diff) {
  if (diff === null || diff === undefined) return '<span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-slate-200 text-slate-600">not declared</span>';
  if (Math.abs(diff) < 0.5) return '<span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-emerald-100 text-emerald-800">balanced</span>';
  return diff > 0
    ? '<span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-amber-100 text-amber-800">over ' + money0(diff) + '</span>'
    : '<span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-rose-600 text-white">short ' + money0(-diff) + '</span>';
}

function renderDayClose() {
  if (!$('dcCards')) return;
  // Day Close is admin-only now — the nav tab is hidden from a supervisor,
  // and the API itself 403s them, so there is nothing useful to fetch here.
  if (!isAdmin()) return;
  var day = $('dcDate').value || todayISO();
  api('GET', '/dayclose?date=' + day + (isAdmin() ? '' : '&branch=' + S.branch))
    .then(function (d) {
      S.dcCurrent = { date: day, branches: d.branches };
      $('dcCards').innerHTML = d.branches.map(function (b) {
        var x = b.expectedBreakdown, c = b.close;
        var line = function (label, value, cls, hint) {
          return '<div class="flex justify-between py-1 text-sm"><span class="text-slate-500">' + label +
            (hint ? ' <span class="text-[10px] uppercase tracking-wide text-slate-400">' + hint + '</span>' : '') +
            '</span><span class="font-semibold num ' + (cls || '') + '">' + value + '</span></div>';
        };
        var diff = b.difference;
        return '<div class="card overflow-hidden" data-dcbranch="' + esc(b.branch) + '" data-dcexpected="' + b.expected + '">' +
          '<div class="px-5 py-3 bg-slate-100 flex flex-wrap items-center gap-2">' +
            '<h3 class="font-bold text-sm uppercase tracking-wide text-slate-700">' + esc(b.branchName) + '</h3>' +
            '<span class="text-xs text-slate-400">' + day + ' · ' + x.entries + ' entry(s), ' + x.approved + ' approved</span>' +
            '<span class="ml-auto">' + diffChip(diff) + '</span>' +
          '</div>' +
          '<div class="grid grid-cols-1 lg:grid-cols-2">' +
            '<div class="p-5 border-b lg:border-b-0 lg:border-r border-slate-100">' +
              '<p class="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">What should be in hand</p>' +
              line('Counter meat sales', money(x.counterSales)) +
              line('Live bird sales', money(x.liveSales)) +
              line('Cutting charges', money(x.cuttingCharges)) +
              line('Hotel / function — paid today', money(x.hotelCash), 'text-indigo-700') +
              (Math.abs(x.adjusted || 0) > 0.005 ? line('Admin billing adjustment for this day (net)',
                (x.adjusted >= 0 ? '+' : '−') + money(Math.abs(x.adjusted)), 'text-amber-700',
                'included above') : '') +
              line('Receipts against old bills', money(x.receipts), 'text-emerald-700') +
              line('Wages &amp; advances paid out', '−' + money(x.wagesPaid), 'text-rose-600') +
              line('Tea, tiffin &amp; shop costs', '−' + money(x.shopCosts), 'text-rose-600') +
              '<div class="border-t-2 border-slate-200 mt-2 pt-2 flex justify-between items-baseline">' +
                '<span class="font-bold text-slate-700">Expected handover</span>' +
                '<span class="font-bold num text-xl">' + money(b.expected) + '</span></div>' +
              '<p class="mt-2 text-[11px] text-slate-500 leading-snug">Revenue for the day was ' + money(x.revenue) +
                '. The ' + money(x.hotelCredit) + ' sold on account is not cash — it sits on the customer ledgers until they pay.</p>' +
              '<div class="mt-3 pt-3 border-t border-dashed border-slate-200">' +
                '<p class="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Cash + UPI + wages + overheads vs revenue</p>' +
                line('Wages today', money(b.wagesToday)) +
                line('Overheads today', money(b.overheadsToday)) +
                (c ? line('= handed over + wages + overheads', money(b.collectedTotal), 'font-bold') : '') +
                (c ? line('vs revenue ' + money(b.revenueToday), (b.revenueDifference > 0 ? '+' : '') + money(b.revenueDifference),
                    Math.abs(b.revenueDifference) < 0.5 ? 'text-emerald-700' : b.revenueDifference > 0 ? 'text-amber-700' : 'text-rose-600') : '') +
                (c && c.meatAdjustG
                  ? '<p class="mt-1 text-[11px] font-semibold ' + (c.meatAdjustG > 0 ? 'text-amber-700' : 'text-rose-600') + '">' +
                    (c.meatAdjustG > 0
                      ? 'Auto-credited ' + (c.meatAdjustG / 1000).toFixed(3) + ' kg extra meat sold (₹' + money0(c.meatAdjustAmount) + ').'
                      : 'Auto-reduced meat sales by ' + (-c.meatAdjustG / 1000).toFixed(3) + ' kg (₹' + money0(-c.meatAdjustAmount) + ').') +
                    '</p>'
                  : '') +
              '</div>' +
            '</div>' +
            '<div class="p-5">' +
              '<p class="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">What was handed over' +
                (isAdmin() ? '' : ' <span class="normal-case font-normal text-slate-400">— entered by an admin, view only</span>') +
              '</p>' +
              '<div class="grid grid-cols-2 gap-3">' +
                '<div><label class="lbl">Cash (₹)</label><input type="number" min="0" step="1" data-dc="cash" class="inp num" value="' + (c ? c.cash : '') + '"' + (isAdmin() ? '' : ' readonly tabindex="-1"') + ' /></div>' +
                '<div><label class="lbl">PhonePe / UPI (₹)</label><input type="number" min="0" step="1" data-dc="upi" class="inp num" value="' + (c ? c.upi : '') + '"' + (isAdmin() ? '' : ' readonly tabindex="-1"') + ' /></div>' +
              '</div>' +
              '<div><label class="lbl mt-3">Note</label><input data-dc="note" class="inp" placeholder="Optional" value="' + esc(c ? c.note : '') + '"' + (isAdmin() ? '' : ' readonly tabindex="-1"') + ' /></div>' +
              '<div class="mt-3 rounded-lg px-3 py-2 text-sm font-bold flex justify-between ' +
                (diff === null ? 'bg-slate-100 text-slate-600'
                  : Math.abs(diff) < 0.5 ? 'bg-emerald-50 text-emerald-800'
                  : diff > 0 ? 'bg-amber-50 text-amber-800' : 'bg-rose-50 text-rose-700') + '">' +
                '<span>Difference against expected</span>' +
                '<span class="num" data-dcdiff="1">' + (diff === null ? '—' : (diff > 0 ? '+' : '') + money(diff)) + '</span></div>' +
              (c && c.verifiedAt
                ? '<p class="mt-2 text-[11px] text-emerald-700 font-semibold"><i class="fa-solid fa-lock mr-1"></i>Verified by ' + esc(c.verifiedByName) + '</p>'
                : '') +
              (isAdmin()
                ? '<div class="flex flex-wrap gap-2 mt-3">' +
                    '<button data-dcsave="' + esc(b.branch) + '" class="bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-4 py-2.5 rounded-lg"><i class="fa-solid fa-floppy-disk mr-1"></i>' + (c ? 'Update handover' : 'Record handover') + '</button>' +
                    (c
                      ? '<button data-dcverify="' + esc(c.id) + '" data-reopen="' + (c.verifiedAt ? '1' : '') + '" class="border border-slate-300 text-slate-600 font-bold text-sm px-4 py-2.5 rounded-lg">' +
                        (c.verifiedAt ? 'Reopen' : 'Verify') + '</button>' +
                        '<button data-dcdelete="' + esc(c.id) + '" title="Delete this handover — the day goes back to not yet declared" class="border border-rose-300 text-rose-600 font-bold text-sm px-4 py-2.5 rounded-lg hover:bg-rose-50"><i class="fa-solid fa-trash mr-1"></i>Delete</button>'
                      : '') +
                  '</div>'
                : (c ? '' : '<p class="mt-3 text-[11px] text-slate-400 italic">Not declared yet — an admin still needs to enter this.</p>')) +
              (c ? '<p class="mt-2 text-[11px] text-slate-400">Declared by ' + esc(c.declaredByName) + ' at ' + String(c.declaredAt || '').slice(11, 16) + '</p>' : '') +
            '</div>' +
          '</div></div>';
      }).join('') || '<p class="text-sm text-slate-400 italic">No branches to close.</p>';
      renderDayCloseHistory();
    }).catch(apiFail);
}

function renderDayCloseHistory() {
  if (!$('dcHistBody')) return;
  // Admin only — see renderDayClose() above. A supervisor never sees the
  // nav badge either, since there is no history to flag for them any more.
  if (!isAdmin()) { var b = $('closeBadge'); if (b) b.classList.add('hidden'); return; }
  var from = $('dcFrom').value || addDays(todayISO(), -29);
  var to = $('dcTo').value || todayISO();
  api('GET', '/dayclose/history?from=' + from + '&to=' + to +
             (isAdmin() ? '' : '&branch=' + S.branch))
    .then(function (d) {
      var rows = d.rows, t = { expected: 0, declared: 0, diff: 0 }, missing = 0;
      $('dcHistBody').innerHTML = rows.length ? rows.map(function (r) {
        t.expected += r.expected;
        if (r.declared !== null) { t.declared += r.declared; t.diff += r.difference; }
        else missing++;
        return '<tr class="rowhover' + (r.missing ? ' bg-amber-50/40' : '') + '">' +
          '<td class="px-4 py-2.5 whitespace-nowrap font-semibold">' + r.date + '</td>' +
          '<td class="px-4 py-2.5 text-xs text-slate-500">' + esc(r.branchName) + '</td>' +
          '<td class="px-4 py-2.5 text-right num text-slate-500">' + money0(r.revenue) + '</td>' +
          '<td class="px-4 py-2.5 text-right num font-semibold">' + money0(r.expected) + '</td>' +
          '<td class="px-4 py-2.5 text-right num">' + (r.cash === null ? '—' : money0(r.cash)) + '</td>' +
          '<td class="px-4 py-2.5 text-right num">' + (r.upi === null ? '—' : money0(r.upi)) + '</td>' +
          '<td class="px-4 py-2.5 text-right num font-bold">' + (r.declared === null ? '—' : money0(r.declared)) + '</td>' +
          '<td class="px-4 py-2.5 text-right num font-bold ' +
            (r.difference === null ? 'text-slate-400'
              : Math.abs(r.difference) < 0.5 ? 'text-emerald-700'
              : r.difference > 0 ? 'text-amber-700' : 'text-rose-600') + '">' +
            (r.difference === null ? '—' : (r.difference > 0 ? '+' : '') + money0(r.difference)) + '</td>' +
          '<td class="px-4 py-2.5">' + diffChip(r.difference) +
            (r.verified ? ' <i class="fa-solid fa-lock text-emerald-600 text-[10px]"></i>' : '') + '</td>' +
          '<td class="px-4 py-2.5 text-right">' + (r.id
            ? '<button data-dchistdel="' + esc(r.id) + '" title="Delete this handover" class="h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-100"><i class="fa-solid fa-trash"></i></button>'
            : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="10" class="px-4 py-10 text-center text-slate-400">Nothing traded between ' + from + ' and ' + to + '.</td></tr>';

      $('dcHistNote').textContent = rows.length
        ? rows.length + ' day(s)' + (missing ? ' · ' + missing + ' not yet declared' : ' · all declared')
        : '';
      var tCash = 0, tUpi = 0;
      rows.forEach(function (r) { if (r.cash !== null) tCash += r.cash; if (r.upi !== null) tUpi += r.upi; });
      $('dcHistFoot').innerHTML = rows.length ? '<tr><td class="px-4 py-2.5" colspan="3">Totals</td>' +
        '<td class="px-4 py-2.5 text-right num">' + money0(t.expected) + '</td>' +
        '<td class="px-4 py-2.5 text-right num">' + money0(tCash) + '</td>' +
        '<td class="px-4 py-2.5 text-right num">' + money0(tUpi) + '</td>' +
        '<td class="px-4 py-2.5 text-right num">' + money0(t.declared) + '</td>' +
        '<td class="px-4 py-2.5 text-right num ' + (Math.abs(t.diff) < 0.5 ? 'text-emerald-700' : t.diff > 0 ? 'text-amber-700' : 'text-rose-600') + '">' +
        (t.diff > 0 ? '+' : '') + money0(t.diff) + '</td><td></td><td></td></tr>' : '';

      var badge = $('closeBadge');
      if (badge) {
        // A day counts as "needs attention" if it was never declared, or it
        // was declared but doesn't tally AND hasn't been verified yet.
        // Verifying is the admin's way of saying "I've looked at this
        // discrepancy, it's accounted for" — so it has to clear the flag,
        // otherwise the badge can never shrink for an off-balance day no
        // matter how many times someone verifies it.
        var bad = rows.filter(function (r) {
          return r.missing || (!r.verified && r.difference !== null && Math.abs(r.difference) >= 0.5);
        }).length;
        badge.textContent = bad;
        badge.classList.toggle('hidden', bad === 0);
      }
      S.closeHistory = rows;
      renderDayCloseBranchTotals(from, to);
      renderDayCloseGaps();
    }).catch(apiFail);
}

/* Cash handed over + PhonePe/UPI received, totalled per branch over
   whatever range dcFrom/dcTo (week, month, or a custom span) is showing —
   built from the same S.closeHistory renderDayCloseHistory() already
   fetched, no extra request. Only declared days count; a day nobody has
   declared yet has nothing to add. */
function renderDayCloseBranchTotals(from, to) {
  if (!$('dcBranchBody')) return;
  var by = {};
  (S.closeHistory || []).forEach(function (r) {
    if (r.declared === null) return;
    var b = by[r.branch] || (by[r.branch] = { name: r.branchName, days: 0, cash: 0, upi: 0 });
    b.days++; b.cash += num(r.cash); b.upi += num(r.upi);
  });
  var list = Object.keys(by).map(function (k) { return by[k]; })
    .sort(function (a, b) { return b.cash + b.upi - (a.cash + a.upi); });

  $('dcBranchNote').textContent = from && to ? from + ' → ' + to : '';
  $('dcBranchBody').innerHTML = list.length ? list.map(function (b) {
    return '<tr class="rowhover"><td class="px-4 py-2.5 font-semibold">' + esc(b.name) + '</td>' +
      '<td class="px-4 py-2.5 text-right num text-slate-500">' + b.days + '</td>' +
      '<td class="px-4 py-2.5 text-right num">' + money0(b.cash) + '</td>' +
      '<td class="px-4 py-2.5 text-right num">' + money0(b.upi) + '</td>' +
      '<td class="px-4 py-2.5 text-right num font-bold">' + money0(b.cash + b.upi) + '</td></tr>';
  }).join('') : '<tr><td colspan="5" class="px-4 py-10 text-center text-slate-400">Nothing declared in this range.</td></tr>';

  var t = { days: 0, cash: 0, upi: 0 };
  list.forEach(function (b) { t.days += b.days; t.cash += b.cash; t.upi += b.upi; });
  $('dcBranchFoot').innerHTML = list.length ? '<tr><td class="px-4 py-2.5">Totals</td>' +
    '<td class="px-4 py-2.5 text-right num">' + t.days + '</td>' +
    '<td class="px-4 py-2.5 text-right num">' + money0(t.cash) + '</td>' +
    '<td class="px-4 py-2.5 text-right num">' + money0(t.upi) + '</td>' +
    '<td class="px-4 py-2.5 text-right num">' + money0(t.cash + t.upi) + '</td></tr>' : '';
}

/* Two separate tables — days over, days short — built from the same history
   data already loaded by renderDayCloseHistory(), filterable to one branch
   or every branch someone can see. No extra request: it just re-slices
   S.closeHistory. */
function renderDayCloseGaps() {
  if (!$('dcGapBranch')) return;
  var sel = $('dcGapBranch');
  var codes = myBranches();
  var signature = codes.join(',');
  if (sel.getAttribute('data-filled') !== signature) {
    var cur = sel.value;
    sel.innerHTML = '<option value="">All branches</option>' +
      codes.map(function (k) { return '<option value="' + esc(k) + '">' + esc(S.branches[k]) + '</option>'; }).join('');
    sel.value = codes.indexOf(cur) >= 0 ? cur : '';
    sel.setAttribute('data-filled', signature);
  }
  var branch = sel.value;
  var rows = (S.closeHistory || []).filter(function (r) {
    return r.declared !== null && r.difference !== null && Math.abs(r.difference) >= 0.5
      && (!branch || r.branch === branch);
  });
  var byDate = function (a, b) { return a.date < b.date ? 1 : -1; };
  var excess = rows.filter(function (r) { return r.difference > 0; }).sort(byDate);
  var short = rows.filter(function (r) { return r.difference < 0; }).sort(byDate);

  var body = function (list, cls, none) {
    return list.length ? list.map(function (r) {
      return '<tr class="rowhover"><td class="px-4 py-2 whitespace-nowrap font-semibold">' + r.date + '</td>' +
        '<td class="px-4 py-2 text-xs text-slate-500">' + esc(r.branchName) + '</td>' +
        '<td class="px-4 py-2 text-right num font-bold ' + cls + '">' + money0(Math.abs(r.difference)) + '</td></tr>';
    }).join('') : '<tr><td colspan="3" class="px-4 py-6 text-center text-slate-400">' + none + '</td></tr>';
  };
  var scope = branch ? (S.branches[branch] || branch) : 'any branch';
  $('dcExcessBody').innerHTML = body(excess, 'text-amber-700', 'No excess handovers for ' + esc(scope) + '.');
  $('dcShortBody').innerHTML = body(short, 'text-rose-600', 'No short handovers for ' + esc(scope) + '.');

  var sumExcess = excess.reduce(function (s, r) { return s + r.difference; }, 0);
  var sumShort = short.reduce(function (s, r) { return s + Math.abs(r.difference); }, 0);
  $('dcExcessFoot').innerHTML = excess.length
    ? '<tr><td class="px-4 py-2" colspan="2">Total (' + excess.length + ')</td>' +
      '<td class="px-4 py-2 text-right num text-amber-700">' + money0(sumExcess) + '</td></tr>' : '';
  $('dcShortFoot').innerHTML = short.length
    ? '<tr><td class="px-4 py-2" colspan="2">Total (' + short.length + ')</td>' +
      '<td class="px-4 py-2 text-right num text-rose-600">' + money0(sumShort) + '</td></tr>' : '';
  $('dcGapNote').textContent = rows.length + ' day(s) out of tally' +
    (branch ? ' · ' + esc(S.branches[branch] || branch) : ' · all branches');
}

function saveDayClose(branchCode) {
  var card = document.querySelector('[data-dcbranch="' + branchCode + '"]');
  if (!card) return;
  var g = function (k) { return card.querySelector('[data-dc="' + k + '"]'); };
  var key = 'dc:' + branchCode;
  var btn = card.querySelector('[data-dcsave]');
  var ctx = spinGuard(key, btn);
  if (!ctx) return;
  api('POST', '/dayclose', { branch: branchCode, date: $('dcDate').value || todayISO(),
    cash: num(g('cash').value), upi: num(g('upi').value), note: g('note').value })
    .then(function (r) {
      var d = r.difference;
      toast(Math.abs(d) < 0.5 ? 'Handover recorded — it tallies.'
        : d > 0 ? 'Recorded. ' + money0(d) + ' MORE than expected.'
                : 'Recorded. ' + money0(-d) + ' SHORT of expected.',
        Math.abs(d) < 0.5 ? 'success' : 'warn');
    })
    .then(function () {
      renderDayClose();
      if (typeof recalc === 'function') recalc();
      if (typeof renderDashboard === 'function') renderDashboard();
    })
    .catch(apiFail)
    .then(function () { spinRelease(key, ctx); });
}

/* ---------------- overhead ledger ---------------- */
function renderOverheadLedger() {
  if (!$('ovhDayBody') || !isAdmin()) return;
  var from = $('ovhFrom').value || monthStart();
  var to = $('ovhTo').value || todayISO();
  var scope = S.ovhScope === 'all' ? '' : '&branch=' + S.branch;
  api('GET', '/overheads?from=' + from + '&to=' + to + scope)
    .then(function (d) {
      S.ovhLedger = d;
      $('ovhDayBody').innerHTML = d.byDay.length ? d.byDay.map(function (r) {
        var split = Object.keys(r.branches).sort().map(function (b) {
          return '<span class="inline-block text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-slate-100 text-slate-700 mr-1">' +
            esc(b) + ' ' + money0(r.branches[b]) + '</span>';
        }).join('');
        return '<tr class="rowhover"><td class="px-4 py-2 whitespace-nowrap font-semibold">' + r.date + '</td>' +
          '<td class="px-4 py-2">' + split + '</td>' +
          '<td class="px-4 py-2 text-right num font-bold text-rose-700">' + money0(r.total) + '</td></tr>';
      }).join('') : '<tr><td colspan="3" class="px-4 py-10 text-center text-slate-400">No approved overheads between ' + from + ' and ' + to + '.</td></tr>';

      $('ovhDayFoot').innerHTML = d.byDay.length
        ? '<tr><td class="px-4 py-2.5" colspan="2">Total ' + from + ' → ' + to + '</td>' +
          '<td class="px-4 py-2.5 text-right num">' + money0(d.total) + '</td></tr>' : '';

      $('ovhByBranch').innerHTML = d.byBranch.length ? d.byBranch.map(function (b) {
        return '<div class="rounded-lg bg-white border border-slate-200 px-3 py-2">' +
          '<div class="flex justify-between"><span class="font-semibold">' + esc(b.name) + '</span>' +
          '<span class="font-bold num text-rose-700">' + money0(b.total) + '</span></div>' +
          '<p class="text-[11px] text-slate-400">' + money0(b.monthly) + ' spread · ' + money0(b.dated) + ' dated</p></div>';
      }).join('') : '<p class="text-xs text-slate-400 italic">Nothing in this range.</p>';

      $('ovhLedgerNote').textContent = d.byDay.length
        ? 'Dated costs land on their own day in full. Monthly ones are divided by the days in that month, so ' +
          money0(d.total) + ' across ' + d.byDay.length + ' day(s) is what the daily profit figures already carry.'
        : 'Add an overhead with a date to charge it to one day, or leave the date blank to spread it over the month.';
    }).catch(apiFail);
}

/* ---------------- worker ledger — itemized log, date range + filters ---------------- */
function renderLedgerLog() {
  if (!$('ledgerBody') || !isAdmin() || !S.branch) return;
  var from = $('wkFrom').value || monthStart();
  var to = $('wkTo').value || todayISO();
  var workerId = $('wkWorkerFilter') ? $('wkWorkerFilter').value : '';
  var type = $('wkTypeFilter') ? $('wkTypeFilter').value : '';
  var qs = '/ledger?branch=' + encodeURIComponent(S.branch) + '&from=' + from + '&to=' + to
    + (workerId ? '&workerId=' + encodeURIComponent(workerId) : '')
    + (type ? '&type=' + encodeURIComponent(type) : '');
  api('GET', qs).then(function (d) {
    S.wkLedger = d;
    var rows = d.rows || [];
    $('ledgerBody').innerHTML = rows.length ? rows.map(function (l) {
      var def = LEDGER_TYPES[l.type] || { t: l.type, effect: 'none' };
      var eff = def.effect === 'earn' ? ['bg-emerald-100 text-emerald-800', 'Adds to balance']
        : def.effect === 'settle' ? ['bg-slate-200 text-slate-700', 'Reduces balance']
        : ['bg-amber-100 text-amber-800', 'Company paid — not deducted'];
      return '<tr class="rowhover"><td class="px-4 py-2.5 whitespace-nowrap">' + l.date + '</td>' +
        '<td class="px-4 py-2.5">' + esc(l.workerName || '—') + '</td>' +
        '<td class="px-4 py-2.5 text-slate-600">' + esc(def.t) + (l.type === 'work' ? ' (' + num(l.days) + 'd)' : '') + '</td>' +
        '<td class="px-4 py-2.5 text-slate-500 text-xs">' + esc(l.note || '') + '</td>' +
        '<td class="px-4 py-2.5 text-right num font-semibold">' + money0(l.amount) + '</td>' +
        '<td class="px-4 py-2.5"><span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full ' + eff[0] + '">' + eff[1] + '</span></td>' +
        '<td class="px-4 py-2.5 text-right whitespace-nowrap">' +
          ((isAdmin() || l.type === 'work') ? '<button data-lact="edit" data-id="' + l.id + '" title="Edit" class="h-8 w-8 rounded-lg text-slate-600 hover:bg-slate-100"><i class="fa-solid fa-pen-to-square"></i></button>' : '') +
          '<button data-lact="del" data-id="' + l.id + '" title="Delete" class="h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-100"><i class="fa-solid fa-trash"></i></button></td></tr>';
    }).join('') : '<tr><td colspan="7" class="px-4 py-10 text-center text-slate-400">No ledger entries between ' + from + ' and ' + to + '.</td></tr>';

    var s = d.summary || {};
    $('ledgerFoot').innerHTML = rows.length
      ? '<tr><td class="px-4 py-2.5" colspan="4">Totals ' + from + ' → ' + to + ' · ' + (s.count || 0) + ' entr' + (s.count === 1 ? 'y' : 'ies') + '</td>' +
        '<td class="px-4 py-2.5 text-right num">' + money0(s.work || 0) + ' earned</td>' +
        '<td class="px-4 py-2.5" colspan="2">−' + money0(s.deducted || 0) + ' paid out · net ' + money0(s.net || 0) + '</td></tr>'
      : '';
    $('wkLedgerNote').textContent = rows.length
      ? money0(s.advance || 0) + ' in advances, ' + money0(s.paid || 0) + ' paid, ' +
        money0((s.tea || 0) + (s.tiffin || 0) + (s.other || 0)) + ' tea/tiffin/other in this range.'
      : 'Pick a date range to see wage, advance, payment and deduction entries.';
  }).catch(apiFail);
}

/* Per-branch, per-supplier bird-purchase ledger — admin only. Mirrors
   renderLedgerLog() above: fetch on filter change, keep the raw response on
   S so Print/Excel can read the exact same rows without re-fetching. */
function renderPurchaseLedger(){
  if(!$('plBody') || !isAdmin() || !S.branch) return;
  $('plBranchLabel').textContent=S.branches[S.branch]||S.branch;
  var from=$('plFrom').value || monthStart();
  var to=$('plTo').value || todayISO();
  api('GET','/purchase-ledger?branch='+encodeURIComponent(S.branch)+'&from='+from+'&to='+to).then(function(d){
    S.purchaseLedger=d;
    var sup=d.suppliers||[];
    $('plBody').innerHTML=sup.length ? sup.map(function(s){
      return '<tr class="rowhover"><td class="px-4 py-2.5 font-semibold">'+esc(s.supplier)+'</td>'+
        '<td class="px-4 py-2.5 text-right num">'+s.boughtBirds+'</td>'+
        '<td class="px-4 py-2.5 text-right num">'+fmtW(s.boughtWtG)+'</td>'+
        '<td class="px-4 py-2.5 text-right num">'+money0(s.boughtAmt)+'</td>'+
        '<td class="px-4 py-2.5 text-right num'+(s.returnedBirds?' text-rose-700':'')+'">'+s.returnedBirds+'</td>'+
        '<td class="px-4 py-2.5 text-right num'+(s.returnedBirds?' text-rose-700':'')+'">'+fmtW(s.returnedWtG)+'</td>'+
        '<td class="px-4 py-2.5 text-right num'+(s.returnedBirds?' text-rose-700':'')+'">'+money0(s.returnedAmt)+'</td>'+
        '<td class="px-4 py-2.5 text-right num font-bold">'+s.netBirds+'</td>'+
        '<td class="px-4 py-2.5 text-right num font-bold">'+fmtW(s.netWtG)+'</td>'+
        '<td class="px-4 py-2.5 text-right num font-bold">'+money0(s.netAmt)+'</td></tr>';
    }).join('') : '<tr><td colspan="10" class="px-4 py-10 text-center text-slate-400">No purchases between '+from+' and '+to+'.</td></tr>';

    var tot=sup.reduce(function(a,s){ a.bb+=s.boughtBirds; a.bw+=s.boughtWtG; a.ba+=s.boughtAmt;
      a.rb+=s.returnedBirds; a.rw+=s.returnedWtG; a.ra+=s.returnedAmt;
      a.nb+=s.netBirds; a.nw+=s.netWtG; a.na+=s.netAmt; return a; },
      {bb:0,bw:0,ba:0,rb:0,rw:0,ra:0,nb:0,nw:0,na:0});
    $('plFoot').innerHTML=sup.length ? '<tr><td class="px-4 py-2.5">Totals · '+sup.length+' supplier(s)</td>'+
      '<td class="px-4 py-2.5 text-right num">'+tot.bb+'</td><td class="px-4 py-2.5 text-right num">'+fmtW(tot.bw)+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+money0(tot.ba)+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+tot.rb+'</td><td class="px-4 py-2.5 text-right num">'+fmtW(tot.rw)+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+money0(tot.ra)+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+tot.nb+'</td><td class="px-4 py-2.5 text-right num">'+fmtW(tot.nw)+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+money0(tot.na)+'</td></tr>' : '';
    $('plNote').textContent=sup.length ? sup.length+' supplier(s) · '+from+' to '+to : 'Pick a date range to see purchases and returns.';

    var txns=d.transactions||[];
    $('plTxnBody').innerHTML=txns.length ? txns.slice().reverse().map(function(t){
      var isRet=t.kind==='return';
      return '<tr class="rowhover'+(isRet?' bg-rose-50':'')+'"><td class="px-4 py-2.5 whitespace-nowrap">'+t.date+'</td>'+
        '<td class="px-4 py-2.5">'+esc(t.supplier)+'</td>'+
        '<td class="px-4 py-2.5">'+(isRet?'<span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-rose-100 text-rose-800">Return</span>':'<span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-emerald-100 text-emerald-800">Buy</span>')+'</td>'+
        '<td class="px-4 py-2.5 text-right num">'+(isRet?'−':'')+t.birds+'</td>'+
        '<td class="px-4 py-2.5 text-right num">'+(isRet?'−':'')+fmtW(t.wtG)+'</td>'+
        '<td class="px-4 py-2.5 text-right num">'+money0(t.rate)+'</td>'+
        '<td class="px-4 py-2.5 text-right num'+(isRet?' text-rose-700':'')+'">'+(isRet?'−':'')+money0(t.amount)+'</td></tr>';
    }).join('') : '<tr><td colspan="7" class="px-4 py-10 text-center text-slate-400">No transactions in this range.</td></tr>';
  }).catch(apiFail);
}

/* Feed purchase ledger — the same by-supplier + transactions shape as the
   bird purchase ledger above, except there is exactly one feed purchase row
   per daily entry (feedBags/feedRate/feedSupplier are plain fields on the
   entry, not a separate line-item list), and feed is only ever bought,
   never returned, so there's no bought/returned/net split. */
function renderFeedLedger(){
  if(!$('flBody') || !isAdmin() || !S.branch) return;
  $('flBranchLabel').textContent=S.branches[S.branch]||S.branch;
  var from=$('flFrom').value || monthStart();
  var to=$('flTo').value || todayISO();
  api('GET','/feed-ledger?branch='+encodeURIComponent(S.branch)+'&from='+from+'&to='+to).then(function(d){
    S.feedLedger=d;
    var sup=d.suppliers||[];
    $('flBody').innerHTML=sup.length ? sup.map(function(s){
      return '<tr class="rowhover"><td class="px-4 py-2.5 font-semibold">'+esc(s.supplier)+'</td>'+
        '<td class="px-4 py-2.5 text-right num">'+s.bags+'</td>'+
        '<td class="px-4 py-2.5 text-right num">'+money0(s.amt)+'</td></tr>';
    }).join('') : '<tr><td colspan="3" class="px-4 py-10 text-center text-slate-400">No feed purchases between '+from+' and '+to+'.</td></tr>';

    var tot=sup.reduce(function(a,s){ a.bags+=s.bags; a.amt+=s.amt; return a; }, {bags:0,amt:0});
    $('flFoot').innerHTML=sup.length ? '<tr><td class="px-4 py-2.5">Totals · '+sup.length+' supplier(s)</td>'+
      '<td class="px-4 py-2.5 text-right num">'+tot.bags+'</td>'+
      '<td class="px-4 py-2.5 text-right num">'+money0(tot.amt)+'</td></tr>' : '';
    $('flNote').textContent=sup.length ? sup.length+' supplier(s) · '+from+' to '+to : 'Pick a date range to see feed purchases.';

    var txns=d.transactions||[];
    $('flTxnBody').innerHTML=txns.length ? txns.slice().reverse().map(function(t){
      return '<tr class="rowhover"><td class="px-4 py-2.5 whitespace-nowrap">'+t.date+'</td>'+
        '<td class="px-4 py-2.5 text-xs text-slate-500 capitalize">'+esc(t.category)+'</td>'+
        '<td class="px-4 py-2.5">'+esc(t.supplier)+'</td>'+
        '<td class="px-4 py-2.5 text-right num">'+t.bags+'</td>'+
        '<td class="px-4 py-2.5 text-right num">'+money0(t.rate)+'</td>'+
        '<td class="px-4 py-2.5 text-right num">'+money0(t.amount)+'</td></tr>';
    }).join('') : '<tr><td colspan="6" class="px-4 py-10 text-center text-slate-400">No transactions in this range.</td></tr>';
  }).catch(apiFail);
}

/* ---------------- labour ---------------- */
function markAttendance(workerId, days) {
  var date = $('wkDate').value || todayISO();
  var w = S.workers.filter(function (x) { return x.id === workerId; })[0]; if (!w) return;
  var key = 'att:' + workerId + ':' + date;
  if (!once(key)) return;                       // the same tap arriving twice
  qsa('[data-att="' + workerId + '"]').forEach(function (b) { b.disabled = true; });
  api('POST', '/ledger', { branch: w.branch, workerId: workerId, date: date, type: 'work', days: days })
    .then(function () { return bootstrap(); })
    .then(function () { renderWorkers(); recalc(); renderDashboard(); })
    .catch(apiFail)
    .then(function () { done(key); });
}

/* A supervisor or admin can quote a worker a different rate for one day —
   e.g. everyone wants extra on a Sunday — without touching the worker's
   standing day_wage. This only changes the ledger row for that date. */
function adjustWage(workerId) {
  var date = $('wkDate').value || todayISO();
  var w = S.workers.filter(function (x) { return x.id === workerId; })[0]; if (!w) return;
  var existing = S.ledger.filter(function (x) { return x.workerId === workerId && x.date === date && x.type === 'work'; })[0];
  var days = existing ? num(existing.days) : 1;
  var suggestion = existing ? num(existing.amount) : (num(w.dayWage) * days);
  var val = prompt('Wage for ' + w.name + ' on ' + date + ' (standard rate ' + money0(w.dayWage) + '/day, ' + days + ' day(s)):',
    suggestion || w.dayWage);
  if (val === null) return;
  var amt = parseFloat(val);
  if (!(amt > 0)) { toast('Enter a valid amount.', 'error'); return; }
  var key = 'wageadj:' + workerId + ':' + date;
  if (!once(key)) return;
  api('POST', '/ledger', { branch: w.branch, workerId: workerId, date: date, type: 'work',
    days: days || 1, wageOverride: amt })
    .then(function () { return bootstrap(); })
    .then(function () { renderWorkers(); recalc(); renderDashboard(); toast('Wage set to ' + money0(amt) + ' for ' + date + '.'); })
    .catch(apiFail)
    .then(function () { done(key); });
}

/* Correct an already-recorded wage/deduction row instead of deleting and
   re-adding it. An admin can edit any row, any date; a supervisor may only
   correct a 'work' (wage) row dated today, matching what the server allows
   — this table itself is admin-only in the UI, so this is a backstop, not
   the primary gate. No separate history is kept — this overwrites the row,
   like any other edit in the app. */
function editLedgerRow(id) {
  // The itemized ledger log can show entries outside bootstrap()'s loaded
  // window (its own from/to range hits the server directly) — fall back to
  // that freshly-fetched set if the row isn't in the bootstrap-loaded S.ledger.
  var row = S.ledger.filter(function (x) { return x.id === id; })[0]
    || (S.wkLedger && S.wkLedger.rows.filter(function (x) { return x.id === id; })[0]);
  if (!row) return;
  if (!isAdmin() && row.type !== 'work') { toast('Only an admin can edit this entry.', 'error'); return; }
  if (!isAdmin() && row.date !== todayISO()) { toast('Only today’s entries can be edited.', 'error'); return; }
  var w = S.workers.filter(function (x) { return x.id === row.workerId; })[0];
  var val = prompt('Amount for ' + (w ? w.name : 'this entry') + ' — ' + row.type + ' · ' + row.date + ':', row.amount);
  if (val === null) return;
  var amt = parseFloat(val);
  if (!(amt > 0)) { toast('Enter a valid amount.', 'error'); return; }
  var key = 'ledgeredit:' + id;
  if (!once(key)) return;
  var body = { amount: amt };
  if (row.type === 'work') body.days = row.days;
  api('PUT', '/ledger/' + id, body)
    .then(function () { return bootstrap(); })
    .then(function () { renderWorkers(); recalc(); renderDashboard(); toast('Entry updated.'); })
    .catch(apiFail)
    .then(function () { done(key); });
}

function workerModal(w) {
  w = w || {};
  var showBalance = isAdmin() && w.id;
  var st = w.id ? workerStats(w.id) : null;
  openGen(w.id ? 'Edit worker' : 'Add worker',
    '<div class="space-y-3">' +
    '<div><label class="lbl" for="wkName">Name</label><input id="wkName" class="inp" value="' + esc(w.name || '') + '" /></div>' +
    '<div class="grid grid-cols-2 gap-3">' +
    '<div><label class="lbl" for="wkRole">Role</label><select id="wkRole" class="inp">' +
    ['dresser', 'cutter', 'helper', 'cashier', 'driver'].map(function (r) { return '<option value="' + r + '"' + (w.role === r ? ' selected' : '') + '>' + r.charAt(0).toUpperCase() + r.slice(1) + '</option>'; }).join('') + '</select></div>' +
    '<div><label class="lbl" for="wkWage">Wage per day (₹)</label><input type="number" min="0" step="10" id="wkWage" class="inp num" value="' + (w.dayWage || S.settings.dayWage || '') + '" /></div>' +
    '</div>' +
    '<div><label class="lbl" for="wkPhone">Phone (optional)</label><input id="wkPhone" class="inp" value="' + esc(w.phone || '') + '" /></div>' +
    (showBalance
      ? '<div class="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">' +
        '<p class="text-[11px] font-bold uppercase tracking-wider text-amber-800">Balance correction — admin only</p>' +
        '<p class="text-xs text-slate-500">Ledger balance due is ' + money0(st.earned - st.paid - st.ded) +
          '. Current correction ' + money0(st.adj) + ' makes it ' + money0(st.balance) + '.</p>' +
        '<div class="grid grid-cols-2 gap-3">' +
          '<div><label class="lbl" for="wkAdj">Correction (₹, +/-)</label><input type="number" step="1" id="wkAdj" class="inp num" value="' + (w.balanceAdjustment || 0) + '" /></div>' +
          '<div><label class="lbl" for="wkAdjNote">Reason</label><input id="wkAdjNote" class="inp" placeholder="Optional" value="' + esc(w.balanceNote || '') + '" /></div>' +
        '</div>' +
        '<p class="text-[11px] text-slate-400">Positive raises what is owed to them; negative lowers it (a write-off, a shortage taken out).</p>' +
      '</div>'
      : '') +
    '<button id="wkSave" class="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg mt-2">Save worker</button></div>');
  bind('wkSave', function () {
    var name = tv('wkName');
    if (!name) { toast('Enter a name.', 'error'); return; }
    if (v('wkWage') <= 0) { toast('Enter the daily wage.', 'error'); return; }
    var body = { branch: S.branch, name: name, role: tv('wkRole'), dayWage: v('wkWage'), phone: tv('wkPhone') };
    if (showBalance) { body.balanceAdjustment = v('wkAdj'); body.balanceNote = tv('wkAdjNote'); }
    if (!once('wkSave')) return;
    var p = w.id ? api('PUT', '/workers/' + w.id, body) : api('POST', '/workers', body);
    p.then(function () { return bootstrap(); })
      .then(function () { closeModal('genModal'); renderWorkers(); toast('Worker saved.'); })
      .catch(function (err) {
        if (err && err.payload && err.payload.error === 'duplicate') {
          toast(err.message, 'warn');
          closeModal('genModal');
          return;
        }
        apiFail(err);
      })
      .then(function () { done('wkSave'); });
  });
}

/* Give a worker an advance on a chosen date. The amount comes off that
   day's profit and shows on the dashboard beside the overheads. */
function advanceModal(workerId) {
  var w = S.workers.filter(function (x) { return x.id === workerId; })[0];
  if (!w) return;
  var st = workerStats(w.id);
  openGen('Advance to ' + w.name,
    '<div class="space-y-3">' +
    '<div class="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600">' +
      '<b>' + esc(w.name) + '</b> · ' + esc(w.role) + ' · ' + money0(w.dayWage) + '/day<br>' +
      'Days worked ' + st.days + ' · earned ' + money0(st.earned) +
      ' · balance due <b>' + money0(st.balance) + '</b></div>' +
    '<div class="grid grid-cols-2 gap-3">' +
      '<div><label class="lbl" for="advDate" title="Date the advance was actually handed over">Date taken</label><input type="date" id="advDate" class="inp" value="' + todayISO() + '"' + (isAdmin() ? '' : ' disabled title="Supervisors can only record today’s advances."') + ' /></div>' +
      '<div><label class="lbl" for="advAmt">Advance (₹)</label><input type="number" min="0" step="10" id="advAmt" class="inp num" /></div>' +
    '</div>' +
    '<div><label class="lbl" for="advNote">Note</label><input id="advNote" class="inp" placeholder="Optional" /></div>' +
    '<p class="text-xs rounded-lg px-3 py-2 bg-amber-50 text-amber-800 border border-amber-200 font-semibold">' +
      'Deducted from that day&rsquo;s profit and shown on the dashboard as “Advances paid”. ' +
      'It also reduces what the worker is still owed.</p>' +
    '<button id="advSave" class="w-full bg-amber-500 hover:bg-amber-600 text-emerald-900 font-bold text-sm px-5 py-2.5 rounded-lg">Record advance</button></div>');
  bind('advSave', function () {
    if (v('advAmt') <= 0) { toast('Enter an amount.', 'error'); return; }
    if (!once('advSave')) return;
    var amt = v('advAmt');
    api('POST', '/ledger', { branch: w.branch, workerId: w.id, date: tv('advDate'),
      type: 'advance', amount: amt, note: tv('advNote') })
      .then(function () { return bootstrap(); })
      .then(function () {
        closeModal('genModal'); renderWorkers(); recalc(); renderDashboard();
        toast('Advance of ' + money0(amt) + ' recorded.');
      })
      .catch(dupAware('advSave'))
      .then(function () { done('advSave'); });
  });
}

function ledgerModal(kind, preWorker) {
  var ws = branchWorkers();
  if (!ws.length) { toast('Add a worker first.', 'warn'); return; }
  var types = kind === 'pay' ? ['paid', 'advance'] : ['tea', 'tiffin', 'advance', 'other'];
  openGen(kind === 'pay' ? 'Record payment' : 'Log expense',
    '<div class="space-y-3">' +
    '<div class="grid grid-cols-2 gap-3">' +
    '<div><label class="lbl" for="lgWorker">Worker</label><select id="lgWorker" class="inp">' + ws.map(function (x) { return '<option value="' + x.id + '"' + (preWorker === x.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></div>' +
    '<div><label class="lbl" for="lgDate" title="Date the payment/expense actually happened">Date</label><input type="date" id="lgDate" class="inp" value="' + todayISO() + '"' + (isAdmin() ? '' : ' disabled title="Supervisors can only record today’s entries."') + ' /></div>' +
    '</div>' +
    '<div class="grid grid-cols-2 gap-3">' +
    '<div><label class="lbl" for="lgType">Type</label><select id="lgType" class="inp">' + types.map(function (t) { return '<option value="' + t + '">' + LEDGER_TYPES[t].t + '</option>'; }).join('') + '</select></div>' +
    '<div><label class="lbl" for="lgAmt">Amount (₹)</label><input type="number" min="0" step="1" id="lgAmt" class="inp num" /></div>' +
    '</div>' +
    '<div><label class="lbl" for="lgNote">Note</label><input id="lgNote" class="inp" placeholder="Optional" /></div>' +
    '<p id="lgHint" class="text-xs rounded-lg px-3 py-2 font-semibold border"></p>' +
    '<button id="lgSave" class="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg">Save</button></div>');
  var upd = function () {
    var t = tv('lgType'), def = LEDGER_TYPES[t], hEl = $('lgHint');
    if (def.effect === 'settle') { hEl.className = 'text-xs rounded-lg px-3 py-2 font-semibold border bg-slate-100 text-slate-700 border-slate-300'; hEl.textContent = 'Reduces the worker’s outstanding balance.'; }
    else { hEl.className = 'text-xs rounded-lg px-3 py-2 font-semibold border bg-emerald-50 text-emerald-800 border-emerald-200'; hEl.textContent = 'Paid by the shop — NOT deducted from the worker’s wages. Counts as a shop expense in the P&L.'; }
  };
  $('lgType').addEventListener('change', upd); upd();
  bind('lgSave', function () {
    if (v('lgAmt') <= 0) { toast('Enter an amount.', 'error'); return; }
    if (!once('lgSave')) return;
    api('POST', '/ledger', { branch: S.branch, workerId: tv('lgWorker'), date: tv('lgDate'),
      type: tv('lgType'), amount: v('lgAmt'), note: tv('lgNote') })
      .then(function () { return bootstrap(); })
      .then(function () { closeModal('genModal'); renderWorkers(); recalc(); renderDashboard(); toast('Saved.'); })
      .catch(dupAware('lgSave'))
      .then(function () { done('lgSave'); });
  });
}

/* ---------------- overheads ---------------- */
function overheadModal() {
  openGen('Add a monthly overhead',
    '<div class="space-y-3">' +
    '<div><label class="lbl" for="ovWhen">How is this cost charged?</label><select id="ovWhen" class="inp">' +
      '<option value="month">Standing monthly cost — spread over the month (rent, power, salary)</option>' +
      '<option value="date">Spent on one day — charge it to that day (repair, delivery)</option>' +
    '</select></div>' +
    '<div class="grid grid-cols-2 gap-3">' +
    '<div id="ovMonthWrap"><label class="lbl" for="ovMonth">Month</label><input type="month" id="ovMonth" class="inp" value="' + ($('ovhMonth').value || todayISO().slice(0, 7)) + '" /></div>' +
    '<div id="ovDateWrap" class="hidden"><label class="lbl" for="ovDate" title="Supervisors can only charge a cost to today">Date spent</label><input type="date" id="ovDate" class="inp" value="' + todayISO() + '"' + (isAdmin() ? '' : ' disabled') + ' /></div>' +
    '<div><label class="lbl" for="ovAmt">Amount (₹)</label><input type="number" min="0" step="1" id="ovAmt" class="inp num" /></div>' +
    '</div>' +
    '<div><label class="lbl" for="ovCat">Category</label><select id="ovCat" class="inp">' +
    OVERHEAD_CATS.map(function (c) { return '<option value="' + c.v + '">' + c.t + '</option>'; }).join('') + '</select></div>' +
    '<div><label class="lbl" for="ovNote">Note / bill reference</label><input id="ovNote" class="inp" placeholder="e.g. electricity bill 4412, August" /></div>' +
    '<p id="ovHint" class="text-xs rounded-lg px-3 py-2 font-semibold border"></p>' +
    '<button id="ovSave" class="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg">Submit for approval</button></div>');

  var updWhen = function () {
    var dated = tv('ovWhen') === 'date', h = $('ovHint');
    $('ovMonthWrap').classList.toggle('hidden', dated);
    $('ovDateWrap').classList.toggle('hidden', !dated);
    if (dated) {
      h.className = 'text-xs rounded-lg px-3 py-2 font-semibold border bg-rose-50 text-rose-700 border-rose-200';
      h.textContent = 'The whole amount is charged to that one day, so that day\u2019s profit carries it in full.';
    } else {
      h.className = 'text-xs rounded-lg px-3 py-2 font-semibold border bg-amber-50 text-amber-800 border-amber-200';
      h.textContent = 'Divided by the number of days in the month, so every trading day carries an equal share.';
    }
  };
  $('ovWhen').addEventListener('change', updWhen); updWhen();

  bind('ovSave', function () {
    if (v('ovAmt') <= 0) { toast('Enter an amount.', 'error'); return; }
    var dated = tv('ovWhen') === 'date';
    if (!once('ovSave')) return;
    api('POST', '/overheads', { branch: S.branch,
      month: dated ? '' : tv('ovMonth'), date: dated ? tv('ovDate') : '',
      category: tv('ovCat'), amount: v('ovAmt'), note: tv('ovNote') })
      .then(function (rec) {
        S.overheads.push(rec);
        closeModal('genModal'); $('ovhMonth').value = rec.month;
        renderOverheads(); renderOverheadLedger(); renderDashboard();
        toast(isAdmin() ? 'Overhead recorded.' : 'Sent to admin for approval.');
      }).catch(apiFail).then(function () { done('ovSave'); });
  });
}

function decideOverhead(id, verdict, reason) {
  api('POST', '/overheads/' + id + '/decision', { verdict: verdict, reason: reason || '' })
    .then(function (rec) {
      var i = S.overheads.findIndex(function (x) { return x.id === rec.id; });
      if (i >= 0) S.overheads[i] = rec;
      renderOverheads(); renderDashboard();
      toast(verdict === 'approved' ? 'Overhead approved — charged at month end.' : 'Overhead returned.',
        verdict === 'approved' ? 'success' : 'warn');
    }).catch(apiFail);
}

/* ---------------- boot & wiring ---------------- */
function startApp(user, fresh) {
  S.user = user;
  $('loginScreen').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  // Come back to the same branch this browser was last looking at — before
  // refreshBranchSelects() below, so it validates/applies it the same way
  // it would any other branch switch (falls back to the first one this
  // user can see if the saved branch no longer applies to them).
  var savedBranch = LS.get(K.lastBranch);
  if (savedBranch) S.branch = savedBranch;
  applyRbac(); refreshBranchSelects();
  $('dashFrom').value = monthStart(); $('dashTo').value = todayISO();
  // A supervisor only ever has today's entry to look at, so there is no
  // range to pick — pin and lock the Records filters rather than let them
  // select a range that will just come back empty.
  $('recFrom').value = isAdmin() ? addDays(todayISO(), -30) : todayISO();
  $('recTo').value = todayISO();
  $('recFrom').disabled = !isAdmin(); $('recTo').disabled = !isAdmin();
  $('recFrom').title = $('recTo').title = isAdmin() ? '' : 'Supervisors can only see today’s entry.';
  $('wkDate').value = todayISO();
  $('wkFrom').value = monthStart(); $('wkTo').value = todayISO();
  $('dwFrom').value = monthStart(); $('dwTo').value = todayISO();
  $('ovhMonth').value = todayISO().slice(0, 7);
  $('ovhFrom').value = monthStart(); $('ovhTo').value = todayISO();
  $('dcDate').value = todayISO();
  $('dcFrom').value = addDays(todayISO(), -29); $('dcTo').value = todayISO();
  $('plFrom').value = monthStart(); $('plTo').value = todayISO();
  renderDayCloseHistory();
  if (isAdmin()) $('recStatus').value = 'pending';
  bumpActivity(); tickSession();
  syncSegs(); updatePendingBadge();
  // '' means "was deliberately a blank new entry" and restores as such;
  // null/undefined (never saved before) also falls through to blank. Either
  // way this replaces the old hardcoded loadEntry(null) — a refresh no
  // longer drops whatever record was open back to a blank form.
  var savedEntry = LS.get(K.lastEntry);
  loadEntry(savedEntry ? savedEntry : null);
  // Same idea for which screen was open — a plain page refresh used to
  // always land back on the Dashboard (or the Entry screen for a
  // supervisor) no matter what tab was actually open. Only trust a saved
  // name that's still a real, currently-rendered view; showView() itself
  // still applies the role redirects (dashboard/dayclose/purchases away
  // from a supervisor) on top of whatever this resolves to.
  var savedView = LS.get(K.lastView);
  var knownViews = qsa('#mainNav .tab-btn').map(function (b) { return b.getAttribute('data-view'); });
  showView(savedView && knownViews.indexOf(savedView) >= 0 ? savedView : (isAdmin() ? 'dashboard' : 'entry'));
}

function autoLogout() {
  api('POST', '/logout', {}).catch(function () { });
  handleSessionEnd('idle_timeout');
}

function init() {
  wire(); net(); clock();
  setInterval(clock, 1000);
  setInterval(tickSession, 1000);
  /* keep the server-side idle clock in step with real activity */
  setInterval(function () {
    if (S.user && Date.now() - S.lastAct < 60000) api('POST', '/heartbeat', {}).catch(function () { });
  }, 45000);
  /* A phone locks or the browser backgrounds the tab well within the idle
     window on its own — a mobile OS routinely throttles or pauses
     setInterval entirely while hidden, so both the 1s tickSession clock and
     the 45s heartbeat can simply stop running for however long the tab was
     out of view. Catch up the moment it's visible again: re-run tickSession
     immediately (rather than waiting up to a second for its own timer), and
     if that puts them still inside the idle window, treat coming back to
     the app as activity and re-heartbeat right away — closing the gap a
     throttled timer would otherwise have left. */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !S.user) return;
    tickSession();
    if (Date.now() - S.lastAct < idleMs()) {
      bumpActivity();
      api('POST', '/heartbeat', {}).catch(function () { });
    }
  });

  api('GET', '/me').then(function (d) {
    if (!d.user) {
      if (d.reason === 'idle_timeout') {
        $('loginNotice').textContent = 'You were signed out automatically after a period of inactivity.';
        $('loginNotice').classList.remove('hidden');
      }
      $('loginUser').focus();
      return;
    }
    return bootstrap().then(function (b) { startApp(b.user, false); });
  }).catch(function (err) {
    /* Say why. Swallowing this is what turned a schema problem into a blank
       login screen with "Request failed (500)" and no explanation. */
    if (err && !err.handled && err.message) {
      $('loginError').textContent = err.message;
      $('loginError').classList.remove('hidden');
    }
    $('loginUser').focus();
  });
}

function wire() {
  /* ---- session ---- */
  $('loginForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    api('POST', '/login', { username: tv('loginUser'), password: tv('loginPass') })
      .then(function (d) {
        $('loginError').classList.add('hidden');
        $('loginNotice').classList.add('hidden');
        $('loginPass').value = '';
        runChicken();
        return bootstrap().then(function (b) { startApp(b.user, true); });
      })
      .catch(function (err) {
        if (err && err.handled) return;
        $('loginError').textContent = (err && err.message) || 'Invalid username or password.';
        $('loginError').classList.remove('hidden');
      });
  });
  $('btnLogout').addEventListener('click', function () {
    if (!confirm('Sign out?')) return;
    api('POST', '/logout', {}).then(function () { location.reload(); }).catch(function () { location.reload(); });
  });
  $('btnStayIn').addEventListener('click', function () {
    bumpActivity(); $('idleModal').classList.add('hidden');
    api('POST', '/heartbeat', {}).catch(function () { });
  });
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(function (ev) {
    document.addEventListener(ev, function () { if (Date.now() - S.lastAct > 1500) bumpActivity(); }, { passive: true });
  });

  /* ---- navigation ---- */
  qsa('#mainNav .tab-btn').forEach(function (b) {
    b.addEventListener('click', function () { showView(b.getAttribute('data-view')); });
  });
  $('branchSelect').addEventListener('change', function () {
    S.branch = this.value; refreshBranchSelects(); runChicken();
    loadEntry(null); renderDashboard(); renderRecords(); renderCustomers();
    renderWorkers(); renderOverheads(); renderOverheadLedger(); renderDayCloseHistory();
  });
  qsa('#entryCatSeg button').forEach(function (b) { b.addEventListener('click', function () { S.cat = b.getAttribute('data-cat'); syncSegs(); loadEntry(null); }); });
  qsa('#dashCatSeg button').forEach(function (b) { b.addEventListener('click', function () { S.dashCat = b.getAttribute('data-cat'); syncSegs(); renderDashboard(); }); });
  qsa('#dashScopeSeg button').forEach(function (b) { b.addEventListener('click', function () { S.dashScope = b.getAttribute('data-scope'); syncSegs(); renderDashboard(); }); });
  qsa('.qr').forEach(function (b) {
    b.addEventListener('click', function () {
      var r = b.getAttribute('data-range');
      if (r === 'today') { $('dashFrom').value = todayISO(); $('dashTo').value = todayISO(); }
      else if (r === '7') { $('dashFrom').value = addDays(todayISO(), -6); $('dashTo').value = todayISO(); }
      else { $('dashFrom').value = monthStart(); $('dashTo').value = todayISO(); }
      var rg = dashRange();
      ensureRange(rg.from, rg.to).then(renderDashboard);
    });
  });
  ['dashFrom', 'dashTo'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      var r = dashRange();
      ensureRange(r.from, r.to).then(renderDashboard);
    });
  });
  $('bmExport').addEventListener('click', function () {
    var d = tableData('#bmBody');
    toXlsx('VCC_bonus_meat_' + todayISO(), 'Bonus meat', d.headers, d.rows);
  });
  $('bmPrint').addEventListener('click', function () {
    var d = tableData('#bmBody');
    printTable('Bonus meat — by branch & day', dashRange().from + ' to ' + dashRange().to, d.headers, d.rows);
  });
  $('msExport').addEventListener('click', function () {
    var d = tableData('#msBody');
    toXlsx('VCC_meat_shortfall_' + todayISO(), 'Meat shortfall', d.headers, d.rows);
  });
  $('msPrint').addEventListener('click', function () {
    var d = tableData('#msBody');
    printTable('Meat shortfall — by branch & day', dashRange().from + ' to ' + dashRange().to, d.headers, d.rows);
  });
  $('lwExport').addEventListener('click', function () {
    var d = tableData('#lwBody');
    toXlsx('VCC_live_bird_shortage_' + todayISO(), 'Live bird weight shortage', d.headers, d.rows);
  });
  $('lwPrint').addEventListener('click', function () {
    var d = tableData('#lwBody');
    printTable('Live bird weight shortage — by branch & day', dashRange().from + ' to ' + dashRange().to, d.headers, d.rows);
  });

  /* ---- daily entry ---- */
  $('entryForm').addEventListener('input', recalc);
  $('entryForm').addEventListener('submit', function (ev) { ev.preventDefault(); });
  /* Auto/manual toggle for closing birds/weight/meat — admin only (the
     buttons themselves are data-admin and hidden from a supervisor, but the
     isAdmin() check here is a second gate so a supervisor's own S.auto can
     never be flipped even if the button were somehow present/clicked). */
  $('entryForm').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-auto]'); if (!b || !isAdmin()) return;
    var key = b.getAttribute('data-auto');
    S.auto[key] = !S.auto[key];
    recalc();
  });
  $('btnAddPurchase').addEventListener('click', function () {
    // Almost every purchase is from the same trader — default to it so the
    // common case needs no typing; still free-text for a one-off supplier.
    S.purchases.push({ supplier: 'Shiva Traders', birds: 0, wtG: 0, rate: 0, kind: 'buy' });
    renderPurchases(); recalc();
  });
  // Same effect as adding a purchase row and then clicking its "Mark as a
  // return" link, but a dedicated button so it doesn't have to be found —
  // straight into return mode, ready for "return against" to be picked.
  $('btnAddReturn').addEventListener('click', function () {
    S.purchases.push({ supplier: '', birds: 0, wtG: 0, rate: 0, kind: 'return', returnOf: null });
    renderPurchases();
    loadOpenPurchases(S.branch).then(function () { renderPurchases(); recalc(); });
  });
  $('purchaseRows').addEventListener('input', function (ev) {
    var el = ev.target.closest('[data-p]'); if (!el) return;
    var i = +el.getAttribute('data-i'), f = el.getAttribute('data-p'), p = S.purchases[i]; if (!p) return;
    if (f === 'supplier') p.supplier = el.value;
    else if (f === 'birds') p.birds = num(el.value);
    else if (f === 'rate') p.rate = num(el.value);
    else if (f === 'kg' || f === 'g') {
      var kgEl = $('purchaseRows').querySelector('[data-p="kg"][data-i="' + i + '"]');
      var gEl = $('purchaseRows').querySelector('[data-p="g"][data-i="' + i + '"]');
      p.wtG = num(kgEl && kgEl.value) * 1000 + num(gEl && gEl.value);
    }
    recalc();
  });
  $('purchaseRows').addEventListener('change', function (ev) {
    var el = ev.target.closest('[data-p="returnOf"]'); if (!el) return;
    var i = +el.getAttribute('data-i'), p = S.purchases[i]; if (!p) return;
    var orig = (S.openPurchases[S.branch] || []).filter(function (o) { return String(o.id) === el.value; })[0];
    p.returnOf = orig ? orig.id : null;
    p.supplier = orig ? orig.supplier : p.supplier;
    p.rate = orig ? orig.rate : p.rate;
    renderPurchases(); recalc();
  });
  $('purchaseRows').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-prm]');
    if (b) { S.purchases.splice(+b.getAttribute('data-prm'), 1); renderPurchases(); recalc(); return; }
    var ret = ev.target.closest('[data-pret]'); if (!ret) return;
    var i = +ret.getAttribute('data-pret'), p = S.purchases[i]; if (!p) return;
    if (p.kind === 'return') {
      p.kind = 'buy'; p.returnOf = null; renderPurchases(); recalc();
    } else {
      p.kind = 'return'; p.returnOf = null; p.birds = 0; p.wtG = 0;
      loadOpenPurchases(S.branch).then(function () { renderPurchases(); recalc(); });
    }
  });
  /* ---- hotel & hostel sale lines ---- */
  $('btnAddHotelSale').addEventListener('click', function () {
    if (!branchCustomers().length) {
      toast('Add a hotel or hostel for this branch first.', 'warn');
      showView('customers');
      return;
    }
    S.hotelSales.push(applyDeal({ customerId: '', product: 'skinless', weightG: 0,
      birds: 0, rateOverride: null, settled: false, note: '' }));
    renderHotelRows(); recalc();
  });
  $('hotelRows').addEventListener('change', function (ev) {
    var el = ev.target.closest('[data-h]'); if (!el) return;
    var f = el.getAttribute('data-h');
    /* a changed customer or item pulls a different deal, so the row is rebuilt */
    if (f === 'customerId' || f === 'product') {
      var l = S.hotelSales[+el.getAttribute('data-i')]; if (!l) return;
      l[f] = el.value;
      applyDeal(l);
      renderHotelRows(); recalc();
    }
  });
  $('hotelRows').addEventListener('input', function (ev) {
    var el = ev.target.closest('[data-h]'); if (!el) return;
    var i = +el.getAttribute('data-i'), f = el.getAttribute('data-h');
    var l = S.hotelSales[i]; if (!l) return;
    if (f === 'settled') l.settled = el.checked;
    else if (f === 'birds') l.birds = num(el.value);
    else if (f === 'rateOverride') l.rateOverride = (el.value === '' ? null : num(el.value));
    else if (f === 'kg' || f === 'g') {
      var kgEl = $('hotelRows').querySelector('[data-h="kg"][data-i="' + i + '"]');
      var gEl = $('hotelRows').querySelector('[data-h="g"][data-i="' + i + '"]');
      l.weightG = num(kgEl && kgEl.value) * 1000 + num(gEl && gEl.value);
    } else return;
    recalc();
  });
  $('hotelRows').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-hrm]'); if (!b) return;
    S.hotelSales.splice(+b.getAttribute('data-hrm'), 1); renderHotelRows(); recalc();
  });

  /* ---- hotels & hostels view ---- */
  $('btnAddCustomer').addEventListener('click', function () { customerModal(null); });
  $('custFilter').addEventListener('change', renderCustomers);
  $('custExport').addEventListener('click', function () {
    var d = tableData('#custBody');
    toXlsx('VCC_customers_' + todayISO(), 'Customers', d.headers, d.rows);
  });
  $('custPrint').addEventListener('click', function () {
    var d = tableData('#custBody');
    printTable('Customers & agreed prices', S.branches[S.branch] || S.branch, d.headers, d.rows);
  });
  $('custBody').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-cact]'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-cact');
    var c = customerById(id); if (!c) return;
    if (act === 'ledger') openCustomerLedger(id);
    else if (act === 'pay') receiptModal(id);
    else if (act === 'adjust') adjustBillModal(id);
    else if (act === 'edit') customerModal(c);
    else if (act === 'del') {
      if (!confirm('Remove "' + c.name + '"?')) return;
      api('DELETE', '/customers/' + id).then(function () { return bootstrap(); })
        .then(function () { renderCustomers(); renderHotelRows(); toast('Removed.', 'warn'); })
        .catch(function (err) {
          if (err && err.payload && err.payload.error === 'in_use') {
            if (!confirm(err.message + '\n\nDelete anyway, including its ledger?')) return;
            api('DELETE', '/customers/' + id + '?force=1').then(function () { return bootstrap(); })
              .then(function () { renderCustomers(); renderHotelRows(); recalc(); renderDashboard();
                toast('Removed with its ledger.', 'warn'); }).catch(apiFail);
            return;
          }
          apiFail(err);
        });
    }
  });

  // Closing birds/weight/meat are always server-computed and the inputs are
  // readonly — no manual-entry toggle any more.

  $('f_photos').addEventListener('change', function () {
    var files = Array.prototype.slice.call(this.files || []), left = files.length; if (!left) return;
    files.forEach(function (f) {
      compress(f, function (u) { S.photos.push(u); if (--left === 0) { renderPhotos(); recalc(); toast(files.length + ' photo(s) attached.'); } });
    });
    this.value = '';
  });
  $('photoStrip').addEventListener('click', function (ev) {
    var rm = ev.target.closest('[data-rm]');
    if (rm) { S.photos.splice(+rm.getAttribute('data-rm'), 1); renderPhotos(); recalc(); return; }
    var vw = ev.target.closest('[data-view]');
    if (vw) { $('lightboxImg').src = S.photos[+vw.getAttribute('data-view')]; $('lightbox').classList.remove('hidden'); }
  });

  /* ---- records ---- */
  ['recFrom', 'recTo', 'recBranch', 'recCat', 'recStatus'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      ensureRange($('recFrom').value || monthStart(), $('recTo').value || todayISO())
        .then(renderRecords);
    });
  });
  $('btnRecExport').addEventListener('click', exportCsv);
  $('btnRecPrint').addEventListener('click', printReport);
  /* the nav badge counts every pending entry with no date/branch/category
     limit — this clears every Records filter and widens the loaded window
     all the way back to the oldest pending entry, so nothing the badge
     promised is still out of view. */
  $('recShowAllPending').addEventListener('click', function () {
    $('recFrom').value = ''; $('recTo').value = ''; $('recBranch').value = '';
    $('recCat').value = ''; $('recStatus').value = 'pending';
    var oldestPending = visibleEntries()
      .filter(function (e) { return e.status === 'pending'; })
      .reduce(function (min, e) { var d = dOf(e.datetime); return (!min || d < min) ? d : min; }, null);
    ensureRange(oldestPending || monthStart(), todayISO()).then(renderRecords);
  });
  $('recBody').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-act]'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
    if (act === 'review') ensurePhotos(id).then(function () { openReview(id); });
    else if (act === 'edit') ensurePhotos(id).then(function () { showView('entry'); loadEntry(id); });
    else if (act === 'del' && confirm('Delete this entry permanently?')) {
      api('DELETE', '/entries/' + id).then(function () {
        S.entries = S.entries.filter(function (x) { return x.id !== id; });
        renderRecords(); renderDashboard(); updatePendingBadge(); toast('Entry deleted.', 'warn');
      }).catch(apiFail);
    }
  });
  $('reviewBody').addEventListener('click', function (ev) {
    var im = ev.target.closest('img[data-view]'); if (!im) return;
    $('lightboxImg').src = im.src; $('lightbox').classList.remove('hidden');
  });

  /* ---- labour ---- */
  $('wkDate').addEventListener('change', renderWorkers);
  $('wbExport').addEventListener('click', function () {
    var d = tableData('#workerBody');
    toXlsx('VCC_worker_balances_' + todayISO(), 'Worker balances', d.headers, d.rows);
  });
  $('wbPrint').addEventListener('click', function () {
    var d = tableData('#workerBody');
    printTable('Worker ledger & balances', S.branches[S.branch] || S.branch, d.headers, d.rows);
  });
  $('shExport').addEventListener('click', function () {
    var d = tableData('#sheetBody');
    toXlsx('VCC_daily_workers_sheet_' + ($('wkDate').value || todayISO()), 'Daily workers sheet', d.headers, d.rows);
  });
  $('shPrint').addEventListener('click', function () {
    var d = tableData('#sheetBody');
    printTable('Daily workers sheet', (S.branches[S.branch] || S.branch) + ' · ' + ($('wkDate').value || todayISO()), d.headers, d.rows);
  });
  ['wkFrom', 'wkTo', 'wkWorkerFilter', 'wkTypeFilter'].forEach(function (id) {
    $(id).addEventListener('change', renderLedgerLog);
  });
  $('wkThisMonth').addEventListener('click', function () {
    $('wkFrom').value = monthStart(); $('wkTo').value = todayISO(); renderLedgerLog();
  });
  var wkLedgerRows = function () {
    var d = S.wkLedger;
    var headers = ['Date', 'Worker', 'Type', 'Note', 'Amount'];
    var rows = (d && d.rows || []).map(function (l) {
      var def = LEDGER_TYPES[l.type] || { t: l.type };
      return [l.date, l.workerName || '', def.t, l.note || '', l.amount];
    });
    return { d: d, headers: headers, rows: rows };
  };
  $('wkExport').addEventListener('click', function () {
    var x = wkLedgerRows(); if (!x.d || !x.rows.length) return;
    toXlsx('VCC_ledger_' + x.d.from + '_to_' + x.d.to, 'Ledger', x.headers, x.rows);
  });
  $('wkPrint').addEventListener('click', function () {
    var x = wkLedgerRows(); if (!x.d) return;
    printTable('Worker ledger — transaction log', x.d.from + ' to ' + x.d.to, x.headers, x.rows);
  });
  /* ---- supplier purchase ledger (admin only) ---- */
  ['plFrom', 'plTo'].forEach(function (id) { $(id).addEventListener('change', renderPurchaseLedger); });
  $('plThisMonth').addEventListener('click', function () {
    $('plFrom').value = monthStart(); $('plTo').value = todayISO(); renderPurchaseLedger();
  });
  $('plExport').addEventListener('click', function () {
    var by = tableData('#plBody');
    var d = S.purchaseLedger;
    toXlsx('VCC_purchase_ledger_' + (d ? d.from + '_to_' + d.to : todayISO()), 'By supplier', by.headers, by.rows);
  });
  $('plPrint').addEventListener('click', function () {
    var by = tableData('#plBody');
    var d = S.purchaseLedger;
    printTable('Purchase ledger — ' + (S.branches[S.branch] || S.branch),
      d ? d.from + ' to ' + d.to : '', by.headers, by.rows);
  });
  ['flFrom', 'flTo'].forEach(function (id) { $(id).addEventListener('change', renderFeedLedger); });
  $('flThisMonth').addEventListener('click', function () {
    $('flFrom').value = monthStart(); $('flTo').value = todayISO(); renderFeedLedger();
  });
  $('flExport').addEventListener('click', function () {
    var by = tableData('#flBody');
    var d = S.feedLedger;
    toXlsx('VCC_feed_ledger_' + (d ? d.from + '_to_' + d.to : todayISO()), 'By supplier', by.headers, by.rows);
  });
  $('flPrint').addEventListener('click', function () {
    var by = tableData('#flBody');
    var d = S.feedLedger;
    printTable('Feed ledger — ' + (S.branches[S.branch] || S.branch),
      d ? d.from + ' to ' + d.to : '', by.headers, by.rows);
  });
  ['dwFrom', 'dwTo'].forEach(function (id) { $(id).addEventListener('change', renderDayWise); });
  $('dwMonth').addEventListener('click', function () {
    $('dwFrom').value = monthStart(); $('dwTo').value = todayISO(); renderDayWise();
  });
  $('dwExport').addEventListener('click', function () {
    var d = tableData('#dwBody');
    toXlsx('VCC_labour_daywise_' + todayISO(), 'Day-wise workers', d.headers, d.rows);
  });
  $('dwPrint').addEventListener('click', function () {
    var d = tableData('#dwBody');
    printTable('Day-wise workers & deductions', $('dwFrom').value + ' to ' + $('dwTo').value, d.headers, d.rows);
  });
  $('btnAddWorker').addEventListener('click', function () { workerModal(null); });
  $('btnPayWorker').addEventListener('click', function () { ledgerModal('pay'); });
  $('btnAddExpense').addEventListener('click', function () { ledgerModal('exp'); });
  $('attendanceGrid').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-att]'); if (!b) return;
    markAttendance(b.getAttribute('data-att'), parseFloat(b.getAttribute('data-days')));
  });
  $('sheetBody').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-sheet]'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-sheet');
    if (act === 'adv') advanceModal(id);
    else if (act === 'wage') adjustWage(id);
    else workerModal(S.workers.filter(function (x) { return x.id === id; })[0]);
  });
  $('workerBody').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-wact]'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-wact');
    var w = S.workers.filter(function (x) { return x.id === id; })[0];
    if (act === 'pay') ledgerModal('pay', id);
    else if (act === 'edit') workerModal(w);
    else if (confirm('Remove ' + w.name + '? Their ledger history stays.')) {
      api('DELETE', '/workers/' + id).then(function () { return bootstrap(); })
        .then(function () { renderWorkers(); toast('Worker removed.', 'warn'); }).catch(apiFail);
    }
  });
  $('ledgerBody').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-lact]'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-lact');
    if (act === 'edit') { editLedgerRow(id); return; }
    api('DELETE', '/ledger/' + id).then(function () { return bootstrap(); })
      .then(function () { renderWorkers(); recalc(); renderDashboard(); toast('Ledger entry removed.', 'warn'); })
      .catch(apiFail);
  });

  /* ---- day close ---- */
  $('dcDate').addEventListener('change', renderDayClose);
  $('dcToday').addEventListener('click', function () {
    $('dcDate').value = todayISO(); renderDayClose();
  });
  var dcCardsRows = function () {
    var headers = ['Branch', 'Entries', 'Approved', 'Counter sales', 'Live sales', 'Cutting charges',
                   'Hotel — paid today', 'Receipts vs old bills', 'Wages/advances paid', 'Shop costs',
                   'Expected handover', 'Cash', 'UPI', 'Handed over', 'Difference', 'Verified'];
    var cur = S.dcCurrent;
    var rows = (cur && cur.branches || []).map(function (b) {
      var x = b.expectedBreakdown, c = b.close;
      var handed = c ? (num(c.cash) + num(c.upi)) : null;
      return [b.branchName, x.entries, x.approved, x.counterSales, x.liveSales, x.cuttingCharges,
              x.hotelCash, x.receipts, x.wagesPaid, x.shopCosts, b.expected,
              c ? c.cash : '', c ? c.upi : '', handed === null ? '' : handed,
              b.difference === null ? '' : b.difference, c && c.verifiedAt ? 'yes' : 'no'];
    });
    return { cur: cur, headers: headers, rows: rows };
  };
  $('dcCardsExport').addEventListener('click', function () {
    var x = dcCardsRows(); if (!x.cur) return;
    toXlsx('VCC_dayclose_cards_' + x.cur.date, 'Day Close', x.headers, x.rows);
  });
  $('dcCardsPrint').addEventListener('click', function () {
    var x = dcCardsRows(); if (!x.cur) return;
    printTable('Cash handover — ' + x.cur.date, '', x.headers, x.rows);
  });
  ['dcFrom', 'dcTo'].forEach(function (id) {
    $(id).addEventListener('change', renderDayCloseHistory);
  });
  $('dcThisWeek').addEventListener('click', function () {
    $('dcFrom').value = addDays(todayISO(), -6); $('dcTo').value = todayISO();
    renderDayCloseHistory();
  });
  $('dcThisMonth').addEventListener('click', function () {
    $('dcFrom').value = monthStart(); $('dcTo').value = todayISO();
    renderDayCloseHistory();
  });
  if ($('dcGapBranch')) $('dcGapBranch').addEventListener('change', renderDayCloseGaps);
  $('dcCards').addEventListener('click', function (ev) {
    var save = ev.target.closest('[data-dcsave]');
    if (save) { saveDayClose(save.getAttribute('data-dcsave')); return; }
    var ver = ev.target.closest('[data-dcverify]');
    if (ver) {
      var reopen = !!ver.getAttribute('data-reopen');
      var vkey = 'dcverify:' + ver.getAttribute('data-dcverify') + (reopen ? ':reopen' : ':verify');
      var vctx = spinGuard(vkey, ver);
      if (!vctx) return;
      api('POST', '/dayclose/' + ver.getAttribute('data-dcverify') + '/verify', { reopen: reopen })
        .then(function () {
          renderDayClose();          // already refreshes the history table + closeBadge
          toast(reopen ? 'Reopened.' : 'Verified.');
        })
        .catch(apiFail)
        .then(function () { spinRelease(vkey, vctx); });
      return;
    }
    var del = ev.target.closest('[data-dcdelete]');
    if (del) {
      if (!confirm('Delete this handover? The day goes back to not yet declared.')) return;
      var dkey = 'dcdelete:' + del.getAttribute('data-dcdelete');
      var dctx = spinGuard(dkey, del);
      if (!dctx) return;
      api('DELETE', '/dayclose/' + del.getAttribute('data-dcdelete'))
        .then(function () {
          renderDayClose();
          toast('Handover deleted.', 'warn');
        })
        .catch(apiFail)
        .then(function () { spinRelease(dkey, dctx); });
    }
  });
  $('dcHistBody').addEventListener('click', function (ev) {
    var del = ev.target.closest('[data-dchistdel]'); if (!del) return;
    if (!confirm('Delete this handover? The day goes back to not yet declared.')) return;
    var dkey = 'dchistdel:' + del.getAttribute('data-dchistdel');
    var dctx = spinGuard(dkey, del);
    if (!dctx) return;
    api('DELETE', '/dayclose/' + del.getAttribute('data-dchistdel'))
      .then(function () {
        renderDayCloseHistory();
        if (S.dcCurrent) renderDayClose();   // keep the branch cards in sync too
        toast('Handover deleted.', 'warn');
      })
      .catch(apiFail)
      .then(function () { spinRelease(dkey, dctx); });
  });
  $('dcCards').addEventListener('input', function (ev) {
    var el = ev.target.closest('[data-dc]'); if (!el) return;
    var card = el.closest('[data-dcbranch]'); if (!card) return;
    var label = card.querySelector('[data-dcdiff]'); if (!label) return;
    /* live difference as they type, before anything is saved */
    var cash = num(card.querySelector('[data-dc="cash"]').value);
    var upi = num(card.querySelector('[data-dc="upi"]').value);
    var expected = num(card.getAttribute('data-dcexpected'));
    var d = cash + upi - expected;
    label.textContent = (d > 0 ? '+' : '') + money(d);
    label.parentElement.className = 'mt-3 rounded-lg px-3 py-2 text-sm font-bold flex justify-between ' +
      (Math.abs(d) < 0.5 ? 'bg-emerald-50 text-emerald-800'
        : d > 0 ? 'bg-amber-50 text-amber-800' : 'bg-rose-50 text-rose-700');
  });
  var dcHistRows = function () {
    var headers = ['Date', 'Branch', 'Revenue', 'Expected in hand', 'Cash', 'UPI', 'Handed over', 'Difference', 'Verified'];
    var rows = (S.closeHistory || []).map(function (r) {
      return [r.date, r.branchName, r.revenue, r.expected, r.cash, r.upi, r.declared,
              r.difference, r.verified ? 'yes' : 'no'];
    });
    return { headers: headers, rows: rows };
  };
  $('dcExport').addEventListener('click', function () {
    var x = dcHistRows();
    toXlsx('VCC_dayclose_' + todayISO(), 'Handover history', x.headers, x.rows);
  });
  $('dcPrint').addEventListener('click', function () {
    var x = dcHistRows();
    printTable('Cash handover history', ($('dcFrom').value || '') + ' to ' + ($('dcTo').value || ''), x.headers, x.rows);
  });
  $('dcBranchExport').addEventListener('click', function () {
    var d = tableData('#dcBranchBody');
    toXlsx('VCC_dayclose_by_branch_' + todayISO(), 'Cash & PhonePe by branch', d.headers, d.rows);
  });
  $('dcBranchPrint').addEventListener('click', function () {
    var d = tableData('#dcBranchBody');
    printTable('Cash & PhonePe by branch', ($('dcFrom').value || '') + ' to ' + ($('dcTo').value || ''), d.headers, d.rows);
  });

  /* ---- overhead ledger ---- */
  qsa('#ovhScopeSeg button').forEach(function (b) {
    b.addEventListener('click', function () {
      S.ovhScope = b.getAttribute('data-oscope');
      qsa('#ovhScopeSeg button').forEach(function (x) { x.classList.toggle('active', x === b); });
      renderOverheadLedger();
    });
  });
  ['ovhFrom', 'ovhTo'].forEach(function (id) {
    $(id).addEventListener('change', renderOverheadLedger);
  });
  $('ovhThisMonth').addEventListener('click', function () {
    $('ovhFrom').value = monthStart(); $('ovhTo').value = todayISO(); renderOverheadLedger();
  });
  var ovhLedgerRows = function () {
    var d = S.ovhLedger;
    var headers = ['Date', 'Branch', 'Amount'];
    var rows = [];
    (d && d.byDay || []).forEach(function (r) {
      Object.keys(r.branches).sort().forEach(function (b) { rows.push([r.date, b, r.branches[b]]); });
    });
    return { d: d, headers: headers, rows: rows };
  };
  $('ovhExport').addEventListener('click', function () {
    var x = ovhLedgerRows(); if (!x.d) return;
    toXlsx('VCC_overheads_' + todayISO(), 'Overheads', x.headers, x.rows);
  });
  $('ovhPrint').addEventListener('click', function () {
    var x = ovhLedgerRows(); if (!x.d) return;
    printTable('Overhead ledger', ($('ovhFrom').value || '') + ' to ' + ($('ovhTo').value || ''), x.headers, x.rows);
  });

  /* ---- overheads ---- */
  $('ovhMonth').addEventListener('change', function () { renderOverheads(); renderOverheadLedger(); });
  $('btnAddOverhead').addEventListener('click', overheadModal);
  $('ovhEntExport').addEventListener('click', function () {
    var d = tableData('#ovhBody');
    toXlsx('VCC_overhead_entries_' + todayISO(), 'Overhead entries', d.headers, d.rows);
  });
  $('ovhEntPrint').addEventListener('click', function () {
    var d = tableData('#ovhBody');
    printTable('Overhead entries', $('ovhMonth') ? $('ovhMonth').value : '', d.headers, d.rows);
  });
  $('ovhBody').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-ovh]'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-ovh');
    if (act === 'ok') decideOverhead(id, 'approved');
    else if (act === 'no') {
      openGen('Return overhead',
        '<label class="lbl" for="ovhReason">Reason</label>' +
        '<textarea id="ovhReason" rows="3" class="inp" placeholder="e.g. attach the bill copy"></textarea>' +
        '<div class="flex gap-3 mt-4"><button id="ovhRejGo" class="bg-rose-600 hover:bg-rose-700 text-white font-bold text-sm px-5 py-2.5 rounded-lg">Return</button>' +
        '<button data-close="1" class="border border-slate-300 text-slate-600 font-bold text-sm px-5 py-2.5 rounded-lg">Cancel</button></div>');
      bind('ovhRejGo', function () {
        var rr = tv('ovhReason'); if (!rr) { toast('Give a reason.', 'error'); return; }
        closeModal('genModal'); decideOverhead(id, 'rejected', rr);
      });
    } else if (act === 'edit') {
      var o = S.overheads.filter(function (x) { return x.id === id; })[0]; if (!o) return;
      var val = prompt('Amount for ' + ovhCatName(o.category) + ' (' + (o.date || o.month) + '):', o.amount);
      if (val === null) return;
      var amt = parseFloat(val);
      if (!(amt > 0)) { toast('Enter a valid amount.', 'error'); return; }
      var key = 'ovhedit:' + id;
      if (!once(key)) return;
      api('PUT', '/overheads/' + id, { amount: amt })
        .then(function (rec) {
          var i = S.overheads.findIndex(function (x) { return x.id === rec.id; });
          if (i >= 0) S.overheads[i] = rec;
          renderOverheads(); renderDashboard(); toast('Overhead updated.');
        })
        .catch(apiFail).then(function () { done(key); });
    } else if (act === 'del' && confirm('Delete this overhead entry?')) {
      api('DELETE', '/overheads/' + id).then(function () {
        S.overheads = S.overheads.filter(function (x) { return x.id !== id; });
        renderOverheads(); renderDashboard(); toast('Overhead deleted.', 'warn');
      }).catch(apiFail);
    }
  });

  /* ---- administration ---- */
  $('btnAddBranch').addEventListener('click', function () { $('branchAddForm').classList.toggle('hidden'); });
  $('branchAddForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    api('POST', '/branches', { code: tv('newBranchCode'), name: tv('newBranchName') })
      .then(function (b) {
        setV('newBranchName', ''); setV('newBranchCode', '');
        return bootstrap();
      })
      .then(function () { renderAdmin(); refreshBranchSelects(); toast('Branch created.'); })
      .catch(apiFail);
  });
  $('branchBody').addEventListener('input', function (ev) {
    var i = ev.target.closest('input[data-bname]'); if (!i || !i.value.trim()) return;
    var code = i.getAttribute('data-bname'), name = i.value.trim();
    S.branches[code] = name;
    clearTimeout(i._t);
    i._t = setTimeout(function () {
      api('PUT', '/branches/' + code, { name: name }).then(function () { refreshBranchSelects(); }).catch(apiFail);
    }, 600);
  });
  $('branchBody').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-bdel]'); if (!b || b.disabled) return;
    var c = b.getAttribute('data-bdel');
    var n = S.entries.filter(function (e) { return e.branch === c; }).length;
    if (!confirm('Delete "' + S.branches[c] + '"?' + (n ? '\n\n' + n + ' record(s) will also be deleted.' : ''))) return;
    api('DELETE', '/branches/' + c).then(function () { return bootstrap(); })
      .then(function () { renderAdmin(); refreshBranchSelects(); renderRecords(); renderDashboard(); toast('Branch deleted.', 'warn'); })
      .catch(apiFail);
  });
  $('btnAddUser').addEventListener('click', function () { $('userAddForm').classList.toggle('hidden'); });
  $('userAddForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var brs = qsa('#newUserBranches .ubr').filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
    api('POST', '/users', { name: tv('newUserName'), username: tv('newUserLogin'),
      password: tv('newUserPass'), role: tv('newUserRole'), branches: brs })
      .then(function () {
        setV('newUserName', ''); setV('newUserLogin', ''); setV('newUserPass', '');
        return bootstrap();
      })
      .then(function () { renderAdmin(); toast('Account created.'); })
      .catch(apiFail);
  });
  $('userBody').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-uact]'); if (!b) return;
    var id = +b.getAttribute('data-id'), u = S.users.filter(function (x) { return x.id === id; })[0];
    if (b.getAttribute('data-uact') === 'pass') {
      var p = prompt('New password for ' + u.name + ':');
      if (p) api('PUT', '/users/' + id + '/password', { password: p })
        .then(function () { toast('Password updated.'); }).catch(apiFail);
    } else if (confirm('Delete account "' + u.username + '"?')) {
      api('DELETE', '/users/' + id).then(function () { return bootstrap(); })
        .then(function () { renderAdmin(); toast('Account deleted.', 'warn'); }).catch(apiFail);
    }
  });
  $('btnSaveSettings').addEventListener('click', function () {
    api('PUT', '/settings', { wasteBroiler: v('setWasteBroiler'), wasteParents: v('setWasteParents'),
      tolerance: v('setTolerance'), dayWage: v('setDayWage') })
      .then(function () { return bootstrap(); })
      .then(function () { recalc(); renderDashboard(); renderRecords(); toast('Settings saved.'); })
      .catch(apiFail);
  });

  /* ---- activity log ---- */
  $('actUser').addEventListener('change', renderActivity);
  $('actKind').addEventListener('change', renderActivity);
  $('btnActClear').addEventListener('click', function () {
    if (!confirm('Clear the entire activity log?')) return;
    api('DELETE', '/activity').then(function () { renderActivity(); toast('Activity log cleared.', 'warn'); }).catch(apiFail);
  });
  var actRows = function () {
    var headers = ['When', 'User', 'Role', 'Branch', 'Action', 'Detail'];
    var rows = (S.activity || []).map(function (a) { return [a.at, a.userName, a.role, a.branch, a.action, a.detail]; });
    return { headers: headers, rows: rows };
  };
  $('btnActExport').addEventListener('click', function () {
    var x = actRows();
    toXlsx('VCC_activity_' + todayISO(), 'Activity log', x.headers, x.rows);
  });
  $('btnActPrint').addEventListener('click', function () {
    var x = actRows();
    printTable('Activity log', '', x.headers, x.rows);
  });

  /* ---- data tools ---- */
  $('btnExportAll').addEventListener('click', function () {
    var dump = { branches: S.branches, entries: S.entries, workers: S.workers,
      ledger: S.ledger, overheads: S.overheads, settings: S.settings, users: S.users };
    download(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }), 'VCC_backup_' + todayISO() + '.json');
    toast('Backup downloaded.');
  });
  $('importFile').addEventListener('change', function () {
    toast('Import runs server-side: python seed.py --import <file>', 'warn'); this.value = '';
  });
  $('btnSeed').addEventListener('click', function () {
    if (!confirm('Load the demo dataset on the server?')) return;
    api('POST', '/admin/seed', {}).then(function () { return bootstrap(); })
      .then(function () { renderAdmin(); refreshAllViews(); loadEntry(null); toast('Demo data loaded.'); })
      .catch(apiFail);
  });
  $('btnWipeAll').addEventListener('click', function () {
    api('GET', '/admin/wipe-preview').then(function (p) {
      var label = { entries: 'Daily entries', purchases: 'Purchase lines',
        hotelSales: 'Hotel/hostel sale lines', payments: 'Customer receipts',
        adjustments: 'Billing adjustments', overheads: 'Overhead entries',
        dayCloses: 'Cash handovers (Day Close)', labourLedger: 'Labour ledger rows',
        mortalityPhotos: 'Mortality photos' };
      var lines = Object.keys(p.delete)
        .filter(function (k) { return p.delete[k] > 0; })
        .map(function (k) { return '  • ' + p.delete[k] + ' ' + label[k]; });
      var total = Object.keys(p.delete).reduce(function (s, k) { return s + p.delete[k]; }, 0);
      if (!total) { toast('There is nothing to delete — no trading data recorded yet.'); return; }
      var msg = 'This will permanently delete:\n\n' + lines.join('\n') +
        '\n\nKept untouched: ' + p.keep.branches + ' branch(es), ' + p.keep.users +
        ' user account(s), ' + p.keep.workers + ' worker(s), ' + p.keep.customers +
        ' customer(s).\n\nAn Excel backup of everything above will be downloaded to ' +
        'this computer first, before anything is deleted.\n\nContinue?';
      if (!confirm(msg)) return;

      api('GET', '/admin/wipe-backup').then(function (b) {
        downloadWipeBackup(b);
        toast('Backup downloaded — check it before continuing.', 'warn');
        var typed = prompt('Backup saved. Now type ' + JSON.stringify('DELETE ALL DATA') +
          ' exactly to permanently delete the data above:');
        if (typed === null) return;
        if (typed.trim() !== 'DELETE ALL DATA') { toast('Text did not match — nothing deleted.', 'warn'); return; }
        api('POST', '/admin/wipe', { confirm: 'DELETE ALL DATA' }).then(function () {
          return bootstrap();
        }).then(function () {
          renderAdmin(); refreshAllViews(); loadEntry(null);
          toast('All trading data deleted. A backup was saved before deletion.', 'warn');
        }).catch(apiFail);
      }).catch(function (err) {
        apiFail(err);
        toast('Could not download the backup — nothing was deleted.', 'error');
      });
    }).catch(apiFail);
  });
  /* ---- modals ---- */
  ['reviewModal', 'genModal', 'lightbox'].forEach(function (id) {
    $(id).addEventListener('click', function (ev) { if (ev.target.closest('[data-close]')) closeModal(id); });
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    ['lightbox', 'genModal', 'reviewModal'].forEach(function (id) { if (!$(id).classList.contains('hidden')) closeModal(id); });
  });
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  /* A number input that happens to be focused when the page is scrolled
     picks up the wheel as +/- steps in every browser — easy to trigger by
     accident while scrolling past a weight or rate box on the entry form.
     Block the browser's default only when a number input actually has
     focus (so the page still scrolls normally everywhere else), then blur
     it so the rest of that same scroll gesture passes through untouched. */
  document.addEventListener('wheel', function (ev) {
    var el = document.activeElement;
    if (el && el.tagName === 'INPUT' && el.type === 'number') {
      ev.preventDefault();
      el.blur();
    }
  }, { passive: false });
}


if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
