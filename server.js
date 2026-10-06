require('dotenv').config();
const express   = require('express');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Meta credentials (static) ─────────────────────────────────────────────────
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const ACCOUNT    = process.env.AD_ACCOUNT_ID || '';
const META_API   = 'v21.0';
const META_BASE  = `https://graph.facebook.com/${META_API}`;

// ── Shopify credentials ───────────────────────────────────────────────────────
// CLIENT_ID and CLIENT_SECRET are static (set at startup from .env)
// ACCESS_TOKEN is dynamic — obtained via OAuth, saved back to .env
const SHOPIFY_DOMAIN        = process.env.SHOPIFY_STORE_DOMAIN || '';
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API           = '2025-01';
const SHOPIFY_SCOPES        = 'read_orders,read_products,read_inventory,read_content,write_content';
const SHOPIFY_REDIRECT      = `http://localhost:${PORT}/shopify/callback`;

// Live token — read from process.env so it updates after OAuth without restart
const shopifyToken  = () => process.env.SHOPIFY_ACCESS_TOKEN || '';
const shopifyReady  = () => !!(shopifyToken());
const shopifyCredsOk = () => !!(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET);

// ── Klaviyo credentials ───────────────────────────────────────────────────────
const KLAVIYO_KEY      = process.env.KLAVIYO_PRIVATE_KEY || '';
const KLAVIYO_BASE     = 'https://a.klaviyo.com/api';
const KLAVIYO_REVISION = '2024-10-15';
const klaviyoReady     = () => !!KLAVIYO_KEY;

// ── Anthropic credentials ─────────────────────────────────────────────────────
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const anthropicReady  = () => !!ANTHROPIC_KEY;
let   _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient && ANTHROPIC_KEY) _anthropicClient = new Anthropic({ apiKey: ANTHROPIC_KEY });
  return _anthropicClient;
}

if (!META_TOKEN) {
  console.error('\n  ERROR: META_ACCESS_TOKEN not found. Run: bash setup.sh\n');
  process.exit(1);
}

// ── Meta token expiry warning ─────────────────────────────────────────────────
(function checkTokenExpiry() {
  const expiry = process.env.META_TOKEN_EXPIRY;
  if (!expiry) return;
  const daysLeft = Math.ceil((new Date(expiry) - new Date()) / (1000 * 60 * 60 * 24));
  if (daysLeft <= 0) {
    console.warn('\n  ⚠  Meta token has expired. Run: bash update-token.sh\n');
  } else if (daysLeft <= 10) {
    console.warn(`\n  ⚠  Meta token expires in ${daysLeft} days. Run: bash update-token.sh soon.\n`);
  } else {
    console.log(`  ✓  Meta token valid — expires in ${daysLeft} days (${expiry}).`);
  }
})();

// ── .env updater ──────────────────────────────────────────────────────────────
function updateEnvFile(key, value) {
  const envPath = path.join(__dirname, '.env');
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const re = new RegExp(`^${key}=.*$`, 'm');
    content = re.test(content)
      ? content.replace(re, `${key}=${value}`)
      : content.trimEnd() + `\n${key}=${value}\n`;
    fs.writeFileSync(envPath, content);
  } catch (err) {
    console.error(`[ENV] Could not update ${key}:`, err.message);
  }
}

// ── Expenses persistence ──────────────────────────────────────────────────────
const EXPENSES_FILE = path.join(__dirname, 'expenses.json');
const EXPENSE_KEYS  = ['shopify_subscription','shopify_apps','shopify_shipping','klaviyo','loop_returns','product_dev','ugc_creators','apps_tools','inventory_cogs','other'];
// Keys that remain as manual inputs (variable each month)
const MANUAL_EXPENSE_KEYS = ['product_dev','ugc_creators','inventory_cogs','other'];

function loadExpenses() {
  try {
    if (fs.existsSync(EXPENSES_FILE)) return JSON.parse(fs.readFileSync(EXPENSES_FILE, 'utf8'));
  } catch (e) { console.error('[P&L] loadExpenses:', e.message); }
  return Object.fromEntries(EXPENSE_KEYS.map(k => [k, 0]));
}

function saveExpenses(data) {
  try { fs.writeFileSync(EXPENSES_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[P&L] saveExpenses:', e.message); }
}

// ── Subscriptions persistence ─────────────────────────────────────────────────
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');

const DEFAULT_SUBS = {
  items: [
    { id: 'shopify_plan',      name: 'Shopify Plan',       category: 'shopify_subscription', amount: 105.00,  active: true },
    { id: 'shopify_apps',      name: 'Shopify Apps',        category: 'shopify_apps',         amount: 10.00,   active: true },
    { id: 'klaviyo',           name: 'Klaviyo',             category: 'klaviyo',              amount: 121.61,  active: true },
    { id: 'loop_returns',      name: 'Loop Returns',        category: 'loop_returns',         amount: 171.36,  active: true },
    { id: 'canva',             name: 'Canva Pro',           category: 'apps_tools',           amount: 15.00,   active: true },
    { id: 'google_workspace',  name: 'Google Workspace',    category: 'apps_tools',           amount: 58.37,   active: true },
    { id: 'amazon_seller',     name: 'Amazon Seller',       category: 'apps_tools',           amount: 25.45,   active: true },
    { id: 'icloud',            name: 'iCloud Storage',      category: 'apps_tools',           amount: 9.99,    active: true },
  ],
  shipping: { avgLabelCost: 6.00, autoEstimate: true },
};

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBS_FILE)) return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch (e) { console.error('[Subs] load:', e.message); }
  return DEFAULT_SUBS;
}

function saveSubscriptions(data) {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[Subs] save:', e.message); }
}

// Returns { shopify_subscription: X, shopify_apps: X, klaviyo: X, ... } for all active subs
function getSubsTotals(subs) {
  const totals = {};
  (subs.items || []).filter(s => s.active).forEach(s => {
    totals[s.category] = (totals[s.category] || 0) + (parseFloat(s.amount) || 0);
  });
  return totals;
}

// Fetch count of fulfilled orders for the month (for shipping estimate)
async function fetchFulfilledOrderCount(since, until) {
  if (!shopifyReady()) return null;
  try {
    const orders = await shopifyGetAll(
      `/orders.json?fulfillment_status=shipped&created_at_min=${since}T00:00:00Z&created_at_max=${until}T23:59:59Z&limit=250&fields=id`
    );
    return orders.length;
  } catch (e) {
    console.error('[Shipping estimate] fetch failed:', e.message);
    return null;
  }
}

// ── Lead times persistence ────────────────────────────────────────────────────
const LEAD_TIMES_FILE = path.join(__dirname, 'lead-times.json');

function loadLeadTimes() {
  try {
    if (fs.existsSync(LEAD_TIMES_FILE)) return JSON.parse(fs.readFileSync(LEAD_TIMES_FILE, 'utf8'));
  } catch (e) { console.error('[Inventory] loadLeadTimes:', e.message); }
  return {};
}

function saveLeadTimes(data) {
  try { fs.writeFileSync(LEAD_TIMES_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[Inventory] saveLeadTimes:', e.message); }
}

// ── Token health check (every 24 hours) ──────────────────────────────────────
function scheduleTokenHealthCheck() {
  setInterval(async () => {
    if (!shopifyReady()) return;
    try {
      const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API}/shop.json`, {
        headers: { 'X-Shopify-Access-Token': shopifyToken() }
      });
      if (res.status === 401) {
        console.warn('\n  [Shopify] Token is no longer valid.');
        console.warn(`  Reconnect at: http://localhost:${PORT}/shopify/auth\n`);
        process.env.SHOPIFY_ACCESS_TOKEN = '';
        updateEnvFile('SHOPIFY_ACCESS_TOKEN', '');
      } else {
        console.log('[Shopify] 24h token check: OK');
      }
    } catch (err) {
      console.warn('[Shopify] Token health check failed:', err.message);
    }
  }, 24 * 60 * 60 * 1000);
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function presetToRange(preset) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const ago = n => { const d = new Date(now); d.setDate(d.getDate()-n); return fmt(d); };
  switch (preset) {
    case 'last_7d':    return { since: ago(7),  until: fmt(now) };
    case 'last_14d':   return { since: ago(14), until: fmt(now) };
    case 'last_30d':   return { since: ago(30), until: fmt(now) };
    case 'this_month': return { since: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), until: fmt(now) };
    case 'last_month': {
      const s = new Date(now.getFullYear(), now.getMonth()-1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return { since: fmt(s), until: fmt(e) };
    }
    default: return { since: ago(30), until: fmt(now) };
  }
}

// ── Meta helpers ──────────────────────────────────────────────────────────────
async function metaGet(url) {
  const res  = await fetch(url);
  const json = await res.json();
  if (json.error) {
    const err = new Error(`Meta API: ${json.error.message} (code ${json.error.code})`);
    if (json.error.code === 190) err.tokenExpired = true;
    throw err;
  }
  return json;
}

async function metaGetAll(url) {
  let results = [], next = url;
  while (next) {
    const data = await metaGet(next);
    if (data.data) results = results.concat(data.data);
    next = data.paging?.next || null;
  }
  return results;
}

function extractAction(arr, type) {
  if (!arr) return null;
  const m = arr.find(a => a.action_type === type);
  return m ? parseFloat(m.value) : null;
}

