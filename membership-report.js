// Read-only membership reporting for the /members admin command: who has access and why, and where
// WooCommerce orders and Discord roles disagree. Pure (no Discord/WooCommerce clients) like
// expiry-plan.js, so it can be tested; the bot passes plain objects in.
//
// "Has access" follows what the bot actually enforces: a completed, non-old order whose expiry_date
// is missing, unreadable, or today or later (the daily run removes on the expiry date itself), or a
// used webinar code (lifetime, no WooCommerce order).
import { isOldOrder, normalizeExpiry } from './expiry-plan.js';

const metaOf = (order, key) => (order.meta_data || []).find(m => m.key === key)?.value;
const metaStr = (order, key) => (metaOf(order, key) ? String(metaOf(order, key)) : null);
const DAY_MS = 86400000;
const daysBetween = (fromIso, toIso) => Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);
const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);

// WooCommerce REST *_gmt fields carry no zone suffix.
function gmtDate(value) {
  if (!value) return null;
  const s = String(value);
  const d = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : s + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}
const gmtDay = value => gmtDate(value)?.toISOString().slice(0, 10) ?? null;

// --- Membership duration ---
// Mirrors cta_bot_resolve_duration() in wc-bot-integration/wc_newest.php, which writes expiry_date.
// Keep the two in sync: lifetime by name first, then the price tiers, then "N bulan/tahun" in the name.
const LIFETIME = Object.freeze({ kind: 'lifetime', label: 'lifetime' });
const UNKNOWN = Object.freeze({ kind: 'unknown', label: 'unknown duration' });
const monthsOf = n => ({ kind: 'months', months: n, label: n === 1 ? '1 month' : `${n} months` });
const LIFETIME_WORDS = ['lifetime', 'life time', 'seumur hidup', 'unlimited'];

export function durationFromName(name) {
  const s = String(name || '').toLowerCase();
  // An explicit duration beats a lifetime-ish keyword ("Akses Unlimited 1 Bulan" is 1 month).
  const years = s.match(/\b(\d{1,2})\s*(tahun|years?)\b/);
  if (years) return monthsOf(parseInt(years[1], 10) * 12);
  const months = s.match(/\b(\d{1,2})\s*(bulan|months?)\b/);
  if (months) return monthsOf(parseInt(months[1], 10));
  return LIFETIME_WORDS.some(w => s.includes(w)) ? LIFETIME : null;
}

export function durationFromPrice(price) {
  const p = Math.round(Number(price));
  if (p === 199000) return monthsOf(1);
  if ([399000, 449000, 479000, 499000, 799000].includes(p)) return monthsOf(3);
  if ([999000, 1399000, 1449000, 1499000, 1999000].includes(p)) return monthsOf(12);
  if (p === 1) return { kind: 'days', days: 1, label: '1 day' };
  return null;
}

// Same candidates as cta_bot_price_candidates(): total + discount (the v2.0 formula), then the first
// item's price without fees.
function priceCandidates(order) {
  const n = v => Number(v) || 0;
  const base = n(order.total) + n(order.discount_total);
  const out = [Math.round(base), Math.round(base + n(order.discount_tax))];
  const item = (order.line_items || [])[0];
  if (item) {
    const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
    out.push(Math.round(n(item.subtotal) / qty), Math.round((n(item.subtotal) + n(item.subtotal_tax)) / qty));
  }
  return [...new Set(out)];
}

export const productName = order => String((order.line_items || [])[0]?.name || '');

export function resolveDuration(order) {
  const name = productName(order);
  const byName = name ? durationFromName(name) : null;
  if (byName === LIFETIME) return LIFETIME;
  for (const p of priceCandidates(order)) {
    const d = durationFromPrice(p);
    if (d) return d;
  }
  return byName || UNKNOWN;
}

// What the plugin would have written: paid (else completed, else created) date + duration, in UTC.
function expectedExpiry(order, duration) {
  const base = gmtDate(order.date_paid_gmt || order.date_completed_gmt || order.date_created_gmt || order.date_created);
  if (!base) return null;
  const d = new Date(base.getTime());
  if (duration.kind === 'months') d.setUTCMonth(d.getUTCMonth() + duration.months);
  else if (duration.kind === 'days') d.setUTCDate(d.getUTCDate() + duration.days);
  else return null;
  return d.toISOString().slice(0, 10);
}

// --- Orders, as the bot sees them ---
const PENDING_STATUSES = new Set(['processing', 'on-hold', 'pending']);

