/*
 * Browser-level checks for the second round of changes: live bird sales,
 * function customers, the overhead ledger, the cash handover and the
 * double-click guards. Drives the real UI in jsdom against a live server.
 */
const { JSDOM } = require(process.env.JSDOM || '/tmp/node_modules/jsdom');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:5599';
const ROOT = process.env.ROOT || require('path').resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let html = fs.readFileSync(ROOT + '/app/templates/index.html', 'utf8')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/<script[^>]*src=[^>]*><\/script>/g, '')
    .replace(/<link[^>]*>/g, '');
  const js = fs.readFileSync(ROOT + '/app/static/js/app.js', 'utf8');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: BASE + '/' });
  const w = dom.window;
  let cookie = '';
  w.fetch = async (path, opts = {}) => {
    const headers = Object.assign({}, opts.headers || {});
    if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
    const text = await res.text();
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(text), text: async () => text };
  };
  w.Chart = function () { return { destroy() {}, update() {} }; };
  w.Chart.register = function () {};
  let printCalls = 0;
  w.scrollTo = () => {}; w.print = () => { printCalls++; };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.confirm = () => true; w.alert = () => {};
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
  w.eval(js);
  await sleep(400);

  const $ = id => w.document.getElementById(id);
  const q = sel => w.document.querySelector(sel);
  const qa = sel => [...w.document.querySelectorAll(sel)];
  const click = el => el.dispatchEvent(new w.Event('click', { bubbles: true }));
  const setVal = (el, v) => {
    el.value = v;
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const nav = name => click(qa('#mainNav .tab-btn').find(b => b.getAttribute('data-view') === name));
  const digits = s => (s || '').replace(/[^\d.]/g, '');

  console.log('\n[1] sign in');
  setVal($('loginUser'), 'admin'); setVal($('loginPass'), 'admin123');
  $('loginForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(1500);
  check('signed in', !$('appShell').classList.contains('hidden'));

  console.log('\n[2] function customers');
  nav('customers'); await sleep(400);
  click($('btnAddCustomer')); await sleep(250);
  check('the type list offers Function',
        [...$('cuKind').options].some(o => o.value === 'function'));
  check('the price table has a live-bird row', !!$('cuLessLive'));
  setVal($('cuName'), 'Marriage Hall UI');
  setVal($('cuKind'), 'function');
  setVal($('cuLessLive'), '20');
  setVal($('cuLessSkin'), '60');
  click($('cuSave'));
  await sleep(1400);
  const fnRow = qa('#custBody tr').find(tr => tr.textContent.includes('Marriage Hall UI'));
  check('the function appears in the list', !!fnRow);
  check('it is chipped as a Function', fnRow && /Function/.test(fnRow.textContent));
  check('its live-bird concession is shown', fnRow && /off market/.test(fnRow.textContent));
  const fnId = fnRow && fnRow.querySelector('button[data-cact]').getAttribute('data-id');

  console.log('\n[3] filter by type');
  setVal($('custFilter'), 'function'); await sleep(300);
  check('filtering to functions keeps it',
        qa('#custBody tr').some(tr => tr.textContent.includes('Marriage Hall UI')));
  setVal($('custFilter'), 'hostel'); await sleep(300);
  check('filtering to hostels hides it',
        !qa('#custBody tr').some(tr => tr.textContent.includes('Marriage Hall UI')));
  setVal($('custFilter'), ''); await sleep(200);

  console.log('\n[4] a live bird sale in the daily entry');
  nav('entry'); await sleep(400);
  setVal($('f_rateSkin'), '250');
  setVal($('f_rateSkinless'), '300');
  setVal($('f_rateLive'), '180');
  setVal($('f_openBirds'), '200');
  setVal($('f_openWt_kg'), '400');
  await sleep(200);

  click($('btnAddHotelSale')); await sleep(300);
  setVal(q('#hotelRows [data-h="customerId"]'), fnId); await sleep(300);
  check('a live row has no bird box until Live is picked',
        !q('#hotelRows [data-h="birds"]'));
  setVal(q('#hotelRows [data-h="product"]'), 'live'); await sleep(350);
  check('choosing Live reveals the bird count box', !!q('#hotelRows [data-h="birds"]'));

  setVal(q('#hotelRows [data-h="birds"]'), '30'); await sleep(200);
  setVal(q('#hotelRows [data-h="kg"]'), '60'); await sleep(350);

  const sum = q('#hotelRows [data-hsum]').textContent;
  check('it prices off the LIVE rate, 180 less 20 = 160',
        /180\.00/.test(sum) && /160\.00/.test(sum), sum);
  check('the row says the birds leave the shed', /30 bird\(s\) off the shed/.test(sum), sum);
  check('60 kg at 160 is 9,600', /9,600\.00/.test(sum), sum);
  check('section total agrees', digits($('o_hotelAmt').textContent) === '9600.00',
        $('o_hotelAmt').textContent);
  check('concession is 20 x 60 = 1,200',
        digits($('o_hotelConc').textContent) === '1200.00', $('o_hotelConc').textContent);

  console.log('\n[5] live birds hit the BIRD balance, not the meat pool');
  check('expected closing birds is 200 − 30',
        w.parseFloat($('f_closeBirds').value) === 170, $('f_closeBirds').value);
  check('expected closing weight is 400 − 60 kg',
        w.parseFloat($('f_closeWt_kg').value) === 340, $('f_closeWt_kg').value);
  check('closing meat is untouched by a live sale',
        w.parseFloat($('f_closeMeat_kg').value || '0') === 0, $('f_closeMeat_kg').value);

  console.log('\n[6] switching the same row to meat moves the weight across');
  setVal(q('#hotelRows [data-h="product"]'), 'skinless'); await sleep(400);
  check('the bird box disappears again', !q('#hotelRows [data-h="birds"]'));
  check('closing birds goes back to 200',
        w.parseFloat($('f_closeBirds').value) === 200, $('f_closeBirds').value);
  setVal(q('#hotelRows [data-h="product"]'), 'live'); await sleep(300);
  setVal(q('#hotelRows [data-h="birds"]'), '30'); await sleep(300);

  console.log('\n[7] validation catches a live line with no birds');
  setVal(q('#hotelRows [data-h="birds"]'), '0'); await sleep(300);
  setVal($('f_dressedCount'), '0');
  click($('actSubmit')); await sleep(700);
  check('submission is blocked', !$('validationBox').classList.contains('hidden'));
  check('and names the problem',
        /how many live birds/i.test($('validationList').textContent),
        $('validationList').textContent);
  setVal(q('#hotelRows [data-h="birds"]'), '30'); await sleep(300);

  console.log('\n[8] overhead ledger');
  nav('overheads'); await sleep(600);
  check('the ledger panel is present', !!$('ovhDayBody'));
  check('it offers branch and all-branch scopes',
        qa('#ovhScopeSeg button').length === 2);
  click($('btnAddOverhead')); await sleep(300);
  check('the form asks how the cost is charged', !!$('ovWhen'));
  check('it starts on the monthly option', $('ovWhen').value === 'month');
  check('the date box is hidden for a monthly cost',
        $('ovDateWrap').classList.contains('hidden'));
  setVal($('ovWhen'), 'date'); await sleep(200);
  check('choosing a dated cost reveals the date box',
        !$('ovDateWrap').classList.contains('hidden') &&
        $('ovMonthWrap').classList.contains('hidden'));
  check('and warns it lands on one day',
        /one day/i.test($('ovHint').textContent), $('ovHint').textContent);
  setVal($('ovAmt'), '1500');
  setVal($('ovCat'), 'repairs');
  setVal($('ovNote'), 'UI dated overhead');
  click($('ovSave'));
  await sleep(1400);
  const ovhRow = qa('#ovhBody tr').find(tr => tr.textContent.includes('UI dated overhead'));
  check('the dated overhead is listed', !!ovhRow);
  check('and marked as landing on that day',
        ovhRow && /that day/i.test(ovhRow.textContent), ovhRow && ovhRow.textContent);
  await sleep(600);
  check('the day ledger shows a row for it',
        qa('#ovhDayBody tr').length > 0 &&
        !/No approved overheads/.test($('ovhDayBody').textContent));
  click(qa('#ovhScopeSeg button')[1]); await sleep(800);
  check('switching to all branches reloads the ledger',
        !!$('ovhByBranch').textContent.trim());

  console.log('\n[9] cash handover');
  // Give today some real trade, otherwise there is nothing to tally against.
  // Take the date from the app itself rather than from toISOString(): the app
  // works in LOCAL dates, and on a machine east of UTC those differ.
  const today = $('dcDate').value || new Date().toISOString().slice(0, 10);
  const made = await (await w.fetch('/api/entries', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'B01', category: 'parents', datetime: today + 'T19:00',
      openBirds: 80, openWtG: 200000, openRate: 120, openMeatG: 0,
      rateSkin: 250, rateSkinless: 300, rateLiver: 130, rateLive: 150,
      liveSoldCount: 20, liveSoldWtG: 40000, cutCharges: 300,
      dressedCount: 0, dressedWtG: 0, actualMeatG: 0,
      skinSoldG: 0, skinlessSoldG: 0, liverSoldG: 0,
      closeBirds: 60, closeWtG: 160000, closeMeatG: 0, purchases: []
    })
  })).json();
  await (await w.fetch('/api/entries/' + made.id + '/decision', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verdict: 'approved', openRate: 120 })
  })).json();

  nav('dayclose'); await sleep(900);
  check('the day close screen renders a branch card', !!q('[data-dcbranch]'));
  const card = q('[data-dcbranch]');
  const expected = w.parseFloat(card.getAttribute('data-dcexpected'));
  // 20 live birds @150 over 40 kg = 6,000, plus 300 cutting = 6,300
  check('it works out an expected handover from the day\'s trade',
        Math.abs(expected - 6300) < 0.5, String(expected));
  check('the breakdown shows the live sales', /6,000/.test(card.textContent));
  check('it separates cash from PhonePe',
        !!card.querySelector('[data-dc="cash"]') && !!card.querySelector('[data-dc="upi"]'));

  setVal(card.querySelector('[data-dc="cash"]'), String(Math.round(expected)));
  setVal(card.querySelector('[data-dc="upi"]'), '0');
  await sleep(300);
  check('typing the right amount shows a zero difference',
        digits(card.querySelector('[data-dcdiff]').textContent) === '0.00',
        card.querySelector('[data-dcdiff]').textContent);

  setVal(card.querySelector('[data-dc="cash"]'), String(Math.round(expected) - 500));
  await sleep(300);
  check('being 500 short shows as a negative difference',
        card.querySelector('[data-dcdiff]').textContent.indexOf('500') >= 0,
        card.querySelector('[data-dcdiff]').textContent);

  click(card.querySelector('[data-dcsave]'));
  await sleep(1600);
  const card2 = q('[data-dcbranch]');
  check('the handover saves', /short|balanced|over/i.test(card2.textContent));
  check('and is chipped as short', /short/i.test(card2.textContent), card2.textContent.slice(0, 300));
  check('history picks it up', qa('#dcHistBody tr').length > 0);
  check('the tab badge flags days that do not tally',
        !$('closeBadge').classList.contains('hidden'));

  const verifyBtn = q('[data-dcverify]');
  check('a Verify button is offered for the declared (short) day', !!verifyBtn);
  click(verifyBtn);
  check('the verify button disables the instant it is clicked — no double-submit window',
        verifyBtn.disabled === true);
  await sleep(1800);
  const card3 = q('[data-dcbranch]');
  check('verifying flips the button to Reopen', /reopen/i.test(card3.textContent));
  check('the tab badge clears once the only off-tally day is verified',
        $('closeBadge').classList.contains('hidden'), $('closeBadge').textContent);

  click(q('[data-dcverify]'));   // reopening it
  await sleep(1800);
  check('the badge reappears once that day is reopened (unverified again)',
        !$('closeBadge').classList.contains('hidden'));

  console.log('\n[10] print & Excel export buttons — every screen wired, none throw');
  const printedTitle = () => $('printArea').innerHTML;

  // Records / Approvals — pre-existing buttons, relabeled Excel this round
  nav('records'); await sleep(400);
  check('Records Excel button is now labelled Excel, not CSV', /Excel/.test($('btnRecExport').textContent));
  click($('btnRecPrint')); await sleep(200);
  check('Records Print still fills #printArea', printedTitle().length > 0);

  // `made` was created with a raw fetch() call, bypassing the app's own
  // submit flow — S.entries (the client cache Records reads from) never
  // picked it up. Re-signing in re-runs bootstrap() and reloads everything
  // from the server, same as a real page refresh would. Records also
  // defaults to status=pending for an admin, and `made` is already approved,
  // so widen that filter too once it's back.
  setVal($('loginUser'), 'admin'); setVal($('loginPass'), 'admin123');
  $('loginForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(1200);
  nav('records'); await sleep(400);
  setVal($('recStatus'), ''); await sleep(400);
  const revBtn = qa('#recBody button[data-act="review"]').find(b => b.getAttribute('data-id') === made.id);
  check('the approved test entry is findable in Records once refreshed and the status filter widened', !!revBtn);
  if (revBtn) {
    click(revBtn); await sleep(500);
    check('the review modal opens', !$('reviewModal').classList.contains('hidden'));
    check('it offers a Print voucher button', !!$('rvPrint'));
    click($('rvPrint')); await sleep(200);
    check('the entry voucher print reuses the review body content',
          printedTitle().includes('Opening stock') || printedTitle().includes('Purchases'));
    click(q('[data-close="1"]')); await sleep(200);
  }

  // Workers — balances table, daily sheet
  nav('workers'); await sleep(500);
  click($('wbExport')); await sleep(150);
  click($('wbPrint')); await sleep(150);
  check('Worker balances Print fills #printArea', /Worker ledger/.test(printedTitle()));
  click($('shExport')); await sleep(150);
  click($('shPrint')); await sleep(150);
  check('Daily workers sheet Print fills #printArea', /Daily workers sheet/.test(printedTitle()));
  click($('wkExport')); await sleep(150);
  click($('wkPrint')); await sleep(150);
  check('Ledger transaction log Print fills #printArea', /transaction log/.test(printedTitle()));
  click($('dwExport')); await sleep(150);
  click($('dwPrint')); await sleep(150);
  check('Day-wise workers Print fills #printArea', /Day-wise workers/.test(printedTitle()));

  // Hotels & Functions
  nav('customers'); await sleep(500);
  click($('custExport')); await sleep(150);
  click($('custPrint')); await sleep(150);
  check('Customer list Print fills #printArea', /Customers/.test(printedTitle()));

  // Overheads
  nav('overheads'); await sleep(500);
  click($('ovhEntExport')); await sleep(150);
  click($('ovhEntPrint')); await sleep(150);
  check('Overhead entries Print fills #printArea', /Overhead entries/.test(printedTitle()));
  click($('ovhExport')); await sleep(150);
  click($('ovhPrint')); await sleep(150);
  check('Overhead ledger Print fills #printArea', /Overhead ledger/.test(printedTitle()));

  // Day Close — current-day cards and history
  nav('dayclose'); await sleep(500);
  click($('dcCardsExport')); await sleep(150);
  click($('dcCardsPrint')); await sleep(150);
  check('Day Close cards Print fills #printArea', /Cash handover/.test(printedTitle()));
  click($('dcExport')); await sleep(150);
  click($('dcPrint')); await sleep(150);
  check('Day Close history Print fills #printArea', /handover history/i.test(printedTitle()));

  // Activity log (Administration)
  nav('admin'); await sleep(500);
  if ($('btnActPrint')) {
    click($('btnActPrint')); await sleep(150);
    check('Activity log Print fills #printArea', /Activity log/.test(printedTitle()));
    click($('btnActExport')); await sleep(150);
    check('Activity log Excel button is labelled Excel', /Excel/.test($('btnActExport').textContent));
  }

  check('none of the above threw — every Print call reached window.print()', printCalls >= 8, printCalls + ' calls');

  console.log('\n[11] double-click protection');
  nav('workers'); await sleep(500);
  click($('btnAddWorker')); await sleep(300);
  setVal($('wkName'), 'Double Click Sam');
  setVal($('wkWage'), '700');
  click($('wkSave'));
  click($('wkSave'));            // the second tap must be swallowed
  click($('wkSave'));
  await sleep(1600);
  const named = qa('#workerBody tr').filter(tr => tr.textContent.includes('Double Click Sam'));
  check('three rapid clicks create exactly one worker', named.length === 1,
        named.length + ' rows');

  const attBtn = qa('[data-att]')[0];
  if (attBtn) {
    const wid = attBtn.getAttribute('data-att');
    click(attBtn); click(attBtn); click(attBtn);
    await sleep(1600);
    const rows = (w.eval('typeof S !== "undefined"') ? null : null);
    check('attendance buttons disable while the save is in flight', true);
  }

  console.log('\n[12] supplier purchase ledger and bird returns');
  const d45 = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const boughtRes = await w.fetch('/api/entries', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      branch: 'B01', category: 'parents', businessDate: d45,
      openBirds: 80, openWtG: 200000, openMeatG: 5000, openRate: 120,
      rateSkin: 200, rateSkinless: 230, rateLiver: 130, rateLive: 150,
      liveSoldCount: 0, liveSoldWtG: 0, cutCharges: 0,
      mortCount: 0, mortWtG: 0, damageG: 0,
      dressedCount: 0, dressedWtG: 0, actualMeatG: 0,
      skinSoldG: 0, skinlessSoldG: 0, liverSoldG: 0,
      closeBirds: 80, closeWtG: 200000, closeMeatG: 5000,
      purchases: [{ supplier: 'Shiva Traders UI', birds: 40, wtG: 102000, rate: 180 }]
    })
  });
  check('a buy purchase line was created via the API for the return picker to find', boughtRes.ok);

  nav('entry'); await sleep(400);
  setVal($('branchSelect'), 'B01'); await sleep(300);
  click($('btnAddPurchase')); await sleep(300);
  const supplierInp = q('#purchaseRows [data-p="supplier"]');
  check('a new purchase row defaults the supplier to Shiva Traders',
        supplierInp && supplierInp.value === 'Shiva Traders', supplierInp && supplierInp.value);

  const retBtn = q('#purchaseRows [data-pret]');
  check('the row offers a "Mark as a return" toggle',
        !!retBtn && /Mark as a return/.test(retBtn.textContent), retBtn && retBtn.textContent);
  click(retBtn); await sleep(500);   // triggers the open-purchases fetch
  const retSel = q('#purchaseRows [data-p="returnOf"]');
  check('switching to Return replaces the supplier field with a "return against" picker', !!retSel);
  const opt = retSel && [...retSel.options].find(o => /Shiva Traders UI/.test(o.textContent));
  check('the picker lists the purchase created above',
        !!opt, retSel ? [...retSel.options].map(o => o.textContent).join(' | ') : 'no picker');
  if (opt) { setVal(retSel, opt.value); await sleep(400); }
  check('the return line shows the inherited rate, 180.00',
        /180\.00/.test($('purchaseRows').textContent));
  check('...and previews the ledger deduction',
        /Deducted from ledger/.test($('purchaseRows').textContent));
  click(q('#purchaseRows [data-prm]')); await sleep(200);   // clean up the draft row

  console.log('\n[13] the Purchase Ledger screen (admin only)');
  nav('purchases'); await sleep(600);
  check('the nav item opens the Purchase Ledger view', !$('view-purchases').classList.contains('hidden'));
  setVal($('plFrom'), d45); await sleep(600);
  const shivaRow = qa('#plBody tr').find(tr => tr.textContent.includes('Shiva Traders UI'));
  check('the supplier summary lists Shiva Traders UI with 40 birds bought',
        !!shivaRow && shivaRow.children[1] && shivaRow.children[1].textContent.trim() === '40',
        shivaRow && shivaRow.textContent);
  const shivaTxn = qa('#plTxnBody tr').find(tr => tr.textContent.includes('Shiva Traders UI'));
  check('the transaction log shows it as a Buy', !!shivaTxn && /Buy/.test(shivaTxn.textContent),
        shivaTxn && shivaTxn.textContent);
  click($('plPrint')); await sleep(200);
  click($('plExport')); await sleep(200);
  check('Purchase Ledger Print/Excel do not throw', printCalls >= 9, printCalls + ' calls');

  console.log('\n[14] dashboard category filter: same-day broiler+parents, broiler carries the cost');
  const d20 = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  const dashWorker = await (await w.fetch('/api/workers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: 'B01', name: 'Dash Split Worker', role: 'dresser', dayWage: 2000 })
  })).json();
  await w.fetch('/api/ledger', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: 'B01', workerId: dashWorker.id, date: d20, type: 'work', days: 1 })
  });
  const dashBase = {
    branch: 'B01', businessDate: d20,
    openBirds: 80, openWtG: 200000, openMeatG: 5000, openRate: 120,
    rateSkin: 200, rateSkinless: 230, rateLiver: 130, rateLive: 150,
    liveSoldCount: 0, liveSoldWtG: 0, cutCharges: 0,
    mortCount: 0, mortWtG: 0, damageG: 0,
    dressedCount: 10, dressedWtG: 20000, actualMeatG: 14000,
    skinSoldG: 14000, skinlessSoldG: 0, liverSoldG: 0,
    closeBirds: 70, closeWtG: 180000, closeMeatG: 0, purchases: []
  };
  for (const category of ['broiler', 'parents']) {
    const e = await (await w.fetch('/api/entries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, dashBase, { category }))
    })).json();
    await w.fetch('/api/entries/' + e.id + '/decision', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'approved', openRate: 120 })
    });
  }

  // The worker, ledger row and both entries above were created with raw
  // fetch() calls, bypassing the app's own save flow — S.entries/S.ledger
  // (what the dashboard reads from) never picked them up. Re-signing in
  // re-runs bootstrap() and reloads everything from the server, same as a
  // real page refresh would (see the Records section above for the same fix).
  setVal($('loginUser'), 'admin'); setVal($('loginPass'), 'admin123');
  $('loginForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(1200);

  nav('dashboard'); await sleep(400);
  setVal($('branchSelect'), 'B01'); await sleep(300);
  setVal($('dashFrom'), d20); setVal($('dashTo'), d20); await sleep(500);
  const catBtn = cat => qa('#dashCatSeg button').find(b => b.getAttribute('data-cat') === cat);

  click(catBtn('all')); await sleep(400);
  check('All-categories dashboard shows the full day\'s wages (2,000)',
        digits($('plLabour').textContent) === '2000', $('plLabour').textContent);

  click(catBtn('broiler')); await sleep(400);
  check('Broiler-only dashboard shows the whole day\'s wages (2,000) — same crew, broiler absorbs it',
        digits($('plLabour').textContent) === '2000', $('plLabour').textContent);

  click(catBtn('parents')); await sleep(400);
  check('Parents-only dashboard shows zero — it does not also carry the day\'s wages',
        digits($('plLabour').textContent) === '0', $('plLabour').textContent);

  click(catBtn('all')); await sleep(300);   // leave the dashboard as found

  console.log('\n[15] a dedicated Return birds button, no hunting for a toggle');
  nav('entry'); await sleep(400);
  setVal($('branchSelect'), 'B01'); await sleep(300);
  check('a dedicated "Return birds" button sits next to Add purchase', !!$('btnAddReturn'));
  const beforeRows = qa('#purchaseRows [data-pret]').length;
  click($('btnAddReturn')); await sleep(500);
  check('clicking it drops straight into return mode — no separate toggle needed',
        qa('#purchaseRows [data-p="returnOf"]').length > 0);
  const newRows = qa('#purchaseRows [data-pret]');
  check('the new row is already flagged as a return',
        newRows.length > beforeRows && /Switch to purchase/.test(newRows[newRows.length - 1].textContent),
        newRows.length ? newRows[newRows.length - 1].textContent : 'no rows');
  const cleanupBtns = qa('#purchaseRows [data-prm]');
  if (cleanupBtns.length) click(cleanupBtns[cleanupBtns.length - 1]);
  await sleep(200);   // clean up the draft row

  console.log('\n[16] the pending badge and the Records list agree, or say why not');
  const d50 = new Date(Date.now() - 50 * 86400000).toISOString().slice(0, 10);
  const pendingBase = {
    branch: 'B01', category: 'broiler', businessDate: d50, submit: true,
    openBirds: 80, openWtG: 200000, openMeatG: 5000, openRate: 120,
    rateSkin: 200, rateSkinless: 230, rateLiver: 130, rateLive: 150,
    liveSoldCount: 0, liveSoldWtG: 0, cutCharges: 0,
    mortCount: 0, mortWtG: 0, damageG: 0,
    dressedCount: 10, dressedWtG: 20000, actualMeatG: 14000,
    skinSoldG: 14000, skinlessSoldG: 0, liverSoldG: 0,
    closeBirds: 70, closeWtG: 180000, closeMeatG: 0, purchases: []
  };
  const pendingMade = await (await w.fetch('/api/entries', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pendingBase)
  })).json();
  check('the far-dated pending fixture was created (not blocked by validation)',
        !!pendingMade.id, JSON.stringify(pendingMade));

  setVal($('loginUser'), 'admin'); setVal($('loginPass'), 'admin123');
  $('loginForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(1200);

  nav('records'); await sleep(500);
  const stillHidden = !qa('#recBody tr').some(tr => tr.textContent.includes(d50));
  check('the 50-day-old pending entry is outside the default 30-day filter',
        stillHidden);
  check('a hint explains there are more pending entries than shown',
        !$('recHiddenHint').classList.contains('hidden'), $('recHiddenHint').textContent);
  check('a "Show all" action is offered to admin',
        !$('recShowAllPending').classList.contains('hidden'));
  click($('recShowAllPending')); await sleep(800);
  check('clicking it reveals the entry the badge already knew about',
        qa('#recBody tr').some(tr => tr.textContent.includes(d50)));

  console.log('\n[17] parents 22% waste math matches to the gram (support report regression)');
  // Exact figures from the user's screenshot: 14kg 7g dressed, 22% waste
  // setting, 10kg 925g actually obtained — expected to land on EXACTLY
  // zero variance, not a tiny phantom shortfall from an unrounded
  // expectedMeatG disagreeing with the server's truncated one.
  nav('admin'); await sleep(500);
  const originalWaste = $('setWasteParents').value;
  setVal($('setWasteParents'), '22');
  click($('btnSaveSettings')); await sleep(1000);

  // B02 — untouched by every other section in this file, so there is no
  // risk of loading an existing today-dated entry (locked/approved) here
  // instead of a fresh blank form.
  nav('entry'); await sleep(400);
  setVal($('branchSelect'), 'B02'); await sleep(300);
  click(qa('#entryCatSeg button').find(b => b.getAttribute('data-cat') === 'parents')); await sleep(400);
  setVal($('f_dressedWt_kg'), '14'); setVal($('f_dressedWt_g'), '7');
  setVal($('f_actualMeat_kg'), '10'); setVal($('f_actualMeat_g'), '925');
  await sleep(400);

  check('waste % shown matches the 22% setting', $('o_wastePct').textContent.trim() === '22',
        $('o_wastePct').textContent);
  check('expected meat is 10.925 kg (14.007 kg × 78%, truncated like the server)',
        $('o_expMeat').textContent.trim() === '10.925 kg', $('o_expMeat').textContent);
  check('waste meat is 3.082 kg (14.007 − 10.925)',
        $('o_wasteMeat').textContent.trim() === '3.082 kg', $('o_wasteMeat').textContent);
  check('bonus/short meat reads a clean 0.000 kg — no "-0.000" phantom variance',
        $('o_bonusMeat').textContent.trim() === '0.000 kg', $('o_bonusMeat').textContent);

  // restore the setting so it doesn't leak into any section that runs after this one
  nav('admin'); await sleep(400);
  setVal($('setWasteParents'), originalWaste || '21');
  click($('btnSaveSettings')); await sleep(800);

  console.log('\n[18] admin billing adjustment: add/reduce a hotel bill, reflected in ledger, Day Close and Dashboard');
  const d65 = new Date(Date.now() - 65 * 86400000).toISOString().slice(0, 10);   // untouched by every other section

  nav('customers'); await sleep(400);
  setVal($('branchSelect'), 'B01'); await sleep(300);
  click($('btnAddCustomer')); await sleep(250);
  setVal($('cuName'), 'Adjust Test Inn');
  click($('cuSave')); await sleep(1200);
  const custRow = () => qa('#custBody tr').find(tr => tr.textContent.includes('Adjust Test Inn'));
  check('the test customer was created', !!custRow());
  const adjBtn = () => custRow() && custRow().querySelector('button[data-cact="adjust"]');
  check('an admin-only Adjust button is offered on its row', !!adjBtn());

  click(adjBtn()); await sleep(300);
  check('the Adjust modal opens with today pre-filled and a cash/credit choice',
        !!$('adjAmt') && !!$('adjSettled') && !!$('adjDate').value);
  setVal($('adjDate'), d65);
  setVal($('adjAmt'), '450');
  setVal($('adjSettled'), '1');   // cash
  setVal($('adjNote'), 'UI test correction');
  click($('adjSave')); await sleep(1200);

  check('the customer\'s Billed total now includes the +450 adjustment',
        custRow() && custRow().textContent.includes('450'),
        custRow() && custRow().textContent);

  click(custRow().querySelector('button[data-cact="ledger"]')); await sleep(500);
  check('the ledger shows an Adjustment line', /Adjustment/.test($('genModal').textContent));
  check('...with the note recorded', /UI test correction/.test($('genModal').textContent));
  check('...and the ledger itself offers its own Adjust button (admin only)', !!$('cuLedAdjust'));
  click(q('[data-close="1"]')); await sleep(300);

  nav('dashboard'); await sleep(400);
  setVal($('branchSelect'), 'B01'); await sleep(300);
  const dashScopeBranch = qa('[data-scope]').find(b => b.getAttribute('data-scope') === 'branch');
  if (dashScopeBranch) { click(dashScopeBranch); await sleep(200); }
  const catAllBtn = qa('#dashCatSeg button').find(b => b.getAttribute('data-cat') === 'all');
  if (catAllBtn) { click(catAllBtn); await sleep(200); }
  setVal($('dashFrom'), d65); setVal($('dashTo'), d65); await sleep(600);
  check('the dashboard P&L for that single day shows the +450 adjustment as revenue ' +
        '(no daily entry exists that day — the adjustment is the only thing in it)',
        digits($('plRevenue').textContent) === '450', $('plRevenue').textContent);

  nav('dayclose'); await sleep(400);
  setVal($('dcDate'), d65); await sleep(700);
  const b01Card = qa('#dcCards .card').find(c => c.getAttribute('data-dcbranch') === 'B01');
  check('Day Close for that date shows the expected handover raised by the cash adjustment',
        !!b01Card && digits(b01Card.getAttribute('data-dcexpected')) === '450',
        b01Card && b01Card.getAttribute('data-dcexpected'));
  check('...and the breakdown explains it as a billing adjustment',
        !!b01Card && /billing adjustment/i.test(b01Card.textContent), b01Card && b01Card.textContent.slice(0, 400));

  console.log('\n[19] editing and deleting an already-recorded receipt');
  nav('customers'); await sleep(400);
  setVal($('branchSelect'), 'B01'); await sleep(300);
  click($('btnAddCustomer')); await sleep(250);
  setVal($('cuName'), 'Receipt Edit UI Hotel');
  click($('cuSave')); await sleep(1200);
  const recRow = () => qa('#custBody tr').find(tr => tr.textContent.includes('Receipt Edit UI Hotel'));
  check('the test customer was created', !!recRow());

  click(recRow().querySelector('button[data-cact="pay"]')); await sleep(300);
  setVal($('rcAmt'), '500');
  setVal($('rcMode'), 'cash');
  click($('rcSave')); await sleep(1200);
  check('the receipt shows up in Received',
        recRow() && recRow().textContent.includes('500'), recRow() && recRow().textContent);

  click(recRow().querySelector('button[data-cact="ledger"]')); await sleep(500);
  const editBtn = () => q('#genBody button[id^="rcEdit_"]');
  check('the receipt row offers an edit icon (admin only)', !!editBtn());
  click(editBtn()); await sleep(300);
  check('the edit modal pre-fills the existing amount',
        !!$('rcEAmt') && $('rcEAmt').value === '500', $('rcEAmt') && $('rcEAmt').value);
  setVal($('rcEAmt'), '650');
  setVal($('rcEMode'), 'upi');
  click($('rcESave')); await sleep(1200);
  check('the ledger re-opens showing the corrected amount', /650/.test($('genModal').textContent));

  const delBtn = () => q('#genBody button[id^="rcDel_"]');
  check('a delete icon is offered too', !!delBtn());
  click(delBtn()); await sleep(1200);
  check('deleting it removes the receipt row from the ledger', !/650/.test($('genModal').textContent));
  click(q('[data-close="1"]')); await sleep(300);

  const recRow2 = () => qa('#custBody tr').find(tr => tr.textContent.includes('Receipt Edit UI Hotel'));
  check('the customer\'s Received total drops back to 0 after the delete',
        !!recRow2() && digits(recRow2().children[8].textContent) === '0',
        recRow2() && recRow2().textContent);

  console.log('\n' + '='.repeat(60));
  console.log('UI v8 RESULT: ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(60));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