// ── Shopify helpers ───────────────────────────────────────────────────────────
async function shopifyGetAll(endpoint) {
  const token = shopifyToken();
  if (!token) throw new Error('Shopify not connected');
  const items = [];
  let url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API}${endpoint}`;
  while (url) {
    const res  = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    const json = await res.json();
    if (json.errors) throw new Error(`Shopify API: ${JSON.stringify(json.errors)}`);
    const key = Object.keys(json).find(k => Array.isArray(json[k]));
    if (key) items.push(...json[key]);
    const link = res.headers.get('link') || '';
    const m    = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return items;
}

function calcRefundAmount(order) {
  if (!order.refunds?.length) return 0;
  return order.refunds.reduce((total, refund) => {
    const txAmt = (refund.transactions || [])
      .filter(tx => tx.kind === 'refund' && tx.status === 'success')
      .reduce((s, tx) => s + parseFloat(tx.amount || 0), 0);
    return total + txAmt;
  }, 0);
}

async function fetchShopifyMetrics(since, until) {
  const fields = 'id,total_price,financial_status,refunds,created_at';
  const orders = await shopifyGetAll(
    `/orders.json?status=any&created_at_min=${since}T00:00:00Z&created_at_max=${until}T23:59:59Z&limit=250&fields=${fields}`
  );
  const paid = orders.filter(o =>
    ['paid','partially_refunded','refunded'].includes(o.financial_status)
  );
  const grossRevenue       = paid.reduce((s,o) => s + parseFloat(o.total_price || 0), 0);
  const refundAmount       = paid.reduce((s,o) => s + calcRefundAmount(o), 0);
  const netRevenue         = grossRevenue - refundAmount;
  const orderCount         = paid.length;
  const returnedOrderCount = paid.filter(o => (o.refunds?.length||0) > 0).length;
  const returnRate         = orderCount > 0 ? returnedOrderCount / orderCount : 0;
  const aov                = orderCount > 0 ? netRevenue / orderCount : 0;
  return { orderCount, grossRevenue, refundAmount, netRevenue, aov, returnRate, returnedOrderCount };
}

// ── Klaviyo helpers ───────────────────────────────────────────────────────────
function klaviyoHeaders() {
  return {
    'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
    'revision': KLAVIYO_REVISION,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function klaviyoGet(path) {
  const res  = await fetch(`${KLAVIYO_BASE}${path}`, { headers: klaviyoHeaders() });
  const json = await res.json();
  if (json.errors) throw new Error(`Klaviyo: ${json.errors[0]?.detail || JSON.stringify(json.errors)}`);
  return json;
}

async function klaviyoPost(path, body) {
  const res  = await fetch(`${KLAVIYO_BASE}${path}`, {
    method: 'POST',
    headers: klaviyoHeaders(),
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`Klaviyo: ${json.errors[0]?.detail || JSON.stringify(json.errors)}`);
  return json;
}

// ── Klaviyo metric ID cache ───────────────────────────────────────────────────
let _klaviyoMetricId = null;
async function getKlaviyoMetricId() {
  if (_klaviyoMetricId) return _klaviyoMetricId;
  try {
    const data = await klaviyoGet('/metrics/');
    const m = (data.data || []).find(m => m.attributes?.name === 'Placed Order');
    _klaviyoMetricId = m?.id || null;
    if (!_klaviyoMetricId) console.warn('[Klaviyo] "Placed Order" metric not found — revenue attribution unavailable');
  } catch (e) {
    console.error('[Klaviyo] metrics fetch failed:', e.message);
  }
  return _klaviyoMetricId;
}

// ── Klaviyo trends data (for /api/trends) ─────────────────────────────────────
async function fetchKlaviyoTrendsData() {
  const conversionMetricId = await getKlaviyoMetricId();
  if (!conversionMetricId) return null;

  const [valuesRaw, campaignsRaw] = await Promise.allSettled([
    klaviyoPost('/campaign-values-reports/', {
      data: {
        type: 'campaign-values-report',
        attributes: {
          timeframe: { key: 'last_30_days' },
          conversion_metric_id: conversionMetricId,
          statistics: ['opens', 'open_rate', 'clicks', 'click_rate'],
        },
      },
    }),
    klaviyoGet("/campaigns/?sort=-updated_at&filter=equals(messages.channel,'email')"),
  ]);

  if (valuesRaw.status === 'rejected')    console.error('[Klaviyo trends] values report failed:', valuesRaw.reason?.message);
  if (campaignsRaw.status === 'rejected') console.error('[Klaviyo trends] campaigns failed:', campaignsRaw.reason?.message);

  const statsMap = {};
  if (valuesRaw.status === 'fulfilled' && valuesRaw.value) {
    (valuesRaw.value.data?.attributes?.results || []).forEach(r => {
      const cid = r.groupings?.campaign_id;
      if (cid) statsMap[cid] = r.statistics || {};
    });
  }

  const campaigns = [];
  if (campaignsRaw.status === 'fulfilled') {
    (campaignsRaw.value.data || [])
      .filter(c => !c.attributes.archived)
      .forEach(c => {
        const s = statsMap[c.id] || {};
        const sentAt = c.attributes.send_time || c.attributes.scheduled_at || null;
        campaigns.push({
          id:        c.id,
          sentAt,
          openRate:  s.open_rate  != null ? parseFloat((s.open_rate  * 100).toFixed(1)) : null,
          clickRate: s.click_rate != null ? parseFloat((s.click_rate * 100).toFixed(1)) : null,
        });
      });
  }

  return { campaigns };
}

async function fetchKlaviyoData() {
  const conversionMetricId = await getKlaviyoMetricId();

  // Campaign values report + campaigns + lists — run in parallel.
  const [valuesRaw, campaignsRaw, listsRaw] = await Promise.allSettled([
    conversionMetricId
      ? klaviyoPost('/campaign-values-reports/', {
          data: {
            type: 'campaign-values-report',
            attributes: {
              timeframe: { key: 'last_30_days' },
              conversion_metric_id: conversionMetricId,
              statistics: ['opens', 'open_rate', 'clicks', 'click_rate', 'unsubscribes'],
            },
          },
        })
      : Promise.resolve(null),
    klaviyoGet("/campaigns/?sort=-updated_at&filter=equals(messages.channel,'email')"),
    klaviyoGet('/lists/'),
  ]);

  if (valuesRaw.status    === 'rejected') console.error('[Klaviyo] campaign-values-reports failed:', valuesRaw.reason?.message);
  if (campaignsRaw.status === 'rejected') console.error('[Klaviyo] campaigns failed:', campaignsRaw.reason?.message);
  if (listsRaw.status     === 'rejected') console.error('[Klaviyo] lists failed:', listsRaw.reason?.message);

  // Build per-campaign stats map from values report
  const statsMap = {};
  if (valuesRaw.status === 'fulfilled' && valuesRaw.value) {
    const results = valuesRaw.value.data?.attributes?.results || [];
    results.forEach(r => {
      const cid = r.groupings?.campaign_id;
      if (cid) statsMap[cid] = r.statistics || {};
    });
  }

  // Aggregate: sum raw counts; average rates across campaigns (rates are decimals 0–1)
  let totalOpens = 0, totalClicks = 0, rateCount = 0, sumOpenRate = 0, sumClickRate = 0;
  Object.values(statsMap).forEach(s => {
    totalOpens  += s.opens  || 0;
    totalClicks += s.clicks || 0;
    if (s.open_rate  != null) { sumOpenRate  += s.open_rate;  rateCount++; }
    if (s.click_rate != null)   sumClickRate += s.click_rate;
  });
  // Multiply by 100 to convert decimal → percentage
  const openRate  = rateCount > 0 ? parseFloat((sumOpenRate  / rateCount * 100).toFixed(2)) : null;
  const clickRate = rateCount > 0 ? parseFloat((sumClickRate / rateCount * 100).toFixed(2)) : null;

  // Recent campaigns joined with their stats
  let campaigns = [];
  if (campaignsRaw.status === 'fulfilled') {
    campaigns = (campaignsRaw.value.data || [])
      .filter(c => !c.attributes.archived)
      .slice(0, 10)
      .map(c => {
        const s = statsMap[c.id] || {};
        return {
          id:          c.id,
          name:        c.attributes.name,
          status:      c.attributes.status,
          sentAt:      c.attributes.send_time || c.attributes.scheduled_at || null,
          opens:       s.opens  || 0,
          clicks:      s.clicks || 0,
          openRate:    s.open_rate  != null ? parseFloat((s.open_rate  * 100).toFixed(1)) : null,
          clickRate:   s.click_rate != null ? parseFloat((s.click_rate * 100).toFixed(1)) : null,
          unsubscribes: s.unsubscribes || 0,
          revenue:     s.revenue != null ? parseFloat(s.revenue.toFixed(2)) : null,
        };
      });
  }

  // Lists — Klaviyo v3 (revision 2024-10-15) does not expose profile_count in the
  // default response, additional-fields[list]=profile_count is rejected, and the
  // relationships/profiles endpoint only returns paginated IDs with no meta.total.
  // Display list names only; counts are not fetchable without paginating all profiles.
  let lists = [];
  if (listsRaw.status === 'fulfilled') {
    lists = (listsRaw.value.data || []).map(l => ({
      id:        l.id,
      name:      l.attributes.name,
      optIn:     l.attributes.opt_in_process?.replace(/_/g, ' ') || null,
      profileCount: null,
    }));
  }

  return {
    aggregate: { opensUnique: totalOpens, clicksUnique: totalClicks, openRate, clickRate, revenue: null },
    campaigns,
    lists,
    totalListSize: lists.reduce((s, l) => s + (l.profileCount || 0), 0),
  };
}

// ── Ad scoring ────────────────────────────────────────────────────────────────
function adColor(ad) {
  if (ad.status !== 'active') return 'inactive';
  if (ad.purchases > 0) return 'green';
  if (ad.ctr < 0.6 && ad.spend > 3) return 'red';
  return 'yellow';
}

function adRecommendation(ad) {
  if (ad.status !== 'active') return { action: 'Review', text: 'Inactive with no spend this period. Decide whether to reactivate with a fresh angle or archive it.' };
  if (ad.spend < 5) return { action: 'Too early', text: `Only $${ad.spend.toFixed(2)} spent — not enough data yet. Let it reach at least $40 before drawing conclusions.` };
  if (ad.purchases > 0 && ad.costPerPurchase && ad.costPerPurchase < 60) return { action: 'Scale it', text: `Converting at $${ad.costPerPurchase.toFixed(2)} per purchase. Increase budget 20–25% every 3–4 days to scale without resetting the learning phase.` };
  if (ad.purchases > 0 && ad.costPerPurchase && ad.costPerPurchase >= 60) return { action: 'Optimize', text: `Generating purchases but at $${ad.costPerPurchase.toFixed(2)} CPP — above target. Test a tighter audience or stronger CTA before scaling.` };
  if (ad.ctr < 0.6 && ad.spend >= 10) return { action: 'Pause & rework', text: `CTR of ${ad.ctr.toFixed(2)}% is well below average. The creative is not stopping the scroll. Rework the hook or opening visual entirely.` };
  if (ad.ctr >= 1.5 && ad.spend >= 20 && ad.purchases === 0) return { action: 'Review landing page', text: `Good CTR (${ad.ctr.toFixed(2)}%) but no purchases — people click but don't convert. Check product page pricing, images, and shipping clarity.` };
  if (ad.spend >= 50 && ad.purchases === 0) return { action: 'Pause & reassess', text: `$${ad.spend.toFixed(2)} spent with zero purchases. The audience or angle isn't a fit. Pause and test a new concept.` };
  return { action: 'Monitor', text: `CTR is ${ad.ctr.toFixed(2)}%. Needs more spend to exit Meta's learning phase. Reassess once it hits $40–50 total spend.` };
}