export function orderView(order, todayIso) {
  const rawExpiry = metaOf(order, 'expiry_date');
  const expiry = normalizeExpiry(rawExpiry);
  const isOld = isOldOrder(order);
  const open = order.status === 'completed' && !isOld; // the only orders the daily run looks at
  const duration = resolveDuration(order);
  const discordId = metaStr(order, 'discord_id');
  return {
    id: order.id,
    status: order.status,
    isOld,
    open,
    created: gmtDay(order.date_created_gmt || order.date_created),
    product: productName(order),
    duration,
    expiry,
    rawExpiry: rawExpiry ?? null,
    expected: expectedExpiry(order, duration),
    access: open && (expiry === null || expiry === 'INVALID' || expiry >= todayIso),
    daysLeft: expiry && expiry !== 'INVALID' ? daysBetween(todayIso, expiry) : null,
    discordId,
    discordUsername: metaStr(order, 'discord_username'),
    email: String(order.billing?.email || '').trim().toLowerCase(),
    billingName: [order.billing?.first_name, order.billing?.last_name].filter(Boolean).join(' ').trim(),
    hasCode: Boolean(metaOf(order, process.env.WC_UUID_META_KEY || 'activation_uuid')),
    code: metaStr(order, process.env.WC_UUID_META_KEY || 'activation_uuid'), // for duplicate detection only; never printed
    activated: Boolean(discordId || metaOf(order, 'activation_used')),
  };
}

export function indexData({ orders, webinarRows = [], todayIso }) {
  const views = orders.map(o => orderView(o, todayIso));
  const byDiscord = new Map();
  for (const v of views) if (v.discordId) byDiscord.set(v.discordId, [...(byDiscord.get(v.discordId) || []), v]);
  const webinarByDiscord = new Map();
  for (const r of webinarRows) {
    const id = String(r.discord_id || '').trim();
    if (id && String(r.is_used).toLowerCase() === 'true') webinarByDiscord.set(id, r);
  }
  return { views, byDiscord, webinarByDiscord, todayIso };
}

// Best access order first: lifetime, then no end date (never removed), then the latest expiry.
const accessRank = v => (v.duration.kind === 'lifetime' && v.expiry === null ? 3 : v.expiry === null || v.expiry === 'INVALID' ? 2 : 1);
const newestFirst = (a, b) => (b.created || '').localeCompare(a.created || '') || b.id - a.id;

export function membershipFor(discordId, idx) {
  const orders = [...(idx.byDiscord.get(discordId) || [])].sort(newestFirst);
  const webinar = idx.webinarByDiscord.get(discordId) || null;
  const access = orders.filter(v => v.access)
    .sort((a, b) => accessRank(b) - accessRank(a) || String(b.expiry).localeCompare(String(a.expiry)) || b.id - a.id);
  const best = access[0] || null;
  const lifetimeOrder = Boolean(best && accessRank(best) === 3);

  let kind, label;
  if (lifetimeOrder) [kind, label] = ['lifetime', 'lifetime'];
  else if (webinar) [kind, label] = ['lifetime', 'lifetime (webinar)'];
  else if (!best) [kind, label] = ['none', 'none'];
  else if (best.expiry === null) [kind, label] = ['no_expiry', `${best.duration.label}, no expiry_date`];
  else if (best.expiry === 'INVALID') [kind, label] = ['invalid', `${best.duration.label}, unreadable expiry_date`];
  // A lifetime product that carries an expiry_date still loses the role on that date.
  else [kind, label] = ['dated', best.duration.kind === 'lifetime' ? 'lifetime product, but expiry_date set' : best.duration.label];

  const lastDated = orders.find(v => v.expiry && v.expiry !== 'INVALID') || null;
  return {
    active: Boolean(best || webinar),
    lifetime: lifetimeOrder || Boolean(webinar),
    // Bought a lifetime product (even one that wrongly carries an expiry_date), or a webinar code.
    lifetimePurchase: Boolean(webinar) || access.some(v => v.duration.kind === 'lifetime'),
    kind,
    label,
    source: lifetimeOrder ? 'order' : webinar ? 'webinar' : best ? 'order' : 'none',
    accessOrder: best,
    expiry: kind === 'dated' ? best.expiry : null,
    daysLeft: kind === 'dated' ? best.daysLeft : null,
    lastExpiry: lastDated?.expiry ?? null,
    latestOrder: orders[0] || null,
    orders,
    webinar,
  };
}

