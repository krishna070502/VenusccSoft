
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
          activity:'vcc_activity', logoutReason:'vcc_logout_reason', overheads:'vcc_overheads' };
var DB = {
  read:function(key,fb){ var r=LS.get(key); if(!r) return fb;
    try{ var val=JSON.parse(r); return (val===null||val===undefined)?fb:val; }catch(e){ return fb; } },
  write:function(key,val){ LS.set(key,JSON.stringify(val)); },
  clearAll:function(){ Object.keys(K).forEach(function(k){ LS.del(K[k]); }); }
};

var DEFAULT_BRANCHES = { B01:'Branch 01 — Main Hub', B02:'Branch 02 — Downtown' };
var DEFAULT_USERS = [
  { id:'u1', name:'System Admin', username:'admin', password:'admin123', role:'admin', branches:['B01','B02'], active:true },
  { id:'u2', name:'Ravi Kumar', username:'ravi', password:'ravi123', role:'supervisor', branches:['B01'], active:true }
];
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

var IDLE_MS = { admin: 2*60*1000, supervisor: 10*60*1000 };
var IDLE_WARN = 30*1000;

var S = { users:[], branches:{}, entries:[], workers:[], ledger:[], overheads:[], settings:{}, activity:[],
          lastAct:Date.now(), auto:{ closeBirds:true, closeWt:true, closeMeat:true },
          user:null, branch:null, cat:'broiler', dashCat:'all', dashScope:'branch',
          editing:null, photos:[], purchases:[], charts:{} };

/* ---------------- helpers ---------------- */
function $(id){ return document.getElementById(id); }
function qsa(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); }
function num(v){ var x=parseFloat(v); return isFinite(x)?x:0; }
function v(id){ var el=$(id); return el?num(el.value):0; }
function tv(id){ var el=$(id); return el?String(el.value||'').trim():''; }
function filled(id){ var el=$(id); return !!(el && String(el.value||'').trim()!==''); }
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
  var earn=0, other=0, days=0;
  S.ledger.forEach(function(l){
    if(l.branch!==branch || l.date!==date) return;
    var def=LEDGER_TYPES[l.type]||{};
    if(l.type==='work'){ earn+=num(l.amount); days+=num(l.days); }
    else if(def.shop) other+=num(l.amount);
  });
  return { wages:earn, other:other, manDays:days };
}

function calc(e){
  e=e||{};
  var wastePct=wasteFor(e.category), expYield=100-wastePct, yieldFrac=expYield/100;
  var tol=num(S.settings.tolerance);

  /* ---- purchases & weighted average cost ---- */
  var rows=e.purchases||[];
  var buyBirds=0, buyWtG=0, buyAmt=0;
  rows.forEach(function(r){ buyBirds+=num(r.birds); buyWtG+=num(r.wtG); buyAmt+=num(r.wtG)/1000*num(r.rate); });

  var openWtG=num(e.openWtG), openRate=num(e.openRate);
  var openValue=openWtG/1000*openRate;
  var availWtG=openWtG+buyWtG, availValue=openValue+buyAmt;
  var avgRate=availWtG>0 ? availValue/(availWtG/1000) : openRate;
  var meatCostKg=yieldFrac>0 ? avgRate/yieldFrac : 0;

  /* ---- dressing ---- */
  var dressedWtG=num(e.dressedWtG), actualMeatG=num(e.actualMeatG);
  var expectedMeatG=dressedWtG*yieldFrac, wasteMeatG=dressedWtG*(wastePct/100);
  var varianceG=actualMeatG-expectedMeatG;
  var bonusG=Math.max(varianceG,0), shortG=Math.max(-varianceG,0);
  var yieldPct=dressedWtG>0?(actualMeatG/dressedWtG)*100:0;
  var yieldLow=dressedWtG>0&&actualMeatG>0&&yieldPct<expYield-tol;
  var yieldHigh=dressedWtG>0&&yieldPct>expYield+tol;

  /* ---- revenue ---- */
  var skinAmt=num(e.skinSoldG)/1000*num(e.rateSkin);
  var skinlessAmt=num(e.skinlessSoldG)/1000*num(e.rateSkinless);
  var liverAmt=num(e.liverSoldG)/1000*num(e.rateLiver);
  var liveAmt=num(e.liveSoldWtG)/1000*num(e.rateLive);
  var cutAmt=num(e.cutCharges);
  var meatSaleAmt=skinAmt+skinlessAmt+liverAmt;
  var revenue=meatSaleAmt+liveAmt+cutAmt;

  /* ---- birds & meat balance ---- */
  var handled=num(e.openBirds)+buyBirds;
  var expBirds=handled-num(e.liveSoldCount)-num(e.mortCount)-num(e.dressedCount);
  var birdVar=expBirds-num(e.closeBirds);
  var mortRate=handled>0?(num(e.mortCount)/handled)*100:0;
  var meatAvailG=num(e.openMeatG)+actualMeatG;
  var expCloseWtG=availWtG-num(e.liveSoldWtG)-num(e.mortWtG)-dressedWtG;
  var expCloseMeatG=meatAvailG-num(e.skinSoldG)-num(e.skinlessSoldG)-num(e.liverSoldG)-num(e.damageG);
  var meatVarG=expCloseMeatG-num(e.closeMeatG);

  /* ---- profit & loss ---- */
  var openMeatValue=num(e.openMeatG)/1000*meatCostKg;
  var closeLiveValue=num(e.closeWtG)/1000*avgRate;
  var closeMeatValue=num(e.closeMeatG)/1000*meatCostKg;
  var closeValue=closeLiveValue+closeMeatValue;
  var cogs=(availValue+openMeatValue)-closeValue;
  var grossProfit=revenue-cogs;

  var lab=labourFor(dOf(e.datetime), e.branch);
  var netProfit=grossProfit-lab.wages-lab.other;

  /* ---- loss drivers ---- */
  var mortValue=num(e.mortWtG)/1000*avgRate;
  var damageValue=num(e.damageG)/1000*meatCostKg;
  var shortValue=shortG/1000*meatCostKg;
  var bonusValue=bonusG/1000*meatCostKg;

  var photos=e.photos||[];
  var needsPhoto=num(e.mortCount)>0 && photos.length===0;
  var hasData=handled>0||dressedWtG>0||revenue>0;

  return { wastePct:wastePct, expYield:expYield, yieldFrac:yieldFrac,
    buyBirds:buyBirds, buyWtG:buyWtG, buyAmt:buyAmt, openValue:openValue, availWtG:availWtG,
    availValue:availValue, avgRate:avgRate, meatCostKg:meatCostKg,
    expectedMeatG:expectedMeatG, wasteMeatG:wasteMeatG, varianceG:varianceG, bonusG:bonusG, shortG:shortG,
    yieldPct:yieldPct, yieldLow:yieldLow, yieldHigh:yieldHigh,
    skinAmt:skinAmt, skinlessAmt:skinlessAmt, liverAmt:liverAmt, liveAmt:liveAmt, cutAmt:cutAmt,
    meatSaleAmt:meatSaleAmt, revenue:revenue,
    handled:handled, expBirds:expBirds, birdVar:birdVar, mortRate:mortRate,
    meatAvailG:meatAvailG, expCloseWtG:expCloseWtG, expCloseMeatG:expCloseMeatG, meatVarG:meatVarG,
    openMeatValue:openMeatValue, closeLiveValue:closeLiveValue, closeMeatValue:closeMeatValue,
    closeValue:closeValue, cogs:cogs, grossProfit:grossProfit,
    labour:lab.wages, otherExp:lab.other, manDays:lab.manDays, netProfit:netProfit,
    mortValue:mortValue, damageValue:damageValue, shortValue:shortValue, bonusValue:bonusValue,
    needsPhoto:needsPhoto, hasData:hasData };
}