// ── Insights engine ───────────────────────────────────────────────────────────
function generateInsights(ads, shopify, combined) {
  const active        = ads.filter(a => a.status==='active' && a.spend>0);
  const converting    = active.filter(a => a.purchases>0);
  const nonConverting = active.filter(a => a.purchases===0 && a.spend>=20);
  const lowCtr        = active.filter(a => a.ctr<0.6 && a.spend>3);
  const bestCtr       = [...active].sort((a,b) => b.ctr-a.ctr)[0];
  const bestCpp       = [...converting].sort((a,b) => (a.costPerPurchase||999)-(b.costPerPurchase||999))[0];
  const topSpender    = [...active].sort((a,b) => b.spend-a.spend)[0];
  const totalSpend    = ads.reduce((s,a) => s+a.spend, 0);

  const working = [], problems = [], nextsteps = [];

  if (converting.length > 0) working.push(`<strong>${converting.map(a=>a.name).join(' and ')}</strong> ${converting.length===1?'is':'are'} generating purchases — proof your creative and audience are aligned.`);
  if (bestCpp) working.push(`<strong>${bestCpp.name}</strong> has your best cost per purchase at $${bestCpp.costPerPurchase?.toFixed(2)} — most efficient ad this period.`);
  if (bestCtr && bestCtr.ctr>1.5) working.push(`<strong>${bestCtr.name}</strong> leads on CTR at ${bestCtr.ctr.toFixed(2)}% — this format is resonating in the feed.`);
  if (shopify && shopify.returnRate<0.08 && shopify.orderCount>5) working.push(`<strong>Low return rate of ${(shopify.returnRate*100).toFixed(1)}%</strong> — customers are keeping what they buy. Strong product-market fit signal.`);
  if (combined?.storeRoas>=3) working.push(`<strong>Store ROAS of ${combined.storeRoas.toFixed(2)}x</strong> — you're making ${combined.storeRoas.toFixed(2)}x back on every dollar spent on ads overall.`);
  if (working.length===0) working.push('Most ads are still in early testing phase. Give converting creatives more budget and pause non-performers to get clearer signals.');

  if (topSpender && totalSpend>0 && (topSpender.spend/totalSpend)>0.6) problems.push(`<strong>Budget concentration risk:</strong> ${((topSpender.spend/totalSpend)*100).toFixed(0)}% of spend is on <strong>${topSpender.name}</strong> alone. If it fatigues, the whole account drops. Scale a second ad now.`);
  if (lowCtr.length>0) problems.push(`<strong>${lowCtr.map(a=>a.name).join(', ')}</strong> ${lowCtr.length===1?'has':'have'} CTR below 0.6% — not earning attention. Wasting impressions and budget.`);
  if (nonConverting.length>=3) problems.push(`<strong>${nonConverting.length} ads have $20+ spend with zero purchases.</strong> Too many simultaneous tests split Meta's learning. Focus on 2–3 at a time.`);
  else if (nonConverting.length>0) problems.push(`<strong>${nonConverting.map(a=>a.name).join(', ')}</strong> ${nonConverting.length===1?'has':'have'} meaningful spend but no purchases. Check whether the landing page matches the ad's promise.`);
  if (shopify?.returnRate>0.15) problems.push(`<strong>High return rate of ${(shopify.returnRate*100).toFixed(1)}%</strong> (${shopify.returnedOrderCount} of ${shopify.orderCount} orders). This erodes actual ROAS. Review sizing guides, product photos, and expectations set in your ads.`);
  if (combined?.pixelGap>0.5 && converting.length>0) problems.push(`<strong>Pixel attribution gap:</strong> Meta claims ${ads.reduce((s,a)=>s+a.purchases,0)} purchases but Shopify shows ${shopify?.orderCount} total orders. Ensure your pixel fires on every Shopify order confirmation page.`);
  if (problems.length===0 && converting.length===0) problems.push('No purchases recorded this period. Verify your Meta pixel fires correctly on the Shopify order confirmation page.');

  converting.forEach(a => nextsteps.push(`<strong>Scale ${a.name}:</strong> Increase budget 20–25% every 3–4 days. Above-average Meta rankings confirm it's ready to scale.`));
  if (lowCtr.length>0) nextsteps.push(`<strong>Pause ${lowCtr.map(a=>a.name).join(' and ')}:</strong> Rework the hook, thumbnail, or opening line entirely.`);
  nextsteps.push('<strong>Enforce a $40–50 test budget rule:</strong> Zero purchases + low CTR at $40 → pause. One purchase at $40 → graduate to dedicated budget.');
  if (shopify?.returnRate>0.1) nextsteps.push('<strong>Reduce returns:</strong> Add a size guide with measurements, improve fit photos on different body types, and set honest expectations in your ad copy.');
  if (combined?.storeRoas<2 && totalSpend>200) nextsteps.push(`<strong>Improve store conversion rate:</strong> Store ROAS of ${combined.storeRoas.toFixed(2)}x isn't yet profitable at scale. Focus on product page CRO — reviews, fit images, sizing confidence, fast checkout.`);
  if (active.length>6) nextsteps.push('<strong>Cut active ad count to 3–5:</strong> Too many ads fragment Meta\'s optimization signal. Keep your best-performing formats.');

  return { working, problems, nextsteps };
}

// ── OAuth routes ──────────────────────────────────────────────────────────────
let oauthState = null;

app.get('/shopify/auth', (req, res) => {
  if (!shopifyCredsOk()) {
    return res.status(400).send('Shopify client credentials not configured. Run bash setup.sh first.');
  }
  oauthState = crypto.randomBytes(16).toString('hex');
  const url = new URL(`https://${SHOPIFY_DOMAIN}/admin/oauth/authorize`);
  url.searchParams.set('client_id', SHOPIFY_CLIENT_ID);
  url.searchParams.set('scope', SHOPIFY_SCOPES);
  url.searchParams.set('redirect_uri', SHOPIFY_REDIRECT);
  url.searchParams.set('state', oauthState);
  res.redirect(url.toString());
});