// --- Manual grants ---
// Admins also give roles by hand (like the webinar codes), and by policy those grants are lifetime. So
// a server member with no WooCommerce order and no webinar code who holds the member or lifetime role
// is a manual member: counted as lifetime, and the audit only checks that they hold both roles.
// Members with a manual-terms role (MANUAL_ROLE_IDS, comma-separated) have terms agreed outside
// WooCommerce: manual whether or not they have orders, and the audit leaves their roles alone. The
// expiry run still treats their orders normally.
export const hasManualTermsRole = (member, { manualRoleIds = [] } = {}) => Boolean(member && manualRoleIds.some(r => member.roles.includes(r)));

export function isManualMember(member, ms, roles) {
  if (hasManualTermsRole(member, roles)) return true;
  if (!member || ms.orders.length || ms.webinar) return false;
  return member.roles.includes(roles.memberRoleId) || Boolean(roles.lifetimeRoleId && member.roles.includes(roles.lifetimeRoleId));
}

// membershipFor() plus the manual-grant rules, for display (list, find).
export function describeMembership(ms, member, roles) {
  if (!isManualMember(member, ms, roles)) return ms;
  if (hasManualTermsRole(member, roles)) {
    return { ...ms, active: true, kind: 'manual', source: 'manual', manualTerms: true, label: ms.active ? `manual terms (order: ${ms.label})` : 'manual terms' };
  }
  const hasLifetimeRole = Boolean(roles.lifetimeRoleId && member.roles.includes(roles.lifetimeRoleId));
  return { ...ms, active: true, lifetime: true, kind: 'manual', source: 'manual', label: hasLifetimeRole ? 'lifetime (manual)' : 'manual, no lifetime role' };
}

// --- Possible orders for a manual member ---
// Leads, not links: an admin confirms by hand. Strongest first:
//   1. an order activated by a Discord account with the same username (renamed or alt account)
//   2. an order never activated whose billing name matches the member's Discord names
//   3. an order never activated whose email name matches the member's Discord names
const handle = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const similar = (a, b) => {
  if (a.length < 5 || b.length < 5) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 6 && short.length / long.length >= 0.6 && long.includes(short);
};

export function possibleOrdersFor(member, idx, max = 3) {
  const names = [...new Set([member.username, member.globalName, member.displayName].map(handle).filter(Boolean))];
  const usernames = new Set([member.username, member.globalName].filter(Boolean).map(n => String(n).toLowerCase()));
  const hints = [];
  for (const v of idx.views) {
    if (v.discordId === member.id) continue;
    let reason = null;
    if (v.discordId) {
      const stored = String(v.discordUsername || '').toLowerCase().split('#')[0];
      if (stored && usernames.has(stored)) reason = `order username "${v.discordUsername}" matches, activated by Discord ID ${v.discordId}`;
    } else {
      const tokens = v.billingName.split(/\s+/).map(handle).filter(t => t.length >= 3);
      const nameHit = tokens.length >= 2 ? names.some(n => tokens.every(t => n.includes(t))) : names.some(n => similar(n, handle(v.billingName)));
      if (nameHit) reason = 'billing name matches';
      else if (names.some(n => similar(n, handle(v.email.split('@')[0])))) reason = 'email name matches';
    }
    if (reason) hints.push({ orderId: v.id, status: v.status, activated: v.activated, reason, rank: v.discordId ? 0 : reason.startsWith('billing') ? 1 : 2 });
  }
  return hints.sort((a, b) => a.rank - b.rank || b.orderId - a.orderId).slice(0, max);
}

export const formatHints = hints => hints.map(h => `#${h.orderId} (${h.status}${h.activated ? '' : ', not activated'}; ${h.reason})`).join('; ');

// --- /members list ---
const joinedDay = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

