#!/usr/bin/env node
// WA quarterly excise tax prep — runs locally, emails Kalia the full breakdown
// matching the DOR return: total revenue, B&O (gross/deduction/taxable), state
// sales tax, and local sales tax broken down BOTH by city and by county.
//
// Reads .env (same dir): SHOPIFY_STORE_DOMAIN, SHOPIFY_ACCESS_TOKEN,
//   GMAIL_APP_PASSWORD, NOTIFICATION_EMAIL
// Scheduled by launchd (com.bodycon.watax.plist): Jan 1 / Apr 1 / Jul 1 / Oct 1.

const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const GMAIL_PW = process.env.GMAIL_APP_PASSWORD;
const TO = process.env.NOTIFICATION_EMAIL || 'kaliacrtr@gmail.com';
const FROM_USER = 'kalia@bodyconthebrand.com';
const API = `https://${STORE}/admin/api/2024-01`;
const STATE_RATE = 0.065;
const BO_RETAILING_RATE = 0.004710;

// WA city -> county (common cities; unknown falls back to "(verify county)")
const CITY_COUNTY = {
  seattle:'King',bellevue:'King',kent:'King',renton:'King',redmond:'King',kirkland:'King',auburn:'King',
  'federal way':'King',sammamish:'King',shoreline:'King',burien:'King',kenmore:'King',issaquah:'King',
  seatac:'King',tukwila:'King',woodinville:'King','mercer island':'King','des moines':'King','maple valley':'King',
  covington:'King',
  tacoma:'Pierce',lakewood:'Pierce',puyallup:'Pierce','university place':'Pierce','gig harbor':'Pierce',
  'bonney lake':'Pierce',sumner:'Pierce',fife:'Pierce',spanaway:'Pierce',parkland:'Pierce',
  everett:'Snohomish',marysville:'Snohomish',lynnwood:'Snohomish',edmonds:'Snohomish',bothell:'Snohomish',
  mukilteo:'Snohomish','mill creek':'Snohomish',monroe:'Snohomish',arlington:'Snohomish',snohomish:'Snohomish',
  spokane:'Spokane','spokane valley':'Spokane',cheney:'Spokane',
  vancouver:'Clark',camas:'Clark',washougal:'Clark','battle ground':'Clark',
  olympia:'Thurston',lacey:'Thurston',tumwater:'Thurston',
  'mount vernon':'Skagit',anacortes:'Skagit',burlington:'Skagit','sedro-woolley':'Skagit',
  bellingham:'Whatcom',ferndale:'Whatcom',lynden:'Whatcom',
  bremerton:'Kitsap',silverdale:'Kitsap',poulsbo:'Kitsap','port orchard':'Kitsap','bainbridge island':'Kitsap',
  kennewick:'Benton',richland:'Benton','west richland':'Benton',pasco:'Franklin',yakima:'Yakima',
  pullman:'Whitman',longview:'Cowlitz',kelso:'Cowlitz',wenatchee:'Chelan',aberdeen:'Grays Harbor',
  'oak harbor':'Island','walla walla':'Walla Walla',
};
const countyOf = (city) => CITY_COUNTY[(city || '').toLowerCase().trim()] || '(verify county)';

function priorQuarter(now = new Date()) {
  const q = Math.floor(now.getMonth() / 3);
  const startCurr = new Date(now.getFullYear(), q * 3, 1);
  const endPrev = new Date(startCurr - 1);
  const pq = Math.floor(endPrev.getMonth() / 3);
  const year = endPrev.getFullYear();
  return {
    label: `${year} Q${pq + 1}`,
    start: new Date(year, pq * 3, 1),
    end: new Date(year, pq * 3 + 3, 1),
    due: new Date(year, pq * 3 + 4, 0),
  };
}