function warnings(e,c){
  var w=[];
  if(c.needsPhoto) w.push({lvl:'red',t:'Mortality photo missing',m:num(e.mortCount)+' bird(s) recorded. At least one photo is required before submitting.'});
  if(c.yieldLow) w.push({lvl:'red',t:'Meat shortfall',m:'Yield '+pct(c.yieldPct)+' against an expected '+pct(c.expYield,0)+'. Short by '+fmtW(c.shortG)+' ≈ '+money0(c.shortValue)+'.'});
  if(c.yieldHigh) w.push({lvl:'amber',t:'Excess meat — bonus',m:'Yield '+pct(c.yieldPct)+' exceeds the expected '+pct(c.expYield,0)+'. Bonus '+fmtW(c.bonusG)+' ≈ '+money0(c.bonusValue)+'.'});
  if(c.birdVar!==0&&c.hasData) w.push({lvl:'amber',t:'Bird count mismatch',m:'Closing count is '+Math.abs(c.birdVar)+' bird(s) '+(c.birdVar>0?'short of':'above')+' the expected balance.'});
  if(Math.abs(c.meatVarG)>500&&c.hasData) w.push({lvl:'amber',t:'Meat balance mismatch',m:'Closing meat differs from expected by '+fmtW(Math.abs(c.meatVarG))+'.'});
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
function applyAutoFill(c){
  var hb=$('hint_closeBirds'), hw=$('hint_closeWt'), hm=$('hint_closeMeat');
  var expB=Math.max(Math.round(c.expBirds),0), expW=Math.max(Math.round(c.expCloseWtG),0), expM=Math.max(Math.round(c.expCloseMeatG),0);

  if(S.auto.closeBirds && !$('f_closeBirds').disabled){ if($('f_closeBirds').value!==String(expB)) $('f_closeBirds').value=expB; }
  if(S.auto.closeWt && !$('f_closeWt_kg').disabled) setG('f_closeWt',expW);
  if(S.auto.closeMeat && !$('f_closeMeat_kg').disabled) setG('f_closeMeat',expM);

  hb.textContent=S.auto.closeBirds?'Auto: opening + purchased − live sold − mortality − dressed':'Manual — expected '+expB;
  hw.textContent=S.auto.closeWt?'Auto from weights entered above':'Manual — expected '+fmtW(expW);
  hm.textContent=S.auto.closeMeat?'Auto: open meat + meat obtained − skin − skinless − liver − damage':'Manual — expected '+fmtW(expM);
  [['closeBirds',hb],['closeWt',hw],['closeMeat',hm]].forEach(function(x){
    x[1].className='text-[11px] mt-1 '+(S.auto[x[0]]?'text-emerald-600':'text-amber-600');
  });
  qsa('[data-auto]').forEach(function(b){
    var on=S.auto[b.getAttribute('data-auto')];
    b.className='autoBtn'+(on?'':' off'); b.textContent=on?'auto':'manual';
  });
}

/* ---------------- auth & RBAC ---------------- */
function isAdmin(){ return S.user && S.user.role==='admin'; }
function myBranches(){ return isAdmin()?Object.keys(S.branches):(S.user.branches||[]).filter(function(b){return S.branches[b];}); }
function existingEntry(branch,cat,date,exceptId){
  return S.entries.filter(function(x){
    return x.branch===branch && x.category===cat && dOf(x.datetime)===date && x.id!==exceptId;
  })[0]||null;
}
function canEdit(e){ if(!e) return true; if(isAdmin()) return true; return (e.status==='draft'||e.status==='rejected')&&e.createdBy===S.user.id; }
function userName(id){ var u=S.users.filter(function(x){return x.id===id;})[0]; return u?u.name:'—'; }

function applyRbac(){
  qsa('[data-admin]').forEach(function(el){ el.classList.toggle('hidden',!isAdmin()); });
  qsa('[data-sup]').forEach(function(el){ el.classList.toggle('hidden',isAdmin()); });
  $('idleLimitTxt').textContent=(idleMs()/60000);
  $('sessionPill').classList.remove('hidden');
  $('navRecordsLabel').textContent=isAdmin()?'Approvals':'My Entries';
  $('userName').textContent=S.user.name;
  $('userRole').textContent=S.user.role;
  $('userInitials').textContent=S.user.name.split(/\s+/).map(function(x){return x[0];}).join('').slice(0,2).toUpperCase();
}

function refreshBranchSelects(){
  var codes=myBranches();
  if(S.branches[S.branch]===undefined||codes.indexOf(S.branch)<0) S.branch=codes[0]||null;
  var opts=codes.map(function(k){ return '<option value="'+esc(k)+'">'+esc(S.branches[k])+'</option>'; }).join('');
  $('branchSelect').innerHTML=opts; if(S.branch) $('branchSelect').value=S.branch;
  var rb=$('recBranch'), keep=rb.value;
  rb.innerHTML='<option value="">All my branches</option>'+opts;
  rb.value=codes.indexOf(keep)>=0?keep:'';
  $('f_branchLabel').textContent=S.branch?S.branches[S.branch]:'—';
  $('wkBranchLabel').textContent=S.branch?S.branches[S.branch]:'—';
}

/* ---------------- purchases ---------------- */
function renderPurchases(){
  var locked=S.editing?!canEdit(S.editing):false;
  var box=$('purchaseRows');
  if(!S.purchases.length){
    box.innerHTML='<p class="text-xs text-slate-400 italic">No purchases recorded for this day. Click “Add purchase” when birds are bought in.'+(isAdmin()?'':' Enter birds and weight only — the admin fills the rate when approving.')+'</p>';
    return;
  }
  box.innerHTML=S.purchases.map(function(p,i){
    return '<div class="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end bg-slate-50 border border-slate-200 rounded-lg p-3 pop">'+
      '<div class="sm:col-span-4"><label class="lbl">Supplier</label><input data-p="supplier" data-i="'+i+'" class="inp" value="'+esc(p.supplier||'')+'" placeholder="Supplier name" '+(locked?'disabled':'')+' /></div>'+
      '<div class="sm:col-span-2"><label class="lbl">Birds</label><input type="number" min="0" step="1" data-p="birds" data-i="'+i+'" class="inp num" value="'+(p.birds||'')+'" '+(locked?'disabled':'')+' /></div>'+
      '<div class="sm:col-span-3"><label class="lbl">Weight</label><div class="kgg"><input type="number" min="0" step="1" data-p="kg" data-i="'+i+'" class="inp num" value="'+(p.wtG?Math.floor(p.wtG/1000):'')+'" '+(locked?'disabled':'')+' /><span>kg</span><input type="number" min="0" max="999" step="1" data-p="g" data-i="'+i+'" class="inp num" value="'+(p.wtG?p.wtG%1000:'')+'" '+(locked?'disabled':'')+' /><span>g</span></div></div>'+
      (isAdmin()
        ? '<div class="sm:col-span-2"><label class="lbl">Rate ₹/kg</label><input type="number" min="0" step="0.01" data-p="rate" data-i="'+i+'" class="inp num" value="'+(p.rate||'')+'" '+(locked?'disabled':'')+' /></div>'
        : '<div class="sm:col-span-2"><label class="lbl">Rate</label><p class="inp !bg-slate-100 text-slate-400 text-xs italic">admin only</p></div>')+
      '<div class="sm:col-span-1 flex justify-end">'+(locked?'':'<button type="button" data-prm="'+i+'" class="h-9 w-9 rounded-lg text-rose-600 hover:bg-rose-100"><i class="fa-solid fa-trash"></i></button>')+'</div>'+
      (isAdmin()?'<div class="sm:col-span-12 text-right text-xs font-bold text-emerald-800">Line value: '+money(num(p.wtG)/1000*num(p.rate))+'</div>':'')+
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
  e.dressedCount=v('f_dressedCount'); e.dressedWtG=gv('f_dressedWt'); e.actualMeatG=gv('f_actualMeat');
  e.skinSoldG=gv('f_skinSold'); e.skinlessSoldG=gv('f_skinlessSold'); e.liverSoldG=gv('f_liverSold');
  e.closeBirds=v('f_closeBirds'); e.closeWtG=gv('f_closeWt'); e.closeMeatG=gv('f_closeMeat');
  e.notes=tv('f_notes'); e.explanation=tv('f_explanation');
  e.photos=S.photos.slice();
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
  setV('f_notes',e.notes); setV('f_explanation',e.explanation);
  S.photos=(e.photos||[]).slice(); S.purchases=(e.purchases||[]).slice();
  renderPhotos(); renderPurchases();
}

/* previous approved day for this branch+category, used for carry-forward */
function previousDay(){
  return S.entries.filter(function(x){ return x.branch===S.branch && x.category===S.cat && x.status==='approved'; })
    .sort(function(a,b){ return a.datetime<b.datetime?1:-1; })[0];
}

function blankForm(){
  fillForm({ datetime:nowLocal(), photos:[], purchases:[] });
  var p=previousDay(), note='';
  if(p){
    var pc=calc(p);
    setV('f_openBirds',p.closeBirds); setG('f_openWt',p.closeWtG); setG('f_openMeat',p.closeMeatG);
    setV('f_openRate',pc.avgRate?pc.avgRate.toFixed(2):'');
    setV('f_rateSkin',p.rateSkin); setV('f_rateSkinless',p.rateSkinless); setV('f_rateLiver',p.rateLiver); setV('f_rateLive',p.rateLive);
    note='Carried forward from '+dOf(p.datetime)+' — '+num(p.closeBirds)+' birds'+(isAdmin()?' @ '+money(pc.avgRate)+'/kg':'');
  } else {
    note='First entry for this branch — opening figures are optional';
  }
  $('carryNote').textContent=note;
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
  {id:'f_actualMeat_kg',label:'Actual meat obtained', test:function(){ return v('f_dressedCount')===0 || gv('f_actualMeat')>0; }},
  {id:'f_closeBirds',label:'Closing birds',           test:function(){ return filled('f_closeBirds'); }},
  {id:'f_closeWt_kg',label:'Closing bird weight',     test:function(){ return v('f_closeBirds')===0 || gv('f_closeWt')>0; }, firstDayOptional:true}
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
  renderPurchases();
}

function loadEntry(id){
  S.editing=id?(S.entries.filter(function(x){return x.id===id;})[0]||null):null;
  S.auto={ closeBirds:!id, closeWt:!id, closeMeat:!id };
  if(S.editing){
    S.cat=S.editing.category; S.branch=S.editing.branch;
    $('branchSelect').value=S.branch; syncSegs(); fillForm(S.editing); $('carryNote').textContent='';
  } else { blankForm(); }
  var e=S.editing, locked=e?!canEdit(e):false;
  lockForm(locked);

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
  /* the date of a SAVED entry may only be moved by an admin */
  var dateLocked = !!e && !isAdmin();
  $('f_datetime').disabled = locked || dateLocked;
  $('f_datetime').title = dateLocked
    ? 'Only an admin can change the date of a saved entry'
    : '';

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
  $('o_meatVar').textContent=fmtW(c.meatVarG);
  $('o_meatVar').className='font-bold num '+(Math.abs(c.meatVarG)>500?'text-rose-600':'text-emerald-700');

  $('o_revenue').textContent=money(c.revenue);
  $('o_cogs').textContent=money(c.cogs);
  $('o_labour').textContent=money(c.labour);
  $('o_otherExp').textContent=money(c.otherExp);
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
    skinAmt:0, skinlessAmt:0, liverAmt:0, manDays:0, days:0, avgRateNum:0, avgRateDen:0 };
  list.forEach(function(e){
    var c=calc(e);
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

/* Labour is tracked in its own ledger, so it is summed over the date range
   independently of whether a daily entry exists or has been approved.        */
function labourRange(codes,from,to){
  var wages=0,other=0,manDays=0,paid=0;
  S.ledger.forEach(function(l){
    if(codes.indexOf(l.branch)<0) return;
    if(l.date<from||l.date>to) return;
    var def=LEDGER_TYPES[l.type]||{};
    if(l.type==='work'){ wages+=num(l.amount); manDays+=num(l.days); }
    else if(l.type==='paid'||l.type==='advance'){ paid+=num(l.amount); }
    else if(def.shop) other+=num(l.amount);
  });
  return { wages:wages, other:other, manDays:manDays, paid:paid };
}

/* fold labour into an aggregate for a given scope + range */
function withLabour(a,codes,from,to){
  var l=labourRange(codes,from,to);
  a.labour=l.wages; a.other=l.other; a.manDays=l.manDays; a.paidOut=l.paid;
  a.net=a.revenue-a.cogs-a.labour-a.other;
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

function renderDashboard(){
  if(!isAdmin()) return;          /* dashboard is admin-only */
  if(!S.branch) return;
  var r=dashRange();
  var list=dashEntries(), a=withLabour(aggregate(list), scopeCodes(), r.from, r.to);
  $('dashScopeLabel').textContent=(S.dashScope==='all'?'All branches':S.branches[S.branch])+
    ' · '+(S.dashCat==='all'?'broiler + parents':S.dashCat)+' · '+dashRange().from+' → '+dashRange().to;

  $('plRevenue').textContent=money0(a.revenue);
  $('plCogs').textContent=money0(a.cogs);
  $('plLabour').textContent=money0(a.labour);
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
  var afterOvh=a.net-ovh.total;
  $('ovhOperating').textContent=money0(a.net);
  $('ovhOperating').className='font-bold num '+(a.net<0?'text-rose-600':'text-emerald-700');
  $('ovhTotal').textContent=ovh.total?'−'+money0(ovh.total):'₹0';
  $('ovhNet').textContent=money0(afterOvh);
  $('ovhNet').className='font-bold num text-xl '+(afterOvh<0?'text-rose-600':'text-emerald-700');
  $('ovhNote').textContent=months.length>1
    ? months.length+' months ('+months[0]+' → '+months[months.length-1]+') · '+ovh.count+' approved item(s)'
    : months[0]+' · '+ovh.count+' approved item(s)';
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
  var purch=(e.purchases||[]).map(function(p){ return row(esc(p.supplier||'Supplier')+' — '+num(p.birds)+' birds', fmtW(p.wtG)+' @ '+money(p.rate)+' = '+money(num(p.wtG)/1000*num(p.rate))); }).join('')||'<p class="text-xs text-slate-400 italic">No purchases.</p>';
  var photos=(e.photos||[]).map(function(src,i){ return '<img src="'+src+'" data-view="'+i+'" alt="Mortality photo '+(i+1)+'" class="h-28 w-28 object-cover rounded-lg border-2 border-slate-200 cursor-zoom-in" />'; }).join('');

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
      block('Dressing', row('Dressed birds',num(e.dressedCount))+row('Live weight',fmtWs(e.dressedWtG))+row('Expected meat @'+(100-c.wastePct)+'%',fmtWs(c.expectedMeatG))+row('Waste @'+c.wastePct+'%',fmtWs(c.wasteMeatG))+row('Actual meat',fmtWs(e.actualMeatG))+row('Yield',pct(c.yieldPct),c.yieldLow?'text-rose-600':c.yieldHigh?'text-amber-600':'text-emerald-700')+row(c.bonusG>0?'Bonus meat':'Shortfall',(c.bonusG>0?fmtWs(c.bonusG):fmtWs(c.shortG))+(isAdmin()?' ≈ '+money0(c.bonusG>0?c.bonusValue:c.shortValue):''),c.bonusG>0?'text-emerald-700':'text-rose-600'))+
      block('Sales', row('Skin',fmtW(e.skinSoldG)+' · '+money(c.skinAmt))+row('Skinless',fmtW(e.skinlessSoldG)+' · '+money(c.skinlessAmt))+row('Liver',fmtW(e.liverSoldG)+' · '+money(c.liverAmt))+row('Live birds',num(e.liveSoldCount)+' · '+money(c.liveAmt))+row('Cutting',money(e.cutCharges))+row('Total revenue',money(c.revenue),'text-emerald-700'))+
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
  foot+='<button data-close="1" class="ml-auto border border-slate-300 text-slate-600 font-bold text-sm px-5 py-2.5 rounded-lg">Close</button>';
  $('reviewFoot').innerHTML=foot;
  bind('rvApprove',function(){ decide(e.id,'approved'); });
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
  return { earned:earned, paid:paid, ded:ded, days:days, balance:earned-paid-ded };
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
    return '<tr class="rowhover"><td class="px-4 py-2.5 font-semibold">'+esc(w.name)+'<span class="block text-xs text-slate-400">'+esc(w.phone||'')+'</span></td>'+
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

  $('pkCount').textContent=ws.length;
  $('pkToday').textContent=presentToday;
  $('pkEarnToday').textContent=money0(earnToday);
  $('pkPaid').textContent=money0(tot.paid+tot.ded);
  $('pkBalance').textContent=money0(tot.bal);

  /* ledger */
  var m=$('wkMonth').value||todayISO().slice(0,7);
  var rows=S.ledger.filter(function(l){ return l.branch===S.branch && String(l.date).slice(0,7)===m; })
    .sort(function(a,b){ return a.date<b.date?1:-1; });
  $('ledgerBody').innerHTML=rows.length?rows.map(function(l){
    var w=S.workers.filter(function(x){return x.id===l.workerId;})[0];
    var def=LEDGER_TYPES[l.type]||{t:l.type,effect:'none'};
    var eff=def.effect==='earn'?['bg-emerald-100 text-emerald-800','Adds to balance']
      :def.effect==='settle'?['bg-slate-200 text-slate-700','Reduces balance']
      :['bg-amber-100 text-amber-800','Company paid — not deducted'];
    return '<tr class="rowhover"><td class="px-4 py-2.5 whitespace-nowrap">'+l.date+'</td>'+
      '<td class="px-4 py-2.5">'+esc(w?w.name:'—')+'</td>'+
      '<td class="px-4 py-2.5 text-slate-600">'+esc(def.t)+(l.type==='work'?' ('+num(l.days)+'d)':'')+'</td>'+
      '<td class="px-4 py-2.5 text-slate-500 text-xs">'+esc(l.note||'')+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-semibold">'+money0(l.amount)+'</td>'+
      '<td class="px-4 py-2.5"><span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full '+eff[0]+'">'+eff[1]+'</span></td>'+
      '<td class="px-4 py-2.5 text-right"><button data-lact="del" data-id="'+l.id+'" class="h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-100"><i class="fa-solid fa-trash"></i></button></td></tr>';
  }).join(''):'<tr><td colspan="7" class="px-4 py-10 text-center text-slate-400">No ledger entries for '+m+'.</td></tr>';
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
      '<div><label class="lbl" for="wkWage">Wage per day (₹)</label><input type="number" min="0" step="10" id="wkWage" class="inp num" value="'+(w.dayWage||S.settings.dayWage||'')+'" /></div>'+
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

function overheadsFor(codes,months){
  var by={}, total=0, count=0;
  S.overheads.forEach(function(o){
    if(o.status!=='approved') return;
    if(codes.indexOf(o.branch)<0) return;
    if(months.indexOf(o.month)<0) return;
    by[o.category]=(by[o.category]||0)+num(o.amount);
    total+=num(o.amount); count++;
  });
  return { by:by, total:total, count:count };
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
  var list=visibleOverheads().filter(function(o){ return o.month===m; })
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
    return '<tr class="rowhover"><td class="px-4 py-2.5 whitespace-nowrap font-semibold">'+esc(o.month)+'</td>'+
      '<td class="px-4 py-2.5 text-slate-600">'+esc(S.branches[o.branch]||o.branch)+'</td>'+
      '<td class="px-4 py-2.5"><i class="fa-solid '+ovhCatIcon(o.category)+' text-slate-400 mr-1.5"></i>'+esc(ovhCatName(o.category))+'</td>'+
      '<td class="px-4 py-2.5 text-xs text-slate-500">'+esc(o.note||'')+(o.rejectReason?'<span class="block text-rose-600 font-semibold">Returned: '+esc(o.rejectReason)+'</span>':'')+'</td>'+
      '<td class="px-4 py-2.5 text-right num font-bold">'+money0(o.amount)+'</td>'+
      '<td class="px-4 py-2.5 text-xs text-slate-500">'+esc(userName(o.createdBy))+'</td>'+
      '<td class="px-4 py-2.5">'+statusChip(o.status)+'</td>'+
      '<td class="px-4 py-2.5 text-right whitespace-nowrap">'+
        (isAdmin()&&o.status!=='approved'?'<button data-ovh="ok" data-id="'+o.id+'" title="Approve" class="h-8 w-8 rounded-lg text-emerald-700 hover:bg-emerald-100"><i class="fa-solid fa-circle-check"></i></button>':'')+
        (isAdmin()&&o.status==='pending'?'<button data-ovh="no" data-id="'+o.id+'" title="Return" class="h-8 w-8 rounded-lg text-amber-600 hover:bg-amber-100"><i class="fa-solid fa-circle-xmark"></i></button>':'')+
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

function exportCsv(){
  var list=filteredEntries(); if(!list.length){ toast('Nothing to export.','warn'); return; }
  var kg=function(g){ return (num(g)/1000).toFixed(3); };
  var COST=['Opening Rate','Purchase Amount','Avg Cost Rate','Mortality Value','Damage Value',
            'Stock Cost','Labour','Other Exp','Net Profit','Closing Value'];
  var head=['Date','Time','Branch','Category','Opening Birds','Opening Wt','Opening Rate','Open Meat','Purchase Birds','Purchase Wt','Purchase Amount',
    'Avg Cost Rate','Skin Rate','Skinless Rate','Liver Rate','Live Rate','Live Sold Nos','Live Sold Wt','Live Amount','Cutting',
    'Mortality Nos','Mortality Wt','Mortality Value','Photos','Damage Meat','Damage Value','Dressed Birds','Dressed Live Wt',
    'Expected Meat','Waste %','Waste Meat','Actual Meat','Yield %','Bonus Meat','Short Meat','Skin Sold','Skinless Sold','Liver Sold',
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
    c.revenue.toFixed(2), c.cogs.toFixed(2), c.labour.toFixed(2), c.otherExp.toFixed(2), c.netProfit.toFixed(2),
    num(e.closeBirds), kg(e.closeWtG), kg(e.closeMeatG), c.closeValue.toFixed(2),
    e.status, userName(e.createdBy), e.reviewedBy?userName(e.reviewedBy):'', e.rejectReason||'', e.explanation||'', e.notes||''
  ];});
  var csv=[keep(head)].concat(rows.map(keep)).map(function(r){ return r.map(function(c){ var s=String(c==null?'':c); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }).join(','); }).join('\r\n');
  download(new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8;'}),'VCC_entries_'+todayISO()+'.csv');
  logAct('Exported CSV',list.length+' record(s)'+(isAdmin()?'':' (cost columns excluded)'));
  toast('Exported '+list.length+' record(s).');
}

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
  runChicken();
  qsa('.view').forEach(function(p){ p.classList.add('hidden'); p.classList.remove('view-enter'); });
  var el=$('view-'+name); el.classList.remove('hidden'); void el.offsetWidth; el.classList.add('view-enter');
  qsa('#mainNav .tab-btn').forEach(function(b){ b.classList.toggle('active',b.getAttribute('data-view')===name); });
  if(name==='dashboard') renderDashboard();
  if(name==='records') renderRecords();
  if(name==='workers') renderWorkers();
  if(name==='overheads') renderOverheads();
  if(name==='admin') renderAdmin();
  window.scrollTo({top:0,behavior:'smooth'});
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
  qsa('[data-auto]').forEach(function(b){ b.addEventListener('click',function(){
    var k=b.getAttribute('data-auto'); S.auto[k]=!S.auto[k]; recalc();
    toast(S.auto[k]?'Field back on auto-calculate.':'Field switched to manual entry.');
  }); });
  ['f_closeBirds'].forEach(function(id){ $(id).addEventListener('input',function(){ S.auto.closeBirds=false; }); });
  ['f_closeWt_kg','f_closeWt_g'].forEach(function(id){ $(id).addEventListener('input',function(){ S.auto.closeWt=false; }); });
  ['f_closeMeat_kg','f_closeMeat_g'].forEach(function(id){ $(id).addEventListener('input',function(){ S.auto.closeMeat=false; }); });
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
  $('btnWipe').addEventListener('click',function(){ if(confirm('Permanently delete ALL data?')){ DB.clearAll(); location.reload(); } });

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
    S.users = d.users || [];
    S.settings = d.settings || {};
    IDLE_MS[d.user.role] = (d.idleMinutes || 10) * 60 * 1000;
    return d;
  });
}

function refreshAllViews() {
  refreshBranchSelects();
  renderRecords();
  renderDashboard();
  renderWorkers();
  renderOverheads();
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

  var p = S.editing
    ? api('PUT', '/entries/' + S.editing.id, e)
    : api('POST', '/entries', e);

  p.then(function (rec) {
    upsertEntry(rec);
    toast(status === 'draft' ? 'Draft saved.' : status === 'pending' ? 'Sent to admin for approval.' : 'Changes saved.');
    loadEntry(rec.id);
    renderRecords(); renderDashboard(); updatePendingBadge();
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
    if (S.editing && S.editing.id === id) loadEntry(id);
    renderRecords(); renderDashboard(); updatePendingBadge();
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

/* ---------------- labour ---------------- */
function markAttendance(workerId, days) {
  var date = $('wkDate').value || todayISO();
  var w = S.workers.filter(function (x) { return x.id === workerId; })[0]; if (!w) return;
  api('POST', '/ledger', { branch: w.branch, workerId: workerId, date: date, type: 'work', days: days })
    .then(function () { return bootstrap(); })
    .then(function () { renderWorkers(); recalc(); renderDashboard(); })
    .catch(apiFail);
}

function workerModal(w) {
  w = w || {};
  openGen(w.id ? 'Edit worker' : 'Add worker',
    '<div class="space-y-3">' +
    '<div><label class="lbl" for="wkName">Name</label><input id="wkName" class="inp" value="' + esc(w.name || '') + '" /></div>' +
    '<div class="grid grid-cols-2 gap-3">' +
    '<div><label class="lbl" for="wkRole">Role</label><select id="wkRole" class="inp">' +
    ['dresser', 'cutter', 'helper', 'cashier', 'driver'].map(function (r) { return '<option value="' + r + '"' + (w.role === r ? ' selected' : '') + '>' + r.charAt(0).toUpperCase() + r.slice(1) + '</option>'; }).join('') + '</select></div>' +
    '<div><label class="lbl" for="wkWage">Wage per day (₹)</label><input type="number" min="0" step="10" id="wkWage" class="inp num" value="' + (w.dayWage || S.settings.dayWage || '') + '" /></div>' +
    '</div>' +
    '<div><label class="lbl" for="wkPhone">Phone (optional)</label><input id="wkPhone" class="inp" value="' + esc(w.phone || '') + '" /></div>' +
    '<button id="wkSave" class="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg mt-2">Save worker</button></div>');
  bind('wkSave', function () {
    var name = tv('wkName');
    if (!name) { toast('Enter a name.', 'error'); return; }
    if (v('wkWage') <= 0) { toast('Enter the daily wage.', 'error'); return; }
    var body = { branch: S.branch, name: name, role: tv('wkRole'), dayWage: v('wkWage'), phone: tv('wkPhone') };
    var p = w.id ? api('PUT', '/workers/' + w.id, body) : api('POST', '/workers', body);
    p.then(function () { return bootstrap(); })
      .then(function () { closeModal('genModal'); renderWorkers(); toast('Worker saved.'); })
      .catch(apiFail);
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
    '<div><label class="lbl" for="lgDate">Date</label><input type="date" id="lgDate" class="inp" value="' + ($('wkDate').value || todayISO()) + '" /></div>' +
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
    api('POST', '/ledger', { branch: S.branch, workerId: tv('lgWorker'), date: tv('lgDate'),
      type: tv('lgType'), amount: v('lgAmt'), note: tv('lgNote') })
      .then(function () { return bootstrap(); })
      .then(function () { closeModal('genModal'); renderWorkers(); recalc(); renderDashboard(); toast('Saved.'); })
      .catch(apiFail);
  });
}

/* ---------------- overheads ---------------- */
function overheadModal() {
  openGen('Add a monthly overhead',
    '<div class="space-y-3">' +
    '<div class="grid grid-cols-2 gap-3">' +
    '<div><label class="lbl" for="ovMonth">Month</label><input type="month" id="ovMonth" class="inp" value="' + ($('ovhMonth').value || todayISO().slice(0, 7)) + '" /></div>' +
    '<div><label class="lbl" for="ovAmt">Amount (₹)</label><input type="number" min="0" step="1" id="ovAmt" class="inp num" /></div>' +
    '</div>' +
    '<div><label class="lbl" for="ovCat">Category</label><select id="ovCat" class="inp">' +
    OVERHEAD_CATS.map(function (c) { return '<option value="' + c.v + '">' + c.t + '</option>'; }).join('') + '</select></div>' +
    '<div><label class="lbl" for="ovNote">Note / bill reference</label><input id="ovNote" class="inp" placeholder="e.g. electricity bill 4412, August" /></div>' +
    '<p class="text-xs rounded-lg px-3 py-2 bg-amber-50 text-amber-800 border border-amber-200 font-semibold">Charged once at month end. It will not change any single day&rsquo;s profit, and needs admin approval to count.</p>' +
    '<button id="ovSave" class="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm px-5 py-2.5 rounded-lg">Submit for approval</button></div>');
  bind('ovSave', function () {
    if (v('ovAmt') <= 0) { toast('Enter an amount.', 'error'); return; }
    api('POST', '/overheads', { branch: S.branch, month: tv('ovMonth'), category: tv('ovCat'),
      amount: v('ovAmt'), note: tv('ovNote') })
      .then(function (rec) {
        S.overheads.push(rec);
        closeModal('genModal'); $('ovhMonth').value = rec.month;
        renderOverheads(); renderDashboard();
        toast(isAdmin() ? 'Overhead recorded.' : 'Sent to admin for approval.');
      }).catch(apiFail);
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
  applyRbac(); refreshBranchSelects();
  $('dashFrom').value = monthStart(); $('dashTo').value = todayISO();
  $('recFrom').value = addDays(todayISO(), -30); $('recTo').value = todayISO();
  $('wkDate').value = todayISO(); $('wkMonth').value = todayISO().slice(0, 7);
  $('ovhMonth').value = todayISO().slice(0, 7);
  if (isAdmin()) $('recStatus').value = 'pending';
  bumpActivity(); tickSession();
  syncSegs(); loadEntry(null); updatePendingBadge();
  showView(isAdmin() ? 'dashboard' : 'entry');
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
  }).catch(function () { $('loginUser').focus(); });
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
    loadEntry(null); renderDashboard(); renderRecords(); renderWorkers(); renderOverheads();
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
      renderDashboard();
    });
  });
  ['dashFrom', 'dashTo'].forEach(function (id) { $(id).addEventListener('change', renderDashboard); });

  /* ---- daily entry ---- */
  $('entryForm').addEventListener('input', recalc);
  $('entryForm').addEventListener('submit', function (ev) { ev.preventDefault(); });
  $('btnAddPurchase').addEventListener('click', function () {
    S.purchases.push({ supplier: '', birds: 0, wtG: 0, rate: 0 }); renderPurchases(); recalc();
  });
  $('purchaseRows').addEventListener('input', function (ev) {
    var el = ev.target.closest('[data-p]'); if (!el) return;
    var i = +el.getAttribute('data-i'), f = el.getAttribute('data-p'), p = S.purchases[i]; if (!p) return;
    if (f === 'supplier') p.supplier = el.value;
    else if (f === 'birds') p.birds = num(el.value);
    else if (f === 'rate') p.rate = num(el.value);
    else {
      var kgEl = $('purchaseRows').querySelector('[data-p="kg"][data-i="' + i + '"]');
      var gEl = $('purchaseRows').querySelector('[data-p="g"][data-i="' + i + '"]');
      p.wtG = num(kgEl && kgEl.value) * 1000 + num(gEl && gEl.value);
    }
    recalc();
  });
  $('purchaseRows').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-prm]'); if (!b) return;
    S.purchases.splice(+b.getAttribute('data-prm'), 1); renderPurchases(); recalc();
  });
  qsa('[data-auto]').forEach(function (b) {
    b.addEventListener('click', function () {
      var k = b.getAttribute('data-auto'); S.auto[k] = !S.auto[k]; recalc();
      toast(S.auto[k] ? 'Field back on auto-calculate.' : 'Field switched to manual entry.');
    });
  });
  $('f_closeBirds').addEventListener('input', function () { S.auto.closeBirds = false; });
  ['f_closeWt_kg', 'f_closeWt_g'].forEach(function (id) { $(id).addEventListener('input', function () { S.auto.closeWt = false; }); });
  ['f_closeMeat_kg', 'f_closeMeat_g'].forEach(function (id) { $(id).addEventListener('input', function () { S.auto.closeMeat = false; }); });

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
  ['recFrom', 'recTo', 'recBranch', 'recCat', 'recStatus'].forEach(function (id) { $(id).addEventListener('change', renderRecords); });
  $('btnRecExport').addEventListener('click', exportCsv);
  $('btnRecPrint').addEventListener('click', printReport);
  $('recBody').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-act]'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
    if (act === 'review') openReview(id);
    else if (act === 'edit') { showView('entry'); loadEntry(id); }
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
  $('wkMonth').addEventListener('change', renderWorkers);
  $('btnAddWorker').addEventListener('click', function () { workerModal(null); });
  $('btnPayWorker').addEventListener('click', function () { ledgerModal('pay'); });
  $('btnAddExpense').addEventListener('click', function () { ledgerModal('exp'); });
  $('attendanceGrid').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-att]'); if (!b) return;
    markAttendance(b.getAttribute('data-att'), parseFloat(b.getAttribute('data-days')));
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
    api('DELETE', '/ledger/' + b.getAttribute('data-id')).then(function () { return bootstrap(); })
      .then(function () { renderWorkers(); recalc(); renderDashboard(); toast('Ledger entry removed.', 'warn'); })
      .catch(apiFail);
  });

  /* ---- overheads ---- */
  $('ovhMonth').addEventListener('change', renderOverheads);
  $('btnAddOverhead').addEventListener('click', overheadModal);
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
  $('btnActExport').addEventListener('click', function () {
    var rows = [['When', 'User', 'Role', 'Branch', 'Action', 'Detail']].concat((S.activity || []).map(function (a) {
      return [a.at, a.userName, a.role, a.branch, a.action, a.detail];
    }));
    var csv = rows.map(function (r) { return r.map(function (c) { var s = String(c == null ? '' : c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(','); }).join('\r\n');
    download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }), 'VCC_activity_' + todayISO() + '.csv');
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
  $('btnWipe').addEventListener('click', function () {
    if (!confirm('Permanently delete ALL operational data on the server?')) return;
    api('POST', '/admin/wipe', {}).then(function () { return bootstrap(); })
      .then(function () { renderAdmin(); refreshAllViews(); loadEntry(null); toast('All data cleared.', 'warn'); })
      .catch(apiFail);
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
}


if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
