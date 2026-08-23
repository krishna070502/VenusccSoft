/*
 * Browser-level check of the hotel & hostel feature.
 *
 * Boots the real index.html + app.js inside jsdom, points fetch at a live
 * Flask server, and drives the actual UI: signs in, adds a hotel through the
 * modal, adds a sale row in the daily entry, and reads the figures back off
 * the rendered page. This catches wiring mistakes the API tests cannot.
 */
const { JSDOM, VirtualConsole } = require(process.env.JSDOM || '/tmp/node_modules/jsdom');
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
  let html = fs.readFileSync(ROOT + '/app/templates/index.html', 'utf8');
  const js = fs.readFileSync(ROOT + '/app/static/js/app.js', 'utf8');
  // strip Jinja and the CDN tags jsdom cannot run
  html = html.replace(/\{\{[^}]*\}\}/g, '')
             .replace(/<script[^>]*src=[^>]*><\/script>/g, '')
             .replace(/<link[^>]*>/g, '');

  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Could not parse CSS/.test(e.message)) console.log('  [jsdom] ' + e.message); });

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: BASE + '/', virtualConsole: vc });
  const w = dom.window;

  // a cookie jar so the Flask session survives across calls
  let cookie = '';
  w.fetch = async (path, opts = {}) => {
    const headers = Object.assign({}, opts.headers || {});
    if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body, redirect: 'manual' });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
    const text = await res.text();
    return { ok: res.ok, status: res.status,
             json: async () => JSON.parse(text), text: async () => text };
  };
  w.Chart = function () { return { destroy() {}, update() {} }; };
  w.Chart.register = function () {};
  let printCalls = 0;
  w.scrollTo = () => {}; w.print = () => { printCalls++; };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.confirm = () => true;
  w.alert = () => {};
  w.URL.createObjectURL = () => 'blob:x';
  w.URL.revokeObjectURL = () => {};

  w.eval(js);
  await sleep(400);

  const $ = id => w.document.getElementById(id);
  const click = el => el.dispatchEvent(new w.Event('click', { bubbles: true }));
  const setVal = (el, v) => {
    el.value = v;
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
  };

  console.log('\n[UI] sign in');
  setVal($('loginUser'), 'admin'); setVal($('loginPass'), 'admin123');
  $('loginForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(1200);
  check('signed in, app shell visible', !$('appShell').classList.contains('hidden'));

  console.log('\n[UI] hotels & hostels view');
  const navCust = [...w.document.querySelectorAll('#mainNav .tab-btn')]
    .find(b => b.getAttribute('data-view') === 'customers');
  check('a Hotels & Hostels tab exists', !!navCust);
  click(navCust); await sleep(300);
  check('the customers view opens', !$('view-customers').classList.contains('hidden'));

  console.log('\n[UI] add a hotel through the modal');
  click($('btnAddCustomer')); await sleep(200);
  check('the add form opens', !$('genModal').classList.contains('hidden'));
  check('it offers hotel, hostel and function', $('cuKind').options.length === 3);
  check('concession mode is the default', $('cuMode').value === 'less');
  check('fixed-rate boxes start disabled', $('cuRateSkin').disabled === true);
  setVal($('cuMode'), 'fixed'); await sleep(50);
  check('switching to fixed swaps which boxes are live',
        $('cuRateSkin').disabled === false && $('cuLessSkin').disabled === true);
  setVal($('cuMode'), 'less'); await sleep(50);

  setVal($('cuName'), 'UI Test Hotel');
  setVal($('cuLessSkin'), '50');
  setVal($('cuLessSkinless'), '60');
  click($('cuSave'));
  await sleep(1200);
  check('the modal closes after saving', $('genModal').classList.contains('hidden'));
  const row = [...w.document.querySelectorAll('#custBody tr')]
    .find(tr => tr.textContent.includes('UI Test Hotel'));
  check('the hotel appears in the table', !!row);
  check('the table shows the concession, not a raw price',
        row && row.textContent.includes('off market'), row && row.textContent.slice(0, 200));
  const custId = row && row.querySelector('button[data-cact]').getAttribute('data-id');

  console.log('\n[UI] sell to it from the daily entry');
  const navEntry = [...w.document.querySelectorAll('#mainNav .tab-btn')]
    .find(b => b.getAttribute('data-view') === 'entry');
  click(navEntry); await sleep(300);

  setVal($('f_rateSkin'), '250');
  setVal($('f_rateSkinless'), '300');
  setVal($('f_rateLive'), '150');
  await sleep(100);

  click($('btnAddHotelSale')); await sleep(200);
  const sel = w.document.querySelector('#hotelRows [data-h="customerId"]');
  check('a sale row is added', !!sel);
  setVal(sel, custId); await sleep(200);
  setVal(w.document.querySelector('#hotelRows [data-h="product"]'), 'skin');
  await sleep(200);
  setVal(w.document.querySelector('#hotelRows [data-h="kg"]'), '20');
  await sleep(300);

  const summary = w.document.querySelector('#hotelRows [data-hsum]').textContent;
  check('the row shows market less the concession',
        /250\.00/.test(summary) && /200\.00/.test(summary), summary);
  check('the row shows the amount 20 kg x 200 = 4,000',
        /4,000\.00/.test(summary), summary);
  check('it is flagged as on account by default',
        /on account/.test(summary), summary);

  check('section total shows the sale value',
        $('o_hotelAmt').textContent.replace(/[^\d]/g, '') === '400000',
        $('o_hotelAmt').textContent);
  check('section total shows the concession given (50 x 20)',
        $('o_hotelConc').textContent.replace(/[^\d]/g, '') === '100000',
        $('o_hotelConc').textContent);
  check('the whole amount sits under "on account"',
        $('o_hotelCredit').textContent.replace(/[^\d]/g, '') === '400000',
        $('o_hotelCredit').textContent);
  check('the day summary separates counter from hotel money',
        $('o_hotelAmt2').textContent.replace(/[^\d]/g, '') === '400000');

  console.log('\n[UI] the meat balance allows for it');
  setVal($('f_dressedCount'), '40');
  setVal($('f_dressedWt_kg'), '100');
  // Closing meat is the direct entry now (Section G) — actual meat obtained
  // is read-only, reconciled from it. 49 kg physically left over + the
  // 20 kg the hotel already took = 69 kg obtained, same figures as before,
  // just flowing the other way.
  setVal($('f_closeMeat_kg'), '49');
  await sleep(300);
  const actualMeatKg = w.parseFloat($('f_actualMeat_kg').value || '0');
  check('actual meat obtained reconciles to 69 kg — the 49 kg left over plus the 20 kg the hotel took',
        actualMeatKg === 69, 'got ' + actualMeatKg + ' kg');

  console.log('\n[UI] marking it paid moves the money');
  const paidBox = w.document.querySelector('#hotelRows [data-h="settled"]');
  paidBox.checked = true;
  paidBox.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(300);
  check('on-account total drops to zero once paid',
        $('o_hotelCredit').textContent.replace(/[^\d]/g, '') === '000' ||
        $('o_hotelCredit').textContent.replace(/[^\d.]/g, '') === '0.00',
        $('o_hotelCredit').textContent);

  console.log('\n[UI] a manual rate overrides the deal');
  setVal(w.document.querySelector('#hotelRows [data-h="rateOverride"]'), '175');
  await sleep(300);
  check('the amount follows the manual rate (20 x 175)',
        $('o_hotelAmt').textContent.replace(/[^\d]/g, '') === '350000',
        $('o_hotelAmt').textContent);
  check('concession widens to 75/kg',
        $('o_hotelConc').textContent.replace(/[^\d]/g, '') === '150000',
        $('o_hotelConc').textContent);

  console.log('\n[UI] removing the row');
  click(w.document.querySelector('#hotelRows [data-hrm]'));
  await sleep(300);
  check('the row is gone', !w.document.querySelector('#hotelRows [data-h="customerId"]'));
  check('the totals reset', $('o_hotelAmt').textContent.replace(/[^\d.]/g, '') === '0.00');

  console.log('\n[UI] validation refuses an incomplete row');
  click($('btnAddHotelSale')); await sleep(200);
  setVal(w.document.querySelector('#hotelRows [data-h="kg"]'), '5');
  await sleep(200);
  setVal($('f_openBirds'), '80'); setVal($('f_openWt_kg'), '200');
  setVal($('f_closeBirds'), '0'); setVal($('f_rateLiver'), '130');
  await sleep(200);
  click($('actSubmit'));          // press the real "send for approval" button
  await sleep(600);
  check('submission is blocked', !$('validationBox').classList.contains('hidden'));
  check('and it says which hotel line is wrong',
        /choose the hotel/i.test($('validationList').textContent),
        $('validationList').textContent);

  console.log('\n[UI] a complete row submits and reaches the server');
  setVal(w.document.querySelector('#hotelRows [data-h="customerId"]'), custId);
  await sleep(250);
  setVal(w.document.querySelector('#hotelRows [data-h="kg"]'), '8');
  await sleep(250);
  click($('actSubmit'));
  await sleep(1400);
  check('the entry saves', /pending|Pending/.test($('f_statusLabel').textContent),
        $('f_statusLabel').textContent);
  const saved = await (await w.fetch('/api/entries')).json();
  const withHotel = saved.find(e => (e.hotelSales || []).length);
  check('the server stored the hotel line', !!withHotel);
  // the row defaults to skinless, so the SKINLESS deal applies: 300 − 60 = 240
  check('the skinless concession is used, not the skin one',
        withHotel && withHotel.hotelSales[0].rate === 240,
        withHotel && JSON.stringify(withHotel.hotelSales[0]));
  check('with the market rate of the day recorded beside it',
        withHotel && withHotel.hotelSales[0].marketRate === 300);
  check("the server's own total agrees: 8 kg x 240",
        withHotel && withHotel.calc.hotelAmt === 1920,
        withHotel && String(withHotel.calc.hotelAmt));
  check('and the concession it gave away: 8 kg x 60',
        withHotel && withHotel.calc.hotelConcession === 480,
        withHotel && String(withHotel.calc.hotelConcession));

  console.log('\n[UI] ledger opens');
  click(navCust); await sleep(300);
  const ledBtn = [...w.document.querySelectorAll('#custBody button[data-cact="ledger"]')]
    .find(b => b.getAttribute('data-id') === custId);
  click(ledBtn); await sleep(900);
  check('the ledger modal opens', !$('genModal').classList.contains('hidden'));
  check('it is titled for this customer', /UI Test Hotel/.test($('genTitle').textContent));
  check('it shows a balance-due figure', /Balance due/.test($('genBody').textContent));
  check('it offers a receipt button', !!$('cuLedPay'));
  check('it offers a Print button', !!$('cuLedPrint'));
  check('the CSV button is now labelled Excel', !!$('cuLedCsv') && /Excel/.test($('cuLedCsv').textContent));
  click($('cuLedPrint')); await sleep(200);
  check('printing the customer ledger fills #printArea and calls window.print()',
        $('printArea').innerHTML.length > 0 && printCalls > 0);
  click($('cuLedCsv')); await sleep(200);   // must not throw even without SheetJS loaded

  console.log('\n' + '='.repeat(60));
  console.log('UI RESULT: ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(60));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