app.get('/shopify/callback', async (req, res) => {
  const { hmac, code, state } = req.query;

  if (!state || state !== oauthState) {
    return res.status(403).send('Invalid state parameter. Please try connecting again.');
  }
  oauthState = null;

  // Verify HMAC — sign all params except hmac itself
  if (hmac) {
    const msg      = Object.entries(req.query)
      .filter(([k]) => k !== 'hmac')
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k,v]) => `${k}=${v}`)
      .join('&');
    const expected = crypto.createHmac('sha256', SHOPIFY_CLIENT_SECRET).update(msg).digest('hex');
    if (expected !== hmac) return res.status(403).send('HMAC verification failed.');
  }

  try {
    const tokenRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code })
    });
    const data = await tokenRes.json();

    if (!data.access_token) {
      return res.status(400).send(`Token exchange failed: ${JSON.stringify(data)}`);
    }

    process.env.SHOPIFY_ACCESS_TOKEN = data.access_token;
    updateEnvFile('SHOPIFY_ACCESS_TOKEN', data.access_token);
    console.log('\n  [Shopify] Connected successfully. Token saved to .env.\n');

    res.send(`<!DOCTYPE html><html>
      <head><style>
        body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;}
        .card{background:white;padding:40px 48px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.1);text-align:center;}
        .check{font-size:40px;margin-bottom:12px;}
        h2{margin:0 0 8px;font-size:20px;}
        p{color:#666;margin:0;font-size:14px;}
      </style></head>
      <body><div class="card">
        <div class="check">✓</div>
        <h2>Shopify Connected!</h2>
        <p>Closing in a moment…</p>
      </div>
      <script>setTimeout(()=>window.close(),1800);</script>
    </body></html>`);
  } catch (err) {
    console.error('[Shopify OAuth] Error:', err.message);
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

// ── /api/shopify/status ───────────────────────────────────────────────────────
app.get('/api/shopify/status', (req, res) => {
  res.json({
    credsConfigured: shopifyCredsOk(),
    connected: shopifyReady(),
    domain: SHOPIFY_DOMAIN,
  });
});

// ── /api/combined ─────────────────────────────────────────────────────────────
app.get('/api/combined', async (req, res) => {
  try {
    const { date_preset, since: sinceQ, until: untilQ } = req.query;
    const preset = date_preset || 'last_30d';
    const range  = (sinceQ && untilQ) ? { since: sinceQ, until: untilQ } : presetToRange(preset);
    const { since, until } = range;

    const metaDateParam = (sinceQ && untilQ)
      ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
      : `date_preset=${preset}`;

    const insightsFields = [
      'ad_id','ad_name','spend','impressions','reach','frequency',
      'cpm','ctr','clicks','cpc',
      'actions','action_values','cost_per_action_type',
      'quality_ranking','engagement_rate_ranking','conversion_rate_ranking'
    ].join(',');

    const [adsRaw, insightsRaw, shopifyRaw] = await Promise.allSettled([
      metaGetAll(`${META_BASE}/${ACCOUNT}/ads?fields=id,name,status,effective_status&limit=100&access_token=${META_TOKEN}`),
      metaGetAll(`${META_BASE}/${ACCOUNT}/insights?level=ad&fields=${insightsFields}&${metaDateParam}&limit=100&access_token=${META_TOKEN}`),
      shopifyReady() ? fetchShopifyMetrics(since, until) : Promise.resolve(null)
    ]);

    if (adsRaw.status==='rejected')      throw new Error(adsRaw.reason?.message||'Meta ads fetch failed');
    if (insightsRaw.status==='rejected') throw new Error(insightsRaw.reason?.message||'Meta insights fetch failed');

    const insMap = {};
    insightsRaw.value.forEach(i => { insMap[i.ad_id] = i; });

    const ads = adsRaw.value.map(ad => {
      const ins             = insMap[ad.id] || {};
      const spend           = parseFloat(ins.spend||0);
      const purchases       = extractAction(ins.actions, 'offsite_conversion.fb_pixel_purchase')||0;
      const lpViews         = extractAction(ins.actions, 'landing_page_view')||0;
      const pixelRevenue    = extractAction(ins.action_values, 'offsite_conversion.fb_pixel_purchase')||0;
      const cppRaw          = extractAction(ins.cost_per_action_type, 'offsite_conversion.fb_pixel_purchase');
      const costPerPurchase = cppRaw||(purchases>0 ? spend/purchases : null);
      const base = {
        id: ad.id, name: ad.name,
        status: (ad.effective_status || ad.status).toLowerCase(), spend,
        impressions: parseInt(ins.impressions||0), reach: parseInt(ins.reach||0),
        frequency: parseFloat(ins.frequency||0), cpm: parseFloat(ins.cpm||0),
        ctr: parseFloat(ins.ctr||0), clicks: parseInt(ins.clicks||0), cpc: parseFloat(ins.cpc||0),
        purchases: Math.round(purchases), lpViews: Math.round(lpViews),
        pixelRevenue: parseFloat(pixelRevenue.toFixed(2)),
        costPerPurchase: costPerPurchase ? parseFloat(costPerPurchase.toFixed(2)) : null,
        qualityRanking: ins.quality_ranking||null,
        engagementRanking: ins.engagement_rate_ranking||null,
        conversionRanking: ins.conversion_rate_ranking||null,
      };
      base.color          = adColor(base);
      base.recommendation = adRecommendation(base);
      return base;
    });

    ads.sort((a,b) => {
      const rank = x => x.status==='active'&&x.spend>0 ? 0 : x.status==='active' ? 1 : 2;
      return rank(a)-rank(b)||b.spend-a.spend;
    });

    const totalSpend        = ads.reduce((s,a)=>s+a.spend,0);
    const totalPurchases    = ads.reduce((s,a)=>s+a.purchases,0);
    const totalPixelRevenue = ads.reduce((s,a)=>s+a.pixelRevenue,0);
    const avgCpp            = totalPurchases>0 ? totalSpend/totalPurchases : null;
    const metaRoas          = totalSpend>0&&totalPixelRevenue>0 ? totalPixelRevenue/totalSpend : null;

    const greenAds = ads.filter(a=>a.color==='green');
    const redAds   = ads.filter(a=>a.color==='red');
    const active   = ads.filter(a=>a.status==='active'&&a.spend>0);

    let healthScore, healthLabel, healthDesc;
    if (greenAds.length>=2&&redAds.length===0)    { healthScore='green';  healthLabel='Healthy';         healthDesc='Multiple ads converting efficiently. Scale what\'s working.'; }
    else if (greenAds.length>=1)                   { healthScore='yellow'; healthLabel='Needs Attention'; healthDesc='Solid proof of concept on your top ads, but most active ads aren\'t converting yet.'; }
    else if (totalPurchases===0&&totalSpend>100)   { healthScore='red';    healthLabel='Critical';        healthDesc='Meaningful spend with zero purchases. Check pixel, landing page, and targeting immediately.'; }
    else                                           { healthScore='yellow'; healthLabel='Early Stage';     healthDesc='Most ads are in testing phase. Give converting creatives more budget and pause non-performers.'; }

    const sortedByPurch = [...ads].filter(a=>a.purchases>0).sort((a,b)=>b.purchases-a.purchases);
    const bestAd  = sortedByPurch[0] || [...ads].filter(a=>a.status==='active').sort((a,b)=>b.ctr-a.ctr)[0]||null;
    const worstAd = [...ads].filter(a=>a.status==='active'&&a.spend>3).sort((a,b)=>a.ctr-b.ctr)[0]||null;

    const shopify      = shopifyRaw.status==='fulfilled' ? shopifyRaw.value : null;
    const shopifyError = shopifyRaw.status==='rejected'  ? shopifyRaw.reason?.message : null;

    const combined = shopify ? {
      storeRoas: totalSpend>0 ? parseFloat((shopify.netRevenue/totalSpend).toFixed(2)) : null,
      metaRoas:  metaRoas ? parseFloat(metaRoas.toFixed(2)) : null,
      pixelGap:  shopify.orderCount>0 ? Math.max(0, 1-(totalPurchases/shopify.orderCount)) : 0,
    } : { metaRoas: metaRoas ? parseFloat(metaRoas.toFixed(2)) : null };

    res.json({
      success: true,
      fetchedAt: new Date().toISOString(),
      dateRange: { since, until, preset },
      shopifyStatus: { credsConfigured: shopifyCredsOk(), connected: shopifyReady() },
      meta: {
        summary: { totalSpend, totalPurchases, totalPixelRevenue, avgCpp, metaRoas: combined.metaRoas, healthScore, healthLabel, healthDesc },
        bestAd, worstAd, ads
      },
      shopify: shopify ? { configured: true, ...shopify } : { configured: false, error: shopifyError },
      combined,
      insights: generateInsights(ads, shopify, combined),
    });

  } catch (err) {
    console.error('[API Error]', err.message);
    res.status(500).json({ success: false, error: err.message, tokenExpired: err.tokenExpired || false });
  }
});

// ── /api/trends ───────────────────────────────────────────────────────────────
function weekLabel(start) {
  const d = new Date(start + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function pctChange(curr, prev) {
  if (prev == null || prev === 0) return null;
  return parseFloat(((curr - prev) / Math.abs(prev) * 100).toFixed(1));
}

app.get('/api/trends', async (req, res) => {
  try {
    const metaFields = [
      'spend','impressions','cpm','ctr','clicks',
      'actions','action_values'
    ].join(',');

    // Meta: 4 weekly buckets over last 28 days
    const [metaWeeksRaw, shopifyOrdersRaw, klaviyoTrendsRaw] = await Promise.allSettled([
      metaGetAll(`${META_BASE}/${ACCOUNT}/insights?fields=${metaFields}&time_increment=7&date_preset=last_28d&access_token=${META_TOKEN}`),
      shopifyReady() ? (async () => {
        const { since, until } = presetToRange('last_28d');
        const fields = 'id,total_price,financial_status,refunds,created_at';
        return shopifyGetAll(`/orders.json?status=any&created_at_min=${since}T00:00:00Z&created_at_max=${until}T23:59:59Z&limit=250&fields=${fields}`);
      })() : Promise.resolve(null),
      klaviyoReady() ? fetchKlaviyoTrendsData() : Promise.resolve(null),
    ]);

    if (metaWeeksRaw.status === 'rejected') throw new Error(metaWeeksRaw.reason?.message || 'Meta trends fetch failed');

    const allShopifyOrders = shopifyOrdersRaw.status === 'fulfilled' ? shopifyOrdersRaw.value : null;
    const klaviyoTrends    = klaviyoTrendsRaw.status === 'fulfilled' ? klaviyoTrendsRaw.value : null;
    if (klaviyoTrendsRaw.status === 'rejected') console.error('[Trends] Klaviyo fetch failed:', klaviyoTrendsRaw.reason?.message);

    const weeks = metaWeeksRaw.value.map(w => {
      const spend        = parseFloat(w.spend || 0);
      const purchases    = extractAction(w.actions, 'offsite_conversion.fb_pixel_purchase') || 0;
      const pixelRevenue = extractAction(w.action_values, 'offsite_conversion.fb_pixel_purchase') || 0;
      const metaRoas     = spend > 0 && pixelRevenue > 0 ? parseFloat((pixelRevenue / spend).toFixed(2)) : null;

      let shopify = null;
      if (allShopifyOrders) {
        const weekOrders = allShopifyOrders
          .filter(o => { const d = o.created_at.slice(0,10); return d >= w.date_start && d <= w.date_stop; })
          .filter(o => ['paid','partially_refunded','refunded'].includes(o.financial_status));
        const gross  = weekOrders.reduce((s,o) => s + parseFloat(o.total_price||0), 0);
        const refund = weekOrders.reduce((s,o) => s + calcRefundAmount(o), 0);
        const net    = gross - refund;
        const count  = weekOrders.length;
        shopify = { orderCount: count, grossRevenue: gross, netRevenue: net, aov: count > 0 ? net/count : 0 };
      }

      // Bucket Klaviyo campaigns sent during this week
      let email = null;
      if (klaviyoTrends?.campaigns?.length) {
        const matching = klaviyoTrends.campaigns.filter(c => {
          if (!c.sentAt) return false;
          const d = c.sentAt.slice(0, 10);
          return d >= w.date_start && d <= w.date_stop;
        });
        if (matching.length > 0) {
          const withOpen  = matching.filter(c => c.openRate  != null);
          const withClick = matching.filter(c => c.clickRate != null);
          email = {
            campaignCount: matching.length,
            avgOpenRate:   withOpen.length  > 0 ? parseFloat((withOpen.reduce((s,c)  => s + c.openRate,  0) / withOpen.length).toFixed(1))  : null,
            avgClickRate:  withClick.length > 0 ? parseFloat((withClick.reduce((s,c) => s + c.clickRate, 0) / withClick.length).toFixed(1)) : null,
          };
        }
      }

      return {
        label:     weekLabel(w.date_start),
        since:     w.date_start,
        until:     w.date_stop,
        meta:      { spend, purchases: Math.round(purchases), pixelRevenue: parseFloat(pixelRevenue.toFixed(2)), metaRoas, impressions: parseInt(w.impressions||0), cpm: parseFloat(w.cpm||0), ctr: parseFloat(w.ctr||0), clicks: parseInt(w.clicks||0) },
        shopify,
        email,
        storeRoas: shopify && spend > 0 ? parseFloat((shopify.netRevenue / spend).toFixed(2)) : null,
      };
    });

    // Week-over-week change: last week vs the one before it
    let changes = null;
    if (weeks.length >= 2) {
      const cur = weeks[weeks.length - 1];
      const prv = weeks[weeks.length - 2];
      changes = {
        spend:          pctChange(cur.meta.spend,     prv.meta.spend),
        purchases:      pctChange(cur.meta.purchases, prv.meta.purchases),
        ctr:            pctChange(cur.meta.ctr,       prv.meta.ctr),
        cpm:            pctChange(cur.meta.cpm,       prv.meta.cpm),
        revenue:        cur.shopify && prv.shopify ? pctChange(cur.shopify.netRevenue, prv.shopify.netRevenue) : null,
        aov:            cur.shopify && prv.shopify ? pctChange(cur.shopify.aov,        prv.shopify.aov)        : null,
        storeRoas:      cur.storeRoas && prv.storeRoas ? pctChange(cur.storeRoas, prv.storeRoas) : null,
        emailOpenRate:  cur.email?.avgOpenRate  != null && prv.email?.avgOpenRate  != null ? pctChange(cur.email.avgOpenRate,  prv.email.avgOpenRate)  : null,
        emailClickRate: cur.email?.avgClickRate != null && prv.email?.avgClickRate != null ? pctChange(cur.email.avgClickRate, prv.email.avgClickRate) : null,
      };
    }

    res.json({ success: true, fetchedAt: new Date().toISOString(), weeks, changes, shopifyConnected: shopifyReady(), klaviyoConnected: klaviyoReady() });
  } catch (err) {
    console.error('[Trends API Error]', err.message);
    res.status(500).json({ success: false, error: err.message, tokenExpired: err.tokenExpired || false });
  }
});

// ── /api/klaviyo/debug (temporary) ───────────────────────────────────────────
app.get('/api/klaviyo/debug', async (req, res) => {
  if (!klaviyoReady()) return res.json({ error: 'Klaviyo not configured' });
  try {
    const [metrics, campaigns, lists] = await Promise.allSettled([
      klaviyoGet('/metrics/'),
      klaviyoGet('/campaigns/?sort=-updated_at'),
      klaviyoGet('/lists/'),
    ]);
    res.json({
      metrics:   metrics.status   === 'fulfilled' ? { count: metrics.value.data?.length,   sample: metrics.value.data?.[0] }   : { error: metrics.reason?.message },
      campaigns: campaigns.status === 'fulfilled' ? { count: campaigns.value.data?.length, sample: campaigns.value.data?.[0] } : { error: campaigns.reason?.message },
      lists:     lists.status     === 'fulfilled' ? { count: lists.value.data?.length,     sample: lists.value.data?.[0] }     : { error: lists.reason?.message },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /api/klaviyo/status ───────────────────────────────────────────────────────
app.get('/api/klaviyo/status', (req, res) => {
  res.json({ configured: klaviyoReady() });
});

// ── /api/klaviyo ──────────────────────────────────────────────────────────────
app.get('/api/klaviyo', async (req, res) => {
  if (!klaviyoReady()) {
    return res.json({ success: false, notConfigured: true, error: 'Klaviyo private key not configured. Run bash setup.sh.' });
  }
  try {
    const data = await fetchKlaviyoData();
    res.json({ success: true, fetchedAt: new Date().toISOString(), ...data });
  } catch (err) {
    console.error('[Klaviyo API Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Meta account-level spend helper ──────────────────────────────────────────
async function metaAccountSpend(since, until) {
  try {
    const data = await metaGetAll(`${META_BASE}/${ACCOUNT}/insights?level=account&fields=spend&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&access_token=${META_TOKEN}`);
    return data.reduce((s, r) => s + parseFloat(r.spend || 0), 0);
  } catch { return null; }
}

// ── Inventory data fetch ──────────────────────────────────────────────────────
async function fetchInventoryData() {
  const now  = new Date();
  const pad  = n => String(n).padStart(2, '0');
  const fmt  = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const ago  = n => { const d = new Date(now); d.setDate(d.getDate()-n); return fmt(d); };
  const today   = fmt(now);
  const since28 = ago(28);
  const since7  = ago(7);
  const since14 = ago(14);
  const since21 = ago(21);

  const [productsRaw, ordersRaw, currSpendRaw, prevSpendRaw] = await Promise.allSettled([
    shopifyGetAll(`/products.json?status=active&limit=250&fields=id,title,variants`),
    shopifyGetAll(`/orders.json?status=any&financial_status=paid&created_at_min=${since28}T00:00:00Z&limit=250&fields=id,created_at,line_items`),
    metaAccountSpend(since7, today),
    metaAccountSpend(since14, since7),
  ]);

  const products = productsRaw.status === 'fulfilled' ? productsRaw.value : [];
  const orders   = ordersRaw.status   === 'fulfilled' ? ordersRaw.value   : [];
  const currSpend = currSpendRaw.status === 'fulfilled' ? currSpendRaw.value : null;
  const prevSpend = prevSpendRaw.status === 'fulfilled' ? prevSpendRaw.value : null;

  // Build velocity map: variantId -> units sold in 28 days
  const velocityMap = {};
  for (const order of orders) {
    for (const item of (order.line_items || [])) {
      const vid = String(item.variant_id);
      velocityMap[vid] = (velocityMap[vid] || 0) + (item.quantity || 0);
    }
  }

  const leadTimes = loadLeadTimes();

  // Ad spend velocity multiplier (70% elasticity)
  let adSpendMultiplier = 1;
  let spendChangePercent = null;
  if (currSpend != null && prevSpend != null && prevSpend > 0) {
    spendChangePercent = parseFloat(((currSpend / prevSpend - 1) * 100).toFixed(1));
    adSpendMultiplier = 1 + ((currSpend / prevSpend - 1) * 0.7);
  }

  const productList = [];
  let totalInventory = 0, totalInventoryValue = 0;
  let criticalCount = 0, reorderCount = 0, warnCount = 0, trackedCount = 0, adRiskCount = 0;

  for (const product of products) {
    const variants = [];
    for (const v of (product.variants || [])) {
      const tracked  = v.inventory_management === 'shopify';
      const inventory = tracked ? Math.max(0, parseInt(v.inventory_quantity) || 0) : null;
      const unitsSold = velocityMap[String(v.id)] || 0;
      const dailyVelocity = unitsSold / 28;
      const daysRemaining = (tracked && dailyVelocity > 0) ? inventory / dailyVelocity : null;
      const ltEntry       = leadTimes[String(v.id)] || {};
      const leadTimeDays  = ltEntry.leadTimeDays != null ? ltEntry.leadTimeDays : 21;
      const reorderQty    = ltEntry.reorderQty   != null ? ltEntry.reorderQty   : 0;
      const reorderPoint  = dailyVelocity * leadTimeDays;

      let status;
      if (tracked && inventory === 0)                                            status = 'stockout';
      else if (tracked && inventory !== null && inventory < 10)                  status = 'critical';
      else if (tracked && daysRemaining !== null && daysRemaining <= leadTimeDays) status = 'reorder';
      else if (tracked && daysRemaining !== null && daysRemaining <= 30)         status = 'warn';
      else                                                                        status = 'ok';

      const projDailyVel     = dailyVelocity * adSpendMultiplier;
      const projDaysRemaining = (tracked && projDailyVel > 0) ? inventory / projDailyVel : null;
      const adSpendRisk = (
        tracked &&
        inventory !== null &&
        projDaysRemaining !== null &&
        projDaysRemaining <= leadTimeDays &&
        (daysRemaining === null || daysRemaining > leadTimeDays)
      );

      if (tracked) {
        trackedCount++;
        if (status === 'stockout' || status === 'critical') criticalCount++;
        if (status === 'reorder') reorderCount++;
        if (status === 'warn')    warnCount++;
        if (adSpendRisk)          adRiskCount++;
        if (inventory !== null) {
          totalInventory      += inventory;
          totalInventoryValue += inventory * parseFloat(v.price || 0);
        }
      }

      variants.push({
        id:             v.id,
        title:          v.title,
        sku:            v.sku || '',
        price:          parseFloat(v.price || 0),
        tracked,
        inventory,
        unitsSold,
        dailyVelocity:  parseFloat(dailyVelocity.toFixed(3)),
        daysRemaining:  daysRemaining !== null ? parseFloat(daysRemaining.toFixed(1)) : null,
        leadTimeDays,
        reorderQty,
        reorderPoint:   parseFloat(reorderPoint.toFixed(1)),
        status,
        projDailyVel:   parseFloat(projDailyVel.toFixed(3)),
        projDaysRemaining: projDaysRemaining !== null ? parseFloat(projDaysRemaining.toFixed(1)) : null,
        adSpendRisk,
      });
    }
    productList.push({ id: product.id, title: product.title, variants });
  }

  // Goal alignment
  const year      = now.getFullYear();
  const yearStart = `${year}-01-01`;
  let ytdRevenue = 0, avgItemPrice = 0, unitsNeeded = null, canHitGoal = null;
  try {
    const ytd = await fetchShopifyMetrics(yearStart, today);
    ytdRevenue = ytd.netRevenue || 0;
    avgItemPrice = ytd.aov || 45;
  } catch { avgItemPrice = 45; }

  const ANNUAL_GOAL = 100000;
  const remaining   = ANNUAL_GOAL - ytdRevenue;
  if (avgItemPrice > 0) {
    unitsNeeded  = Math.ceil(remaining / avgItemPrice);
    canHitGoal   = totalInventory >= unitsNeeded;
  }

  // Rule-based recommendations (max 4)
  const recommendations = [];
  if (criticalCount > 0) {
    recommendations.push({
      urgency:   'critical',
      message:   `${criticalCount} variant${criticalCount > 1 ? 's are' : ' is'} critically low (under 10 units). Reorder immediately to avoid stockouts that kill revenue momentum.`,
      principle: 'E-Myth Revisited',
      author:    'Gerber',
    });
  }
  if (reorderCount > 0 && recommendations.length < 4) {
    recommendations.push({
      urgency:   'high',
      message:   `${reorderCount} variant${reorderCount > 1 ? 's are' : ' is'} at or past reorder point — days remaining ≤ lead time. Place purchase orders now to avoid gaps in fulfillment.`,
      principle: 'E-Myth Revisited',
      author:    'Gerber',
    });
  }
  if (adRiskCount > 0 && spendChangePercent != null && spendChangePercent > 10 && recommendations.length < 4) {
    recommendations.push({
      urgency:   'high',
      message:   `Ad spend is up ${spendChangePercent}% week-over-week. At current trajectory, ${adRiskCount} variant${adRiskCount > 1 ? 's' : ''} will stock out before the next reorder can arrive. Restock or pause scaling.`,
      principle: 'Oversubscribed',
      author:    'Priestley',
    });
  }
  if (!canHitGoal && unitsNeeded !== null && recommendations.length < 4) {
    const gap = unitsNeeded - totalInventory;
    recommendations.push({
      urgency:   'medium',
      message:   `To hit $${ANNUAL_GOAL.toLocaleString()}, you need ~${unitsNeeded.toLocaleString()} more units at current AOV. You have ${totalInventory.toLocaleString()} tracked units — a gap of ${gap.toLocaleString()} units ($${(gap * avgItemPrice).toLocaleString(undefined, {maximumFractionDigits:0})}). Prioritize restocking best-sellers.`,
      principle: 'Think and Grow Rich',
      author:    'Hill',
    });
  }

  return {
    products:      productList,
    summary: {
      totalInventory, totalInventoryValue: parseFloat(totalInventoryValue.toFixed(2)),
      criticalCount, reorderCount, warnCount, trackedCount, adRiskCount,
    },
    adSpend: {
      currWeek:        currSpend,
      prevWeek:        prevSpend,
      changePercent:   spendChangePercent,
      multiplier:      parseFloat(adSpendMultiplier.toFixed(3)),
    },
    goalAlignment: {
      ytdRevenue:      parseFloat(ytdRevenue.toFixed(2)),
      annualGoal:      ANNUAL_GOAL,
      remaining:       parseFloat(remaining.toFixed(2)),
      avgItemPrice:    parseFloat(avgItemPrice.toFixed(2)),
      unitsNeeded,
      totalInventory,
      canHitGoal,
    },
    recommendations,
    leadTimes,
    fetchedAt: new Date().toISOString(),
  };
}

// ── /api/pnl ──────────────────────────────────────────────────────────────────
app.get('/api/pnl', async (req, res) => {
  try {
    const now   = new Date();
    const year  = now.getFullYear();
    const month = now.getMonth(); // 0-indexed
    const pad   = n => String(n).padStart(2, '0');
    const fmt   = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

    const today          = fmt(now);
    const monthStart     = `${year}-${pad(month+1)}-01`;
    const yearStart      = `${year}-01-01`;
    const lastMonthStart = fmt(new Date(year, month-1, 1));
    const lastMonthEnd   = fmt(new Date(year, month, 0));

    const dayOfYear        = Math.floor((now - new Date(year, 0, 1)) / 864e5) + 1;
    const daysInYear       = new Date(year, 1, 29).getMonth() === 1 ? 366 : 365;
    const daysElapsedMonth = now.getDate();
    const daysInMonth      = new Date(year, month+1, 0).getDate();
    const ANNUAL_GOAL      = 100000;
    const monthlyTarget    = ANNUAL_GOAL / 12;
    const expectedByNow    = (dayOfYear / daysInYear) * ANNUAL_GOAL;

    const [tmRaw, lmRaw, yrRaw, adsTMRaw, adsLMRaw, adsYTDRaw] = await Promise.allSettled([
      shopifyReady() ? fetchShopifyMetrics(monthStart, today)           : Promise.resolve(null),
      shopifyReady() ? fetchShopifyMetrics(lastMonthStart, lastMonthEnd) : Promise.resolve(null),
      shopifyReady() ? fetchShopifyMetrics(yearStart, today)            : Promise.resolve(null),
      metaAccountSpend(monthStart, today),
      metaAccountSpend(lastMonthStart, lastMonthEnd),
      metaAccountSpend(yearStart, today),
    ]);

    const ok  = r => r.status === 'fulfilled' ? r.value : null;
    const tm  = ok(tmRaw);
    const lm  = ok(lmRaw);
    const yr  = ok(yrRaw);
    const adsTM  = ok(adsTMRaw);
    const adsLM  = ok(adsLMRaw);
    const adsYTD = ok(adsYTDRaw);

    const expenses      = loadExpenses();
    const subs          = loadSubscriptions();
    const subsTotals    = getSubsTotals(subs);

    // Shipping estimate: fulfilled orders × avg label cost
    let shippingEstimate   = null;
    let shippingOrderCount = null;
    if (subs.shipping?.autoEstimate && shopifyReady()) {
      shippingOrderCount = await fetchFulfilledOrderCount(monthStart, today);
      if (shippingOrderCount !== null) {
        shippingEstimate = parseFloat((shippingOrderCount * (subs.shipping.avgLabelCost || 6.00)).toFixed(2));
      }
    }

    // Fixed category totals (from subscriptions.json) + shipping estimate
    const allCategoryTotals = {
      shopify_subscription: subsTotals['shopify_subscription'] || 0,
      shopify_apps:         subsTotals['shopify_apps']         || 0,
      shopify_shipping:     shippingEstimate !== null ? shippingEstimate : (subsTotals['shopify_shipping'] || 0),
      klaviyo:              subsTotals['klaviyo']              || 0,
      loop_returns:         subsTotals['loop_returns']         || 0,
      apps_tools:           subsTotals['apps_tools']           || 0,
    };

    const manualTotal   = MANUAL_EXPENSE_KEYS.reduce((s, k) => s + (parseFloat(expenses[k]) || 0), 0);
    const subsTotal     = Object.values(allCategoryTotals).reduce((s, v) => s + v, 0);
    const totalExpenses = subsTotal + manualTotal + (adsTM || 0);
    const monthRevenue  = tm?.netRevenue || 0;
    const yearRevenue   = yr?.netRevenue || 0;
    const netProfit     = monthRevenue - totalExpenses;
    const burnRate      = daysElapsedMonth > 0 ? totalExpenses / daysElapsedMonth : 0;
    const margin        = monthRevenue > 0 ? (netProfit / monthRevenue) * 100 : null;
    const monthExpected = (daysElapsedMonth / daysInMonth) * monthlyTarget;
    const paceGap       = yearRevenue - expectedByNow;
    const monthPaceGap  = monthRevenue - monthExpected;

    res.json({
      success: true,
      fetchedAt:       new Date().toISOString(),
      shopifyConnected: shopifyReady(),
      currentMonth:    now.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      goal: {
        annual:        ANNUAL_GOAL,
        monthlyTarget: parseFloat(monthlyTarget.toFixed(2)),
        yearRevenue:   parseFloat(yearRevenue.toFixed(2)),
        expectedByNow: parseFloat(expectedByNow.toFixed(2)),
        pctComplete:   parseFloat((yearRevenue / ANNUAL_GOAL * 100).toFixed(2)),
        paceGap:       parseFloat(paceGap.toFixed(2)),
        paceStatus:    paceGap >= 0 ? 'ahead' : Math.abs(paceGap) <= 0.1 * expectedByNow ? 'close' : 'behind',
        dayOfYear, daysInYear,
        daysRemaining: daysInYear - dayOfYear,
      },
      revenue: {
        thisMonth: tm ? { ...tm, dateRange: { since: monthStart,     until: today         } } : null,
        lastMonth: lm ? { ...lm, dateRange: { since: lastMonthStart, until: lastMonthEnd  } } : null,
        thisYear:  yr ? { ...yr, dateRange: { since: yearStart,      until: today         } } : null,
        monthTarget: parseFloat(monthlyTarget.toFixed(2)),
        monthPace: {
          daysElapsed:  daysElapsedMonth,
          daysInMonth,
          daysRemaining: daysInMonth - daysElapsedMonth,
          expected:     parseFloat(monthExpected.toFixed(2)),
          paceGap:      parseFloat(monthPaceGap.toFixed(2)),
          paceStatus:   monthPaceGap >= 0 ? 'ahead' : 'behind',
        },
      },
      expenses: {
        // This-month view (used as base for fixed subs amounts per month)
        adsTM:        adsTM  != null ? parseFloat(adsTM.toFixed(2))  : null,
        adsLM:        adsLM  != null ? parseFloat(adsLM.toFixed(2))  : null,
        adsYTD:       adsYTD != null ? parseFloat(adsYTD.toFixed(2)) : null,
        manual:       Object.fromEntries(MANUAL_EXPENSE_KEYS.map(k => [k, parseFloat(expenses[k]) || 0])),
        subscriptions: {
          items:    subs.items,
          settings: subs.shipping,
        },
        // Monthly fixed sub totals per category (multiply by months for YTD)
        monthlySubTotals: Object.fromEntries(Object.entries(allCategoryTotals).map(([k,v]) => [k, parseFloat(v.toFixed(2))])),
        shipping: shippingEstimate !== null ? {
          estimated:    shippingEstimate,
          orderCount:   shippingOrderCount,
          avgLabelCost: subs.shipping.avgLabelCost,
        } : null,
        notes: expenses.notes || '',
        // Precomputed this-month total (for backwards compat)
        total: parseFloat(totalExpenses.toFixed(2)),
        // Calendar helpers the frontend needs to scale subs for each period
        monthsElapsedYTD: month + 1,
        daysElapsedMonth,
        daysInMonth,
        dayOfYear,
        daysInYear,
      },
      pnl: {
        netProfit: parseFloat(netProfit.toFixed(2)),
        burnRate:  parseFloat(burnRate.toFixed(2)),
        margin:    margin != null ? parseFloat(margin.toFixed(1)) : null,
      },
    });
  } catch (err) {
    console.error('[P&L API Error]', err.message);
    res.status(500).json({ success: false, error: err.message, tokenExpired: err.tokenExpired || false });
  }
});

// ── /api/subscriptions ────────────────────────────────────────────────────────
app.get('/api/subscriptions', (req, res) => {
  res.json({ success: true, ...loadSubscriptions() });
});

app.post('/api/subscriptions', express.json(), (req, res) => {
  try {
    const data = loadSubscriptions();
    const item = req.body;
    if (!item.id || !item.name || !item.category || item.amount == null)
      return res.status(400).json({ success: false, error: 'Missing required fields: id, name, category, amount' });
    item.amount = Math.max(0, parseFloat(item.amount) || 0);
    item.active = item.active !== false;
    const idx = data.items.findIndex(s => s.id === item.id);
    if (idx >= 0) data.items[idx] = { ...data.items[idx], ...item };
    else data.items.push(item);
    saveSubscriptions(data);
    res.json({ success: true, items: data.items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/subscriptions/:id', (req, res) => {
  try {
    const data = loadSubscriptions();
    data.items = data.items.filter(s => s.id !== req.params.id);
    saveSubscriptions(data);
    res.json({ success: true, items: data.items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/subscriptions/settings', express.json(), (req, res) => {
  try {
    const data = loadSubscriptions();
    const { avgLabelCost, autoEstimate } = req.body;
    if (avgLabelCost != null) data.shipping.avgLabelCost = Math.max(0, parseFloat(avgLabelCost) || 0);
    if (autoEstimate != null) data.shipping.autoEstimate = !!autoEstimate;
    saveSubscriptions(data);
    res.json({ success: true, shipping: data.shipping });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/pnl/expenses', express.json(), (req, res) => {
  try {
    const incoming = req.body || {};
    const expenses = Object.fromEntries(
      MANUAL_EXPENSE_KEYS.map(k => [k, Math.max(0, parseFloat(incoming[k]) || 0)])
    );
    if (typeof incoming.notes === 'string') expenses.notes = incoming.notes.slice(0, 2000);
    saveExpenses(expenses);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── /api/inventory ─────────────────────────────────────────────────────────────
app.get('/api/inventory', async (req, res) => {
  if (!shopifyReady()) return res.json({ success: false, notConnected: true, error: 'Shopify not connected.' });
  try {
    const data = await fetchInventoryData();
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[Inventory API Error]', err.message);
    const scopeError = err.message?.includes('403') || err.message?.toLowerCase().includes('scope') || err.message?.toLowerCase().includes('permission');
    res.status(scopeError ? 403 : 500).json({ success: false, error: err.message, scopeError });
  }
});

app.post('/api/inventory/lead-times', express.json(), (req, res) => {
  try {
    const existing = loadLeadTimes();
    const incoming = req.body || {};
    // incoming: { variantId: { leadTimeDays, reorderQty } }
    Object.entries(incoming).forEach(([vid, vals]) => {
      existing[String(vid)] = {
        leadTimeDays: Math.max(1, parseInt(vals.leadTimeDays) || 21),
        reorderQty:   Math.max(0, parseInt(vals.reorderQty)   || 0),
      };
    });
    saveLeadTimes(existing);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── /api/waitlist-demand (Klaviyo back-in-stock signups by product + size) ────
let _bisMetricId = null;
async function getBisMetricId() {
  if (_bisMetricId) return _bisMetricId;
  const data = await klaviyoGet('/metrics/');
  const m = (data.data || []).find(x => x.attributes?.name === 'Subscribed to Back in Stock');
  _bisMetricId = m?.id || null;
  return _bisMetricId;
}

app.get('/api/waitlist-demand', async (req, res) => {
  if (!klaviyoReady()) return res.json({ success: false, error: 'Klaviyo not configured' });
  try {
    const metricId = await getBisMetricId();
    if (!metricId) return res.json({ success: true, products: [], fetchedAt: new Date().toISOString() });

    // Paginate the Subscribed-to-Back-in-Stock events. Dedupe by profile+variant so a
    // repeat signup for the same size counts once, but the same person on two sizes
    // still counts toward each size (between-sizes shoppers are real demand for both).
    let url = `${KLAVIYO_BASE}/events/?filter=equals(metric_id,"${metricId}")&fields[event]=event_properties&page[size]=100`;
    const seen = new Set();
    const agg = {};
    let pages = 0;
    while (url && pages < 40) {
      const r = await fetch(url, { headers: klaviyoHeaders() });
      const json = await r.json();
      if (json.errors) throw new Error(json.errors[0]?.detail || 'Klaviyo events error');
      (json.data || []).forEach(ev => {
        const p = ev.attributes?.event_properties || {};
        const product = p.ProductName || 'Unknown';
        const size = p.VariantName || '—';
        const variantId = p.VariantId || size;
        const profileId = ev.relationships?.profile?.data?.id || ev.id;
        const key = profileId + '|' + variantId;
        if (seen.has(key)) return;
        seen.add(key);
        agg[product] = agg[product] || {};
        agg[product][size] = (agg[product][size] || 0) + 1;
      });
      url = json.links?.next || null;
      pages++;
    }

    const products = Object.entries(agg).map(([title, sizes]) => ({
      title,
      total: Object.values(sizes).reduce((a, b) => a + b, 0),
      sizes,
    })).sort((a, b) => b.total - a.total);

    res.json({ success: true, products, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[Waitlist Demand]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── /api/recommendations ──────────────────────────────────────────────────────
const RECS_SYSTEM = `You are a strategic business advisor for Bodycon the Brand — a fuller bust clothing brand with 60k+ Instagram followers, run solo by its founder. Your single mandate is helping her hit $100,000 in revenue this calendar year.

Apply these book principles when relevant — always cite the book title exactly:
• Oversubscribed (Daniel Priestley): create demand that exceeds supply, waitlists, exclusivity
• Launch (Jeff Walker): seed launches, pre-launch sequences, build anticipation before selling
• Converted (Neil Hoyne): use customer data to find the best customers and double down on them
• E-Myth Revisited (Michael Gerber): systematize, build repeatable processes, work ON the business
• Think and Grow Rich (Napoleon Hill): definite chief aim, mastermind, persistence through resistance
• What It Takes (Raegan Moya-Jones): founder story as brand asset, bootstrap growth, resourcefulness

Use web_search to research: current DTC fashion email benchmarks, Meta Ads benchmarks for fashion brands, what acquisition and retention tactics are working for similar brands in 2025. Weave this external context into your recommendations.

RESPOND WITH ONLY A VALID JSON ARRAY — no explanation, no markdown fences. Each object must have exactly these keys:
{
  "action": "one or two sentences — what specifically to do",
  "why": "two to three sentences — how this directly moves the needle on $100k, with numbers from the data",
  "book": "exact book title if a principle applies, otherwise null",
  "bookAuthor": "author surname if citing a book, otherwise null",
  "impact": "high" or "medium" or "low",
  "mathNote": "specific math tied to the goal — e.g. '42 more orders at $58 AOV = $2,436 which closes 60% of your monthly gap' — or null if not applicable",
  "focusArea": "revenue" or "ads" or "email" or "content" or "expenses" or "product"
}`;

function buildRecsPrompt(snap) {
  const n = v => v != null ? v : 'N/A';
  const f = v => v != null ? '$' + parseFloat(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'N/A';
  const p = v => v != null ? parseFloat(v).toFixed(1) + '%' : 'N/A';

  const { goal, revenue, expenses, pnl, emailStats, trendsWeeks, today } = snap;

  const revenueRemaining = goal.annual - (goal.yearRevenue || 0);
  const daysRemaining    = goal.daysRemaining;
  const dailyNeeded      = daysRemaining > 0 ? revenueRemaining / daysRemaining : 0;
  const aov              = revenue.thisMonth?.aov;
  const ordersNeededMonth = aov && revenue.monthPace ? Math.ceil(Math.max(0, -revenue.monthPace.paceGap) / aov) : null;

  let trendSummary = 'No Meta trends data available.';
  if (trendsWeeks?.length) {
    const last = trendsWeeks[trendsWeeks.length - 1];
    const prev = trendsWeeks[trendsWeeks.length - 2];
    trendSummary = `Last week: spend ${f(last.meta.spend)}, CTR ${p(last.meta.ctr)}, ${last.meta.purchases} purchases, pixel revenue ${f(last.meta.pixelRevenue)}`;
    if (prev) trendSummary += `. Week before: spend ${f(prev.meta.spend)}, CTR ${p(prev.meta.ctr)}, ${prev.meta.purchases} purchases.`;
  }

  return `Today: ${today}

$100K GOAL STATUS:
- Annual goal: ${f(goal.annual)}
- Year-to-date revenue: ${f(goal.yearRevenue)}
- Expected by today (on-pace): ${f(goal.expectedByNow)}
- Gap vs pace: ${goal.paceStatus === 'ahead' ? '+' : ''}${f(goal.paceGap)} (${goal.paceStatus})
- Days remaining in year: ${daysRemaining}
- Revenue still needed: ${f(revenueRemaining)}
- Daily revenue needed to hit goal: ${f(dailyNeeded)}

THIS MONTH (${goal.currentMonth || ''}):
- Net revenue: ${f(revenue.thisMonth?.netRevenue)}
- Orders: ${n(revenue.thisMonth?.orderCount)}
- AOV: ${f(aov)}
- Monthly target: ${f(revenue.monthTarget)}
- Monthly pace gap: ${revenue.monthPace ? (revenue.monthPace.paceStatus === 'ahead' ? '+' : '') + f(revenue.monthPace.paceGap) + ' (' + revenue.monthPace.paceStatus + ')' : 'N/A'}
${ordersNeededMonth != null ? `- Orders still needed this month to hit target: ~${ordersNeededMonth} (at ${f(aov)} AOV)` : ''}

LAST MONTH:
- Net revenue: ${f(revenue.lastMonth?.netRevenue)}
- Orders: ${n(revenue.lastMonth?.orderCount)}

META ADS — RECENT TRENDS:
${trendSummary}

EMAIL (Klaviyo — last 30 days):
- Open rate: ${p(emailStats?.openRate)} ${emailStats?.openRate != null ? '(DTC benchmark: ~20–25%)' : ''}
- Click rate: ${p(emailStats?.clickRate)} ${emailStats?.clickRate != null ? '(DTC benchmark: ~2–3%)' : ''}
- Active lists: ${n(emailStats?.listCount)}
- Recent campaigns sent: ${n(emailStats?.campaignCount)}

EXPENSES — THIS MONTH:
- Meta Ads spend: ${f(expenses.ads)}
- Shopify subscription: ${f(expenses.manual?.shopify_subscription)}
- Shopify apps: ${f(expenses.manual?.shopify_apps)}
- Shopify shipping labels: ${f(expenses.manual?.shopify_shipping)}
- Klaviyo (email): ${f(expenses.manual?.klaviyo)}
- Loop returns: ${f(expenses.manual?.loop_returns)}
- Product development: ${f(expenses.manual?.product_dev)}
- UGC & creators: ${f(expenses.manual?.ugc_creators)}
- Apps & tools: ${f(expenses.manual?.apps_tools)}
- Inventory / COGS: ${f(expenses.manual?.inventory_cogs)}
- Other: ${f(expenses.manual?.other)}
- Total expenses: ${f(expenses.total)}

NET PROFIT THIS MONTH: ${f(pnl.netProfit)} | Margin: ${p(pnl.margin)} | Burn rate: ${f(pnl.burnRate)}/day

Return 5 recommendations as a JSON array. Make them specific, numbered-action driven, and directly tied to closing the gap to $100k. Show the math where you can.`;
}

app.get('/api/recommendations', async (req, res) => {
  if (!anthropicReady()) {
    return res.json({ success: false, notConfigured: true, error: 'ANTHROPIC_API_KEY not configured. Add it to .env and restart.' });
  }

  try {
    const now    = new Date();
    const year   = now.getFullYear();
    const month  = now.getMonth();
    const pad    = n => String(n).padStart(2, '0');
    const fmt    = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const today  = fmt(now);

    const monthStart     = `${year}-${pad(month+1)}-01`;
    const yearStart      = `${year}-01-01`;
    const lastMonthStart = fmt(new Date(year, month-1, 1));
    const lastMonthEnd   = fmt(new Date(year, month, 0));

    const dayOfYear    = Math.floor((now - new Date(year, 0, 1)) / 864e5) + 1;
    const daysInYear   = new Date(year, 1, 29).getMonth() === 1 ? 366 : 365;
    const daysInMonth  = new Date(year, month+1, 0).getDate();
    const ANNUAL_GOAL  = 100000;
    const monthlyTarget = ANNUAL_GOAL / 12;
    const expectedByNow = (dayOfYear / daysInYear) * ANNUAL_GOAL;

    const [tmRaw, lmRaw, yrRaw, adsTMRaw, emailRaw, trendsRaw] = await Promise.allSettled([
      shopifyReady() ? fetchShopifyMetrics(monthStart, today)            : Promise.resolve(null),
      shopifyReady() ? fetchShopifyMetrics(lastMonthStart, lastMonthEnd) : Promise.resolve(null),
      shopifyReady() ? fetchShopifyMetrics(yearStart, today)             : Promise.resolve(null),
      metaAccountSpend(monthStart, today),
      klaviyoReady() ? fetchKlaviyoData() : Promise.resolve(null),
      (async () => {
        const metaFields = 'spend,impressions,cpm,ctr,clicks,actions,action_values';
        return metaGetAll(`${META_BASE}/${ACCOUNT}/insights?fields=${metaFields}&time_increment=7&date_preset=last_28d&access_token=${META_TOKEN}`);
      })(),
    ]);

    const ok = r => r.status === 'fulfilled' ? r.value : null;
    const tm      = ok(tmRaw);
    const lm      = ok(lmRaw);
    const yr      = ok(yrRaw);
    const adsTM   = ok(adsTMRaw);
    const email   = ok(emailRaw);
    const trends  = ok(trendsRaw);

    const expenses      = loadExpenses();
    const manualTotal   = MANUAL_EXPENSE_KEYS.reduce((s, k) => s + (parseFloat(expenses[k]) || 0), 0);
    const subs2         = loadSubscriptions();
    const subsTotals2   = getSubsTotals(subs2);
    const totalExpenses = manualTotal + Object.values(subsTotals2).reduce((s,v)=>s+v,0) + (adsTM || 0);
    const monthRevenue  = tm?.netRevenue || 0;
    const yearRevenue   = yr?.netRevenue || 0;
    const netProfit     = monthRevenue - totalExpenses;
    const burnRate      = now.getDate() > 0 ? totalExpenses / now.getDate() : 0;
    const margin        = monthRevenue > 0 ? (netProfit / monthRevenue) * 100 : null;
    const paceGap       = yearRevenue - expectedByNow;
    const monthExpected = (now.getDate() / daysInMonth) * monthlyTarget;
    const monthPaceGap  = monthRevenue - monthExpected;

    // Email stats summary
    const emailStats = email ? {
      openRate:      email.aggregate?.openRate,
      clickRate:     email.aggregate?.clickRate,
      listCount:     email.lists?.length || 0,
      campaignCount: email.campaigns?.length || 0,
    } : null;

    // Trends weeks for prompt
    const trendsWeeks = trends ? trends.map(w => ({
      label: w.date_start,
      meta: {
        spend:     parseFloat(w.spend || 0),
        ctr:       parseFloat(w.ctr || 0),
        purchases: extractAction(w.actions, 'offsite_conversion.fb_pixel_purchase') || 0,
        pixelRevenue: extractAction(w.action_values, 'offsite_conversion.fb_pixel_purchase') || 0,
      },
    })) : null;

    const snap = {
      today,
      goal: {
        annual: ANNUAL_GOAL,
        yearRevenue,
        expectedByNow,
        paceGap,
        paceStatus: paceGap >= 0 ? 'ahead' : 'behind',
        daysRemaining: daysInYear - dayOfYear,
        monthlyTarget,
        currentMonth: now.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      },
      revenue: {
        thisMonth:  tm  ? { ...tm }  : null,
        lastMonth:  lm  ? { ...lm }  : null,
        monthTarget: monthlyTarget,
        monthPace: { paceGap: monthPaceGap, paceStatus: monthPaceGap >= 0 ? 'ahead' : 'behind', daysElapsed: now.getDate() },
      },
      expenses: { ads: adsTM, manual: expenses, total: totalExpenses },
      pnl:      { netProfit, burnRate, margin },
      emailStats,
      trendsWeeks,
    };

    const prompt = buildRecsPrompt(snap);
    const client = getAnthropicClient();

    // Agentic loop — handle pause_turn from server-side web search iterations
    let messages = [{ role: 'user', content: prompt }];
    let finalText = '';
    for (let i = 0; i < 6; i++) {
      const resp = await client.messages.create({
        model:    'claude-opus-4-6',
        max_tokens: 4000,
        thinking:   { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system:   RECS_SYSTEM,
        tools:    [{ type: 'web_search_20260209', name: 'web_search' }],
        messages,
      });
      messages.push({ role: 'assistant', content: resp.content });
      if (resp.stop_reason !== 'pause_turn') {
        finalText = (resp.content.find(b => b.type === 'text') || {}).text || '';
        break;
      }
    }

    // Parse JSON — strip markdown fences if present
    let recommendations = null;
    try {
      let raw = finalText.trim();
      const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) raw = fence[1].trim();
      const start = raw.indexOf('[');
      const end   = raw.lastIndexOf(']');
      if (start !== -1 && end > start) raw = raw.slice(start, end + 1);
      recommendations = JSON.parse(raw);
    } catch (e) {
      console.error('[Recommendations] JSON parse failed:', e.message, '\nRaw:', finalText.slice(0, 300));
      return res.status(500).json({ success: false, error: 'Failed to parse AI response. Try again.' });
    }

    res.json({ success: true, recommendations, generatedAt: new Date().toISOString(), hasLiveData: shopifyReady() });
  } catch (err) {
    console.error('[Recommendations Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Serve dashboard ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'ads-dashboard.html')));

app.listen(PORT, () => {
  console.log('\n  Bodycon the Brand — Ops Dashboard');
  console.log('  ──────────────────────────────────');
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  if (!shopifyCredsOk()) {
    console.log('  ⚠  Shopify credentials not found. Run: bash setup.sh');
  } else if (!shopifyReady()) {
    console.log(`  ⚠  Shopify not connected. Open: http://localhost:${PORT}/shopify/auth`);
  } else {
    console.log('  ✓  Shopify connected.');
  }
  if (!klaviyoReady()) {
    console.log('  ⚠  Klaviyo not configured. Run: bash setup.sh');
  } else {
    console.log('  ✓  Klaviyo configured.');
  }
  console.log('  Press Ctrl+C to stop.\n');
  scheduleTokenHealthCheck();
});