async function pullOrders(startISO, endISO) {
  let url = `${API}/orders.json?status=any&limit=250&created_at_min=${startISO}&created_at_max=${endISO}` +
    `&fields=id,name,cancelled_at,test,shipping_address,total_price,total_tax,tax_lines`;
  let all = [];
  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    all = all.concat(d.orders || []);
    const m = (res.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
    await new Promise((r) => setTimeout(r, 300));
  }
  return all;
}

const money = (n) => '$' + n.toFixed(2);
const grossOf = (o) => parseFloat(o.total_price || 0) - parseFloat(o.total_tax || 0);
function localTaxOf(o) { let lt = 0; (o.tax_lines || []).forEach((t) => { if (Math.abs(parseFloat(t.rate || 0) - STATE_RATE) > 0.0001) lt += parseFloat(t.price || 0); }); return lt; }
function rows(map) {
  return Object.entries(map).sort().map(([k, b]) =>
    `<tr><td style="padding:6px 10px;">${k}</td><td style="padding:6px 10px;text-align:center;">${b.n}</td><td style="padding:6px 10px;text-align:right;">${money(b.taxable)}</td><td style="padding:6px 10px;text-align:right;">${money(b.local)}</td></tr>`
  ).join('');
}

(async () => {
  const q = priorQuarter();
  const startISO = q.start.toISOString().slice(0, 19) + '-08:00';
  const endISO = q.end.toISOString().slice(0, 19) + '-08:00';
  const all = await pullOrders(startISO, endISO);
  const live = all.filter((o) => !o.cancelled_at && !o.test);

  const totalRevenue = live.reduce((s, o) => s + grossOf(o), 0);      // all sales, ex sales tax
  const totalOrders = live.length;
  const wa = live.filter((o) => o.shipping_address && o.shipping_address.province_code === 'WA');
  const waTaxable = wa.reduce((s, o) => s + grossOf(o), 0);
  const interstate = totalRevenue - waTaxable;
  const stateTax = waTaxable * STATE_RATE;
  const boTax = waTaxable * BO_RETAILING_RATE;

  const byCity = {}, byCounty = {};
  let localTax = 0;
  for (const o of wa) {
    const taxable = grossOf(o), lt = localTaxOf(o);
    localTax += lt;
    const cityKey = `${o.shipping_address.city || '?'}, ${(o.shipping_address.zip || '?').slice(0, 5)}`;
    const cKey = countyOf(o.shipping_address.city);
    (byCity[cityKey] || (byCity[cityKey] = { taxable: 0, local: 0, n: 0 }));
    (byCounty[cKey] || (byCounty[cKey] = { taxable: 0, local: 0, n: 0 }));
    byCity[cityKey].taxable += taxable; byCity[cityKey].local += lt; byCity[cityKey].n++;
    byCounty[cKey].taxable += taxable; byCounty[cKey].local += lt; byCounty[cKey].n++;
  }
  const totalRow = (n, tax, loc) => `<tr style="font-weight:bold;border-top:2px solid #471506;"><td style="padding:6px 10px;">TOTAL</td><td style="padding:6px 10px;text-align:center;">${n}</td><td style="padding:6px 10px;text-align:right;">${money(tax)}</td><td style="padding:6px 10px;text-align:right;">${money(loc)}</td></tr>`;
  const th = `<tr style="background:#F4EADD;"><th style="padding:6px 10px;text-align:left;">Location</th><th style="padding:6px 10px;">Orders</th><th style="padding:6px 10px;">Taxable</th><th style="padding:6px 10px;">Local tax</th></tr>`;
  const dueStr = q.due.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:660px;color:#222;">
    <h2 style="font-family:Georgia,serif;color:#471506;margin-bottom:2px;">WA Excise Tax — ${q.label}</h2>
    <p style="font-size:15px;margin-top:4px;"><strong>File by ${dueStr}.</strong> Numbers pulled live from Shopify. Verify before filing — organized data, not tax advice.</p>

    <h3 style="font-family:Georgia,serif;color:#471506;margin-bottom:4px;">Revenue this quarter</h3>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:4px 10px;">Total orders (all, ex cancelled/test)</td><td style="padding:4px 10px;text-align:right;">${totalOrders}</td></tr>
      <tr><td style="padding:4px 10px;">Total revenue (all states, ex sales tax)</td><td style="padding:4px 10px;text-align:right;"><strong>${money(totalRevenue)}</strong></td></tr>
      <tr><td style="padding:4px 10px;">WA orders</td><td style="padding:4px 10px;text-align:right;">${wa.length}</td></tr>
    </table>

    <h3 style="font-family:Georgia,serif;color:#471506;margin-bottom:4px;">Business &amp; Occupation — Retailing</h3>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:4px 10px;">Gross Amount (= total revenue)</td><td style="padding:4px 10px;text-align:right;"><strong>${money(totalRevenue)}</strong></td></tr>
      <tr><td style="padding:4px 10px;">Deduction — Interstate &amp; Foreign (non-WA)</td><td style="padding:4px 10px;text-align:right;">${money(interstate)}</td></tr>
      <tr><td style="padding:4px 10px;">Taxable Amount (WA)</td><td style="padding:4px 10px;text-align:right;"><strong>${money(waTaxable)}</strong></td></tr>
      <tr><td style="padding:4px 10px;">B&amp;O tax due (× 0.004710)</td><td style="padding:4px 10px;text-align:right;">${money(boTax)} <em>(small-biz credit usually zeroes)</em></td></tr>
    </table>

    <h3 style="font-family:Georgia,serif;color:#471506;margin-bottom:4px;">State Retail Sales Tax</h3>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:4px 10px;">Taxable</td><td style="padding:4px 10px;text-align:right;">${money(waTaxable)}</td></tr>
      <tr><td style="padding:4px 10px;">State tax due (× 6.5%)</td><td style="padding:4px 10px;text-align:right;"><strong>${money(stateTax)}</strong></td></tr>
    </table>

    <h3 style="font-family:Georgia,serif;color:#471506;margin-bottom:4px;">Local Sales Tax — by CITY (file these via Find Location by Address)</h3>
    <table style="border-collapse:collapse;font-size:14px;border:1px solid #eee;">${th}${rows(byCity)}${totalRow(wa.length, waTaxable, localTax)}</table>

    <h3 style="font-family:Georgia,serif;color:#471506;margin-bottom:4px;">Local Sales Tax — by COUNTY (rollup)</h3>
    <table style="border-collapse:collapse;font-size:14px;border:1px solid #eee;">${th}${rows(byCounty)}${totalRow(wa.length, waTaxable, localTax)}</table>
    <p style="font-size:12px;color:#a00;">Heads-up: file by CITY, not county — cities in the same county have different rates, so the county rollup can under-report what you collected. County table is reference only.</p>

    <p style="font-size:14px;margin-top:14px;background:#F4EADD;padding:10px;border-radius:6px;">
      <strong>Balance check:</strong> State ${money(stateTax)} + Local ${money(localTax)} = <strong>${money(stateTax + localTax)}</strong> sales tax collected.<br>
      Local taxable must total ${money(waTaxable)} for the form's balance check to clear.
    </p>
  </div>`;

  if (!GMAIL_PW) { console.error('No GMAIL_APP_PASSWORD in .env — computed', q.label, 'state', money(stateTax), 'local', money(localTax)); process.exit(1); }
  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: FROM_USER, pass: GMAIL_PW } });
  await transport.sendMail({
    from: `"WA Tax Prep" <${FROM_USER}>`,
    to: TO,
    subject: `File WA taxes: ${q.label} due ${dueStr} — state ${money(stateTax)}, local ${money(localTax)}`,
    html,
  });
  console.log(`Sent ${q.label} to ${TO}. Revenue ${money(totalRevenue)}, WA taxable ${money(waTaxable)}, state ${money(stateTax)}, local ${money(localTax)}.`);
})().catch((e) => { console.error('wa-quarterly-tax error:', e.message); process.exit(1); });