export function buildMembersReport({ members, orders = null, webinarRows = [], memberRoleId, lifetimeRoleId, manualRoleIds = [], todayIso }) {
  const holders = members.filter(m => !m.bot && memberRoleId && m.roles.includes(memberRoleId));
  const idx = orders ? indexData({ orders, webinarRows, todayIso }) : null;

  const rows = holders.map(m => {
    const row = {
      discordId: m.id, username: m.username, displayName: m.displayName, joined: joinedDay(m.joinedAt),
      lifetimeRole: Boolean(lifetimeRoleId && m.roles.includes(lifetimeRoleId)), staff: Boolean(m.staff),
      manualTermsRole: hasManualTermsRole(m, { manualRoleIds }),
    };
    if (!idx) return row;
    const ms = describeMembership(membershipFor(m.id, idx), m, { memberRoleId, lifetimeRoleId, manualRoleIds });
    return {
      ...row,
      membership: ms.label, kind: ms.kind, source: ms.source,
      accessOrderId: ms.accessOrder?.id ?? null, expiry: ms.expiry, daysLeft: ms.daysLeft,
      latestOrderId: ms.latestOrder?.id ?? null, latestOrderStatus: ms.latestOrder?.status ?? null,
      email: ms.accessOrder?.email || ms.latestOrder?.email || '', orderCount: ms.orders.length,
    };
  }).sort((a, b) => String(a.username).localeCompare(String(b.username)));

  const summary = { total: rows.length, lifetimeRole: rows.filter(r => r.lifetimeRole).length };
  if (idx) {
    const byMembership = {};
    for (const r of rows) {
      const key = r.kind === 'manual' && r.membership.startsWith('manual terms') ? 'manual terms'
        : ['dated', 'lifetime', 'manual'].includes(r.kind) ? r.membership : r.kind;
      byMembership[key] = (byMembership[key] || 0) + 1;
    }
    summary.byMembership = byMembership;
  }
  return { date: todayIso, detailed: Boolean(idx), rows, summary };
}

export function membersToCsv(report) {
  const cols = ['discord_id', 'username', 'display_name', 'joined', 'lifetime_role', 'manual_terms_role', 'staff'];
  const pick = r => [r.discordId, r.username, r.displayName, r.joined, r.lifetimeRole, r.manualTermsRole, r.staff];
  if (!report.detailed) return toCsv(cols, report.rows.map(pick));
  return toCsv(
    [...cols, 'membership', 'source', 'access_order_id', 'expiry', 'days_left', 'latest_order_id', 'latest_order_status', 'email', 'orders'],
    report.rows.map(r => [...pick(r), r.membership, r.source, r.accessOrderId, r.expiry, r.daysLeft, r.latestOrderId, r.latestOrderStatus, r.email, r.orderCount]),
  );
}

// --- /members audit ---
// code -> [severity, label]. 'action': someone has access they shouldn't, or lacks access they paid
// for. 'info': worth knowing, nothing is wrong with the role yet. Listed in display order.
export const AUDIT_CODES = {
  overdue_not_removed: ['action', 'Expired, order still completed (role not removed yet)'],
  role_without_access: ['action', 'Member role, but no active order'],
  manual_without_lifetime_role: ['action', 'Manual member (no order) without the lifetime role'],
  activated_order_not_completed: ['action', 'Activated, but order is not completed (never expires)'],
  no_expiry_not_lifetime: ['action', 'Time-limited product with no expiry_date (never removed)'],
  no_expiry_unknown_duration: ['action', 'No expiry_date and the duration is unknown'],
  lifetime_with_expiry: ['action', 'Lifetime product with an expiry_date (will lose the role)'],
  lifetime_order_finished: ['action', 'Lifetime order marked finished (member may have been removed)'],
  invalid_expiry: ['action', 'Unreadable expiry_date (skipped by the daily run)'],
  active_missing_member_role: ['action', 'Active membership, but no member role'],
  lifetime_missing_lifetime_role: ['action', 'Lifetime purchase, but no lifetime role'],
  lifetime_role_without_lifetime_purchase: ['action', 'Lifetime role, but no lifetime purchase'],
  completed_without_code: ['action', 'Completed order with no activation code'],
  duplicate_code: ['action', 'Activation code shared by several orders'],
  expired_never_activated: ['info', 'Paid, never activated, now expired'],
  not_activated_yet: ['info', 'Paid 3+ days ago, not activated yet'],
  active_member_left_server: ['info', 'Active membership, not in the server'],
  expiry_implausible: ['info', 'expiry_date far from the product duration'],
  finished_without_is_old: ['info', 'Finished, but is_old not set'],
  completed_but_is_old: ['info', 'Completed, but is_old set (the bot ignores it)'],
};
const CODE_ORDER = Object.keys(AUDIT_CODES);
const NOT_ACTIVATED_GRACE_DAYS = 3;

