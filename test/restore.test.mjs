// Tests for scripts/restore-lifetime-orders.mjs: which orders it restores, and that a restored order
// is lifetime access to the bot (never picked up by the expiry run again).
import { fileURLToPath } from 'url';

const BOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const { restoreDecision, restoredCorrectly, RESTORE_PAYLOAD } = await import(BOT + '/scripts/restore-lifetime-orders.mjs');
const { planExpiryRun, localTodayIso } = await import(BOT + '/expiry-plan.js');
const { orderView } = await import(BOT + '/membership-report.js');

let fail = 0;
const check = (label, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fail++; };
const TODAY = localTodayIso();

const o = ({ id = 1, status = 'finished', product = 'Crypto Teknikal Academy - Lifetime', total = '1499000', expiry = '2026-05-28', old = 'True', discord = 'D1' } = {}) => ({
  id, status, total, discount_total: '0', billing: { email: 'x@x.com' }, date_created_gmt: '2025-12-01T00:00:00',
  line_items: [{ name: product, quantity: 1, subtotal: total }],
  meta_data: [
    { key: 'activation_uuid', value: 'c1' },
    ...(discord ? [{ key: 'discord_id', value: discord }] : []),
    ...(expiry !== null ? [{ key: 'expiry_date', value: expiry }] : []),
    ...(old !== null ? [{ key: 'is_old', value: old }] : []),
  ],
});
// What WooCommerce holds after RESTORE_PAYLOAD (meta values replaced by key)
const applyPayload = order => ({
  ...order,
  status: RESTORE_PAYLOAD.status,
  meta_data: [
    ...order.meta_data.filter(m => !RESTORE_PAYLOAD.meta_data.some(p => p.key === m.key)),
    ...RESTORE_PAYLOAD.meta_data,
  ],
});

check('lifetime order, finished + is_old with an expiry -> restore', restoreDecision(o()).ok);
check('lifetime by name wins over a 12-month price (same rule as the plugin)', restoreDecision(o({ total: '1499000' })).ok);
check('never-activated lifetime order -> restore', restoreDecision(o({ discord: null })).ok);
check('3-month product -> refused', !restoreDecision(o({ product: 'CTA 3 Bulan', total: '499000' })).ok);
check('lifetime but still completed, not is_old -> refused (nothing to restore)', !restoreDecision(o({ status: 'completed', old: null })).ok);
check('refunded -> refused', !restoreDecision(o({ status: 'refunded' })).ok);

check('one update sets status, expiry_date and is_old together', RESTORE_PAYLOAD.status === 'completed' &&
  RESTORE_PAYLOAD.meta_data.some(m => m.key === 'expiry_date' && m.value === '') && RESTORE_PAYLOAD.meta_data.some(m => m.key === 'is_old' && m.value === 'False'));

const restored = applyPayload(o());
check('after the update: completed, not old, no expiry', restoredCorrectly(restored));
check('verification catches a leftover expiry_date', !restoredCorrectly({ ...restored, meta_data: [...restored.meta_data.filter(m => m.key !== 'expiry_date'), { key: 'expiry_date', value: '2026-05-28' }] }));
check('verification catches is_old still True', !restoredCorrectly({ ...restored, meta_data: [...restored.meta_data.filter(m => m.key !== 'is_old'), { key: 'is_old', value: 'True' }] }));
check('restored order is lifetime access to the bot', orderView(restored, TODAY).access && orderView(restored, TODAY).expiry === null);
check('restored order is never due in the expiry run', planExpiryRun([restored], TODAY).results.length === 0);
const halfDone = { ...o(), status: 'completed', meta_data: o().meta_data.filter(m => m.key !== 'is_old') };
check('(why one update) completed + no is_old but old expiry still set -> the next run removes the member', planExpiryRun([halfDone], TODAY).results[0]?.action === 'remove');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
