// Pure planning + execution for the daily auto-role-remover.
// Kept free of Discord/WooCommerce clients so it can be dry-run and tested.

const metaOf = (order, key) => (order.meta_data || []).find(m => m.key === key)?.value;

export function isOldOrder(order) {
  const v = metaOf(order, 'is_old');
  return v === true || ['true', '1'].includes(String(v ?? '').toLowerCase());
}

// 'YYYY-MM-DD' | null (no expiry) | 'INVALID' (unparseable — never let one bad value crash the run)
export function normalizeExpiry(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? 'INVALID' : d.toISOString().slice(0, 10);
}

// Today's date (YYYY-MM-DD) in the community's timezone (fixed offset, default UTC+7).
export function localTodayIso(offsetHours = parseInt(process.env.TZ_OFFSET_HOURS || '7', 10), now = Date.now()) {
  return new Date(now + offsetHours * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Membership ends ON its expiry date (that's the day the remover acts), so a code whose expiry is
// today or earlier must not grant the role. No expiry (lifetime / not set) or unparseable -> allowed.
export function isExpiredForActivation(expiryValue, todayIso) {
  const exp = normalizeExpiry(expiryValue);
  return exp !== null && exp !== 'INVALID' && exp <= todayIso;
}

const daysBetween = (fromIso, toIso) => Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000);

/**
 * Decide what the expiry job should do on `targetIso` (YYYY-MM-DD, local date).
 *
 * Picks up every completed, non-old order whose expiry_date is ON OR BEFORE the target date, so a
 * day the bot missed (downtime, crash, API outage) is caught up on the next run instead of being
 * skipped forever. Orders are marked `finished` + is_old once handled, so they drop out.
 *
 * "Still active" = another completed, non-old order with no expiry (lifetime / not set) or an
 * expiry AFTER the target date.
 */
export function planExpiryRun(orders, targetIso) {
  const live = orders.filter(o => o.status === 'completed' && !isOldOrder(o));

  const stillActive = o => {
    const exp = normalizeExpiry(metaOf(o, 'expiry_date'));
    return exp === null || exp === 'INVALID' || exp > targetIso; // unknown -> don't remove on its account
  };
  const createdAt = o => new Date(o.date_created_gmt || o.date_created || 0).getTime();
  const emailOf = o => String(o.billing?.email || '').trim().toLowerCase();

  const invalid = [];
  const due = [];
  for (const o of live) {
    const raw = metaOf(o, 'expiry_date');
    const exp = normalizeExpiry(raw);
    if (exp === 'INVALID') invalid.push({ orderId: o.id, value: raw });
    else if (exp !== null && exp <= targetIso) due.push({ o, exp });
  }

  const results = due.map(({ o, exp }) => {
    const discordId = metaOf(o, 'discord_id') ? String(metaOf(o, 'discord_id')) : null;
    const email = emailOf(o);
    const daysOverdue = daysBetween(exp, targetIso);
    const base = { orderId: o.id, discordId, email, expiry: exp, overdue: daysOverdue > 0, daysOverdue };

    // Never activated: no role to remove. Left untouched (admin can still extend it); activation
    // itself now refuses expired codes.
    if (!discordId) return { ...base, action: 'no_discord_id' };

    const active = live.find(x => x.id !== o.id && String(metaOf(x, 'discord_id') ?? '') === discordId && stillActive(x));
    if (active) return { ...base, action: 'keep_active_order', activeOrderId: active.id };

    // Paid again with the same email but never activated the new code: removal still happens
    // (they can re-activate with the new code), but admins should know.
    const unactivated = email ? live.find(x =>
      x.id !== o.id && !metaOf(x, 'discord_id') && !metaOf(x, 'activation_used') &&
      emailOf(x) === email && stillActive(x) && createdAt(x) > createdAt(o)
    ) : null;

    return { ...base, action: 'remove', unactivatedRenewalOrderId: unactivated ? unactivated.id : null };
  });

  return {
    date: targetIso,
    scanned: live.length,
    summary: summarizeResults(results, invalid.length),
    results,
    invalid,
  };
}

export function summarizeResults(results, invalidCount = 0) {
  const count = (a, pred = () => true) => results.filter(r => r.action === a && pred(r)).length;
  return {
    remove: count('remove'),
    remove_overdue: count('remove', r => r.overdue),
    keep_active_order: count('keep_active_order'),
    no_discord_id_today: count('no_discord_id', r => !r.overdue),
    no_discord_id_overdue: count('no_discord_id', r => r.overdue),
    invalid_expiry: invalidCount,
    flagged_unactivated_renewal: results.filter(r => r.unactivatedRenewalOrderId).length,
  };
}

// Keep only the orders a human previewed. A fresh plan is still computed at execution time, so an
// order that changed since the preview (renewed, refunded, ...) gets its *current* action.
export function restrictPlan(plan, orderIds) {
  const allowed = new Set([...orderIds].map(String));
  const results = plan.results.filter(r => allowed.has(String(r.orderId)));
  return { ...plan, results, invalid: [], summary: summarizeResults(results, 0) };
}

export function planToCsv(plan) {
  const cols = ['order_id', 'action', 'discord_id', 'email', 'expiry', 'days_overdue', 'active_order_id', 'unactivated_renewal_order_id'];
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = plan.results.map(r => [r.orderId, r.action, r.discordId, r.email, r.expiry, r.daysOverdue, r.activeOrderId, r.unactivatedRenewalOrderId]);
  for (const inv of plan.invalid || []) rows.push([inv.orderId, 'invalid_expiry', '', '', inv.value, '', '', '']);
  return [cols, ...rows].map(row => row.map(esc).join(',')).join('\n') + '\n';
}

/**
 * Apply a plan. deps: { removeMember(discordId) -> {success, error, notInGuild?},
 * markOrderFinished(orderId), log(level, msg, data), critical(title, data), notifyRenewal(result) }
 * Anything that fails is left as completed/non-old, so the next daily run retries it.
 */
export async function executeExpiryPlan(plan, deps) {
  const outcomes = [];
  for (const r of plan.results) {
    try {
      if (r.action === 'no_discord_id') {
        if (!r.overdue) deps.log('WARN', 'Order expiring but no discord_id meta', { orderId: r.orderId });
        outcomes.push({ ...r, outcome: 'skipped' });
        continue;
      }

      if (r.action === 'keep_active_order') {
        await deps.markOrderFinished(r.orderId).catch(err =>
          deps.log('ERROR', 'Failed to mark old order finished (newer active exists)', { orderId: r.orderId, discordId: r.discordId, activeOrderId: r.activeOrderId, error: err.message }));
        deps.log('INFO', 'Skipped role removal — other active order exists', { discordId: r.discordId, expiredOrderId: r.orderId, activeOrderId: r.activeOrderId });
        await deps.notifyRenewal(r);
        outcomes.push({ ...r, outcome: 'kept' });
        continue;
      }

      const res = await deps.removeMember(r.discordId);
      if (!res.success) {
        deps.log('ERROR', 'Failed to remove membership role (expiry)', { discordId: r.discordId, orderId: r.orderId, error: res.error });
        await deps.critical('Auto-Removal Failed', { discordId: r.discordId, orderId: r.orderId, expiry: r.expiry, daysOverdue: r.daysOverdue, reason: res.error });
        outcomes.push({ ...r, outcome: 'failed', error: res.error });
        continue;
      }

      await deps.markOrderFinished(r.orderId).catch(async err => {
        deps.log('ERROR', 'Failed to mark order finished after role removal', { orderId: r.orderId, discordId: r.discordId, error: err.message });
        await deps.critical('Mark Order Finished Failed', { orderId: r.orderId, discordId: r.discordId, error: err.message });
      });
      if (r.unactivatedRenewalOrderId) {
        deps.log('WARN', 'Removed role but member has an unactivated newer order', { discordId: r.discordId, orderId: r.orderId, renewalOrderId: r.unactivatedRenewalOrderId });
      }
      const outcome = res.notInGuild ? 'not_in_guild' : 'removed';
      deps.log('INFO', outcome === 'removed' ? 'Auto-removed membership role and marked order finished' : 'Member no longer in server; marked order finished', { discordId: r.discordId, orderId: r.orderId, expiry: r.expiry, daysOverdue: r.daysOverdue });
      outcomes.push({ ...r, outcome });
    } catch (e) {
      deps.log('ERROR', 'Error handling expiring order', { orderId: r.orderId, error: e.message });
      await deps.critical('Expiry Check Error', { orderId: r.orderId, error: e.message });
      outcomes.push({ ...r, outcome: 'failed', error: e.message });
    }
  }
  return outcomes;
}