export function auditMemberships({ orders, members = null, webinarRows = [], memberRoleId, lifetimeRoleId, manualRoleIds = [], todayIso }) {
  const roles = { memberRoleId, lifetimeRoleId, manualRoleIds };
  const idx = indexData({ orders, webinarRows, todayIso });
  const findings = [];
  const add = (code, fields, detail) =>
    findings.push({ code, severity: AUDIT_CODES[code][0], orderId: null, discordId: null, username: '', email: '', hint: '', ...fields, detail });
  const fromOrder = v => ({ orderId: v.id, discordId: v.discordId, username: v.discordUsername || '', email: v.email });

  const byCode = new Map();
  for (const v of idx.views) {
    if (v.code) byCode.set(v.code, [...(byCode.get(v.code) || []), v]);
    const lifetime = v.duration.kind === 'lifetime';

    if (v.open) {
      if (v.expiry === 'INVALID') {
        add('invalid_expiry', fromOrder(v), `expiry_date "${v.rawExpiry}" can't be read`);
      } else if (v.expiry === null) {
        if (!lifetime) {
          const code = v.duration.kind === 'unknown' ? 'no_expiry_unknown_duration' : 'no_expiry_not_lifetime';
          add(code, fromOrder(v), `${v.product || 'no product'} (${v.duration.label}${v.expected ? `, expected ${v.expected}` : ''}) — CTA Tools → Expiry Fixer`);
        }
      } else {
        if (lifetime) add('lifetime_with_expiry', fromOrder(v), `${v.product}: expiry_date ${v.expiry}`);
        if (v.expiry < todayIso) {
          add(v.discordId ? 'overdue_not_removed' : 'expired_never_activated', fromOrder(v),
            `expired ${v.expiry} (${-v.daysLeft}d ago)${v.discordId ? '' : `, paid ${v.created || '?'}`}`);
        }
        const ceiling = v.expected ? addDays(v.expected > todayIso ? v.expected : todayIso, 400) : null;
        if ((v.created && v.expiry < v.created) || (ceiling && v.expiry > ceiling)) {
          add('expiry_implausible', fromOrder(v), `expiry_date ${v.expiry}, ${v.duration.label} from ${v.created} would be ${v.expected}`);
        }
      }
      if (!v.hasCode && !v.activated) add('completed_without_code', fromOrder(v), 'the customer has no code to activate');
      if (v.access && !v.activated && v.created && daysBetween(v.created, todayIso) >= NOT_ACTIVATED_GRACE_DAYS) {
        add('not_activated_yet', fromOrder(v), `paid ${v.created} (${daysBetween(v.created, todayIso)}d ago), ${v.duration.label}`);
      }
    } else if (!v.isOld && v.discordId && PENDING_STATUSES.has(v.status)) {
      add('activated_order_not_completed', fromOrder(v), `status ${v.status}: the daily run only checks completed orders`);
    }

    if (v.status === 'finished' && !v.isOld) add('finished_without_is_old', fromOrder(v), 'finished without is_old');
    if (v.status === 'completed' && v.isOld) add('completed_but_is_old', fromOrder(v), 'the bot skips it for expiry and activation');
    if (lifetime && (v.isOld || v.status === 'finished') && !(v.discordId && membershipFor(v.discordId, idx).lifetime)) {
      add('lifetime_order_finished', fromOrder(v), `${v.product}${v.expiry && v.expiry !== 'INVALID' ? `, expiry_date ${v.expiry}` : ''}; no other lifetime access`);
    }
  }
  for (const vs of byCode.values()) {
    if (vs.length < 2) continue;
    for (const v of vs) add('duplicate_code', fromOrder(v), `same code as order ${vs.filter(x => x !== v).map(x => '#' + x.id).join(', ')}`);
  }

  let manualMembers = null;
  if (members) {
    manualMembers = 0;
    const inGuild = new Set(members.map(m => m.id));
    // Already reported per order, with the reason; don't list the same person again as "role without order".
    const explained = new Set(findings.filter(f => ['overdue_not_removed', 'activated_order_not_completed'].includes(f.code)).map(f => f.discordId));
    for (const m of members) {
      if (m.bot) continue;
      const ms = membershipFor(m.id, idx);
      const hasMember = Boolean(memberRoleId) && m.roles.includes(memberRoleId);
      const hasLifetime = Boolean(lifetimeRoleId) && m.roles.includes(lifetimeRoleId);
      const ref = ms.accessOrder || ms.latestOrder;
      const who = { discordId: m.id, username: m.username, orderId: ref?.id ?? null, email: ref?.email || '' };
      const staff = m.staff ? ' — staff (Manage Roles)' : '';

      // Manual grant (see isManualMember): lifetime by policy, so only the pair of roles is checked.
      if (isManualMember(m, ms, roles)) {
        manualMembers++;
        if (hasManualTermsRole(m, roles)) continue; // terms agreed outside WooCommerce: admins check these
        const flagged = (hasMember && !hasLifetime && lifetimeRoleId) || (hasLifetime && !hasMember);
        const hint = flagged ? formatHints(possibleOrdersFor(m, idx)) : '';
        if (hasMember && !hasLifetime && lifetimeRoleId) add('manual_without_lifetime_role', { ...who, hint }, 'no WooCommerce order or webinar code' + staff);
        if (hasLifetime && !hasMember) add('active_missing_member_role', { ...who, hint }, 'manual lifetime member (no order) without the member role');
        continue;
      }

      if (hasMember && !ms.active && !explained.has(m.id)) {
        const last = ms.latestOrder; // not manual and no webinar code, so there is at least one order
        // A renewal bought before the old order ended is often never activated: it has no discord_id,
        // only the same billing email (docs/membership-data.md).
        const emails = new Set(ms.orders.map(v => v.email).filter(Boolean));
        const renewals = idx.views.filter(v => v.access && !v.activated && !v.discordId && emails.has(v.email));
        const hint = renewals.map(v => `#${v.id} (${v.status}, ${v.duration.label}, not activated; same billing email — a renewal to link)`).join('; ');
        add('role_without_access', { ...who, hint },
          `latest order #${last.id} is ${last.status}${last.isOld ? ' (is_old)' : ''}${last.expiry && last.expiry !== 'INVALID' ? `, expiry ${last.expiry}` : ''}` + staff);
      }
      if (ms.active && !hasMember) {
        add('active_missing_member_role', who, ms.lifetime
          ? `lifetime member (${ms.source})${hasLifetime ? ' who still has the lifetime role' : ''}`
          : `${ms.label}${ms.expiry ? ` until ${ms.expiry}` : ''}`);
      }
      if (hasLifetime && !ms.lifetimePurchase) {
        add('lifetime_role_without_lifetime_purchase', who, (ms.active ? `membership is ${ms.label}` : 'no active order') + staff);
      }
      if (lifetimeRoleId && ms.active && ms.lifetimePurchase && !hasLifetime) {
        add('lifetime_missing_lifetime_role', who, ms.source === 'webinar' ? 'webinar code' : `order #${ms.accessOrder?.id}: ${ms.accessOrder?.product}`);
      }
    }
    for (const discordId of idx.byDiscord.keys()) {
      if (inGuild.has(discordId)) continue;
      const ms = membershipFor(discordId, idx);
      const ref = ms.accessOrder;
      if (ms.active) add('active_member_left_server', { discordId, username: ref?.discordUsername || '', orderId: ref?.id ?? null, email: ref?.email || '' }, ms.label);
    }
  }

  findings.sort((a, b) => CODE_ORDER.indexOf(a.code) - CODE_ORDER.indexOf(b.code) || (a.orderId ?? 0) - (b.orderId ?? 0));
  const counts = {};
  for (const f of findings) counts[f.code] = (counts[f.code] || 0) + 1;
  const statusCounts = {};
  for (const v of idx.views) statusCounts[v.status] = (statusCounts[v.status] || 0) + 1;

  return {
    date: todayIso,
    scannedOrders: idx.views.length,
    scannedMembers: members ? members.filter(m => !m.bot).length : null,
    manualMembers,
    manualWithHints: findings.filter(f => f.hint).length,
    findings,
    summary: CODE_ORDER.filter(c => counts[c]).map(code => ({ code, severity: AUDIT_CODES[code][0], label: AUDIT_CODES[code][1], count: counts[code] })),
    statusCounts,
  };
}

export function auditToCsv(audit) {
  return toCsv(
    ['severity', 'code', 'issue', 'order_id', 'discord_id', 'username', 'email', 'detail', 'possible_order'],
    audit.findings.map(f => [f.severity, f.code, AUDIT_CODES[f.code][1], f.orderId, f.discordId, f.username, f.email, f.detail, f.hint]),
  );
}

// --- /members find ---
export function parseFindQuery(query) {
  const s = String(query || '').trim();
  let m;
  if ((m = s.match(/^<@!?(\d{17,20})>$/)) || (m = s.match(/^(\d{17,20})$/))) return { type: 'discord_id', value: m[1] };
  if ((m = s.match(/^#?(\d{1,9})$/))) return { type: 'order_id', value: parseInt(m[1], 10) };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { type: 'email', value: s.toLowerCase() };
  return { type: 'name', value: s.replace(/^@/, '').toLowerCase() };
}

const MAX_SUBJECTS = 3;

export function findMembership(target, { orders, members = [], webinarRows = [], memberRoleId, lifetimeRoleId, manualRoleIds = [], todayIso }) {
  const idx = indexData({ orders, webinarRows, todayIso });
  const memberById = new Map(members.map(m => [m.id, m]));
  const shown = id => describeMembership(membershipFor(id, idx), memberById.get(id), { memberRoleId, lifetimeRoleId, manualRoleIds });
  let discordIds = [];
  let unlinked = [];

  if (target.type === 'discord_id') {
    discordIds = [target.value];
  } else if (target.type === 'order_id') {
    const v = idx.views.find(x => Number(x.id) === target.value);
    if (v?.discordId) discordIds = [v.discordId];
    else if (v) unlinked = [v];
  } else if (target.type === 'email') {
    const vs = idx.views.filter(x => x.email === target.value).sort(newestFirst);
    discordIds = [...new Set(vs.map(x => x.discordId).filter(Boolean))];
    unlinked = vs.filter(x => !x.discordId);
  } else {
    // Name: current Discord names first, then the username stored on the order at activation (covers
    // people who left or renamed), then webinar activations. A single exact match wins.
    const q = target.value;
    const hits = new Map(); // discordId -> exact?
    const consider = (id, names) => {
      const ls = names.filter(Boolean).map(n => String(n).toLowerCase());
      if (!id || !ls.some(n => n.includes(q))) return;
      const exact = ls.some(n => n === q || n.split('#')[0] === q);
      hits.set(id, hits.get(id) || exact);
    };
    for (const m of members) if (!m.bot) consider(m.id, [m.username, m.globalName, m.displayName]);
    for (const v of idx.views) consider(v.discordId, [v.discordUsername]);
    for (const [id, r] of idx.webinarByDiscord) consider(id, [r.discord_username]);
    const exact = [...hits].filter(([, e]) => e).map(([id]) => id);
    discordIds = exact.length === 1 ? exact : [...hits.keys()];
    if (discordIds.length > 1) {
      return { target, subjects: [], unlinked: [], candidates: discordIds.map(id => candidate(id, memberById.get(id), shown(id), memberRoleId)) };
    }
  }

  const candidates = discordIds.slice(MAX_SUBJECTS).map(id => candidate(id, memberById.get(id), shown(id), memberRoleId));
  const audit = auditMemberships({ orders, members, webinarRows, memberRoleId, lifetimeRoleId, manualRoleIds, todayIso });
  const subjects = discordIds.slice(0, MAX_SUBJECTS).map(id => {
    const membership = shown(id);
    const orderIds = new Set(membership.orders.map(v => v.id));
    return {
      discordId: id,
      member: memberById.get(id) || null,
      membership,
      findings: audit.findings.filter(f => f.discordId === id || orderIds.has(f.orderId)),
    };
  });
  const unlinkedIds = new Set(unlinked.map(v => v.id));
  return { target, subjects, unlinked, unlinkedFindings: audit.findings.filter(f => unlinkedIds.has(f.orderId)), candidates };
}

function candidate(id, member, ms, memberRoleId) {
  return {
    discordId: id,
    name: member ? member.username : ms.orders.find(v => v.discordUsername)?.discordUsername || ms.webinar?.discord_username || '?',
    inServer: Boolean(member),
    memberRole: Boolean(member && memberRoleId && member.roles.includes(memberRoleId)),
    membership: ms.label,
  };
}

// Discord markdown in user-controlled text (usernames, nicknames, product names).
export const md = s => String(s ?? '').replace(/[\\*_~`|>[\]]/g, c => '\\' + c);

function orderLine(v) {
  const bits = [`#${v.id} ${v.status}${v.isOld ? ' (is_old)' : ''}`, v.created || '?', `${md(v.product || 'no product')} (${v.duration.label})`];
  if (v.expiry === 'INVALID') bits.push(`expiry "${md(v.rawExpiry)}" (unreadable)`);
  else if (v.expiry) bits.push(`expiry ${v.expiry}`);
  else bits.push('no expiry_date');
  bits.push(v.activated ? 'activated' : 'not activated');
  return '• ' + bits.join(' · ');
}

function membershipLine(ms) {
  if (!ms.active) {
    const last = ms.latestOrder;
    return `Membership: ❌ **none**${last ? ` — latest order #${last.id} ${last.status}${ms.lastExpiry ? `, last expiry ${ms.lastExpiry}` : ''}` : ' — no orders linked'}`;
  }
  if (ms.manualTerms) return `Membership: ✅ **${md(ms.label)}** — manual-terms role (agreed outside WooCommerce)`;
  if (ms.kind === 'manual') {
    return `Membership: ${ms.label.startsWith('lifetime') ? '✅' : '⚠️'} **${ms.label}** — no WooCommerce order or webinar code (granted by hand)`;
  }
  const via = ms.source === 'webinar' ? 'webinar code' : `order #${ms.accessOrder.id}`;
  if (ms.kind === 'dated') {
    const left = ms.daysLeft === 0 ? 'ends today' : `${ms.daysLeft} day(s) left`;
    return `Membership: ✅ **${ms.label}** — until ${ms.expiry} (${left}), ${via}`;
  }
  return `Membership: ${ms.kind === 'lifetime' ? '✅' : '⚠️'} **${md(ms.label)}** — ${via}`;
}

export function formatFindResult(result, { memberRoleId, lifetimeRoleId, maxOrders = 6 } = {}) {
  const t = result.target;
  const lines = [`**Lookup:** ${md(t.type === 'order_id' ? '#' + t.value : t.value)} (${t.type.replace('_', ' ')})`];

  if (result.candidates.length && !result.subjects.length) {
    lines.push(`${result.candidates.length} matches — run again with the Discord ID:`);
    for (const c of result.candidates.slice(0, 15)) {
      lines.push(`• ${md(c.name)} · \`${c.discordId}\` · ${c.inServer ? (c.memberRole ? 'member role' : 'in server, no member role') : 'not in server'} · ${md(c.membership)}`);
    }
    if (result.candidates.length > 15) lines.push(`… and ${result.candidates.length - 15} more; narrow the search.`);
    return clip(lines);
  }
  if (!result.subjects.length && !result.unlinked.length) {
    lines.push('No Discord member, order or webinar activation matches.');
    return clip(lines);
  }

  for (const s of result.subjects) {
    const m = s.member;
    const ms = s.membership;
    const name = m ? `**${md(m.username)}**${m.displayName && m.displayName !== m.username ? ` (${md(m.displayName)})` : ''}` : `**${md(candidate(s.discordId, null, ms, memberRoleId).name)}**`;
    lines.push('', `${name} · \`${s.discordId}\``);
    lines.push(m
      ? `In server since ${joinedDay(m.joinedAt) || '?'} · member role: ${memberRoleId && m.roles.includes(memberRoleId) ? 'yes' : 'no'} · lifetime role: ${lifetimeRoleId && m.roles.includes(lifetimeRoleId) ? 'yes' : 'no'}${m.staff ? ' · staff' : ''}`
      : 'Not in the server');
    lines.push(membershipLine(ms));
    const emails = [...new Set(ms.orders.map(v => v.email).filter(Boolean))];
    if (emails.length) lines.push(`Email: ${emails.slice(0, 3).map(md).join(', ')}`);
    if (ms.webinar) lines.push('Webinar: code used (lifetime)');
    if (ms.orders.length) {
      lines.push(`Orders (${ms.orders.length}):`);
      for (const v of ms.orders.slice(0, maxOrders)) lines.push(orderLine(v));
      if (ms.orders.length > maxOrders) lines.push(`… ${ms.orders.length - maxOrders} older`);
    }
    for (const f of s.findings) lines.push(`⚠️ ${AUDIT_CODES[f.code][1]} — ${md(f.detail)}${f.hint ? `\n   Possible order: ${md(f.hint)}` : ''}`);
    if (!s.findings.length) lines.push('No issues found.');
  }

  if (result.unlinked.length) {
    lines.push('', `Orders not linked to any Discord account (${result.unlinked.length}):`);
    for (const v of result.unlinked.slice(0, maxOrders)) lines.push(orderLine(v) + (v.email ? ` · ${md(v.email)}` : ''));
    for (const f of result.unlinkedFindings) lines.push(`⚠️ #${f.orderId}: ${AUDIT_CODES[f.code][1]} — ${md(f.detail)}`);
  }
  if (result.candidates.length) lines.push('', `${result.candidates.length} more Discord account(s) match: ${result.candidates.map(c => '`' + c.discordId + '`').join(', ')}`);
  return clip(lines);
}

function clip(lines, max = 1900) {
  const s = lines.join('\n');
  return s.length > max ? s.slice(0, max - 2) + '\n…' : s;
}

// --- CSV ---
// Cells starting with = + - @ are prefixed with ' so a spreadsheet doesn't run them as formulas
// (usernames and nicknames are user-controlled).
export function toCsv(cols, rows) {
  const esc = v => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols, ...rows].map(row => row.map(esc).join(',')).join('\n') + '\n';
}
