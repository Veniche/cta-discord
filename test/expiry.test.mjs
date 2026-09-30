import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
const BOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const plan = await import(BOT + '/expiry-plan.js');
const { planExpiryRun, executeExpiryPlan, normalizeExpiry, localTodayIso, isExpiredForActivation, markAlreadyWithoutRole } = plan;

let fail = 0;
const check = (label, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fail++; };
const TODAY = localTodayIso();
const shift = d => new Date(Date.parse(TODAY) + d * 86400000).toISOString().slice(0, 10);
let seq = 0;
const ord = ({ id, discord, expiry, email = `u${id}@x.com`, created, status = 'completed', old, handled }) => ({
  id, status, billing: { email }, date_created_gmt: created || `2026-0${1 + (seq++ % 8)}-01T00:00:00`,
  meta_data: [
    ...(discord ? [{ key: 'discord_id', value: discord }] : []),
    ...(expiry !== undefined ? [{ key: 'expiry_date', value: expiry }] : []),
    ...(old ? [{ key: 'is_old', value: 'True' }] : []),
    ...(handled ? [{ key: 'discord_role_removed_at', value: '2026-09-30T05:30:00Z' }] : []),
  ],
});
const byId = (p, id) => p.results.find(r => r.orderId === id);

// ---- planning: overdue catch-up ----
let orders = [
  ord({ id: 1, discord: 'U1', expiry: TODAY }),
  ord({ id: 2, discord: 'U2', expiry: shift(-3) }),          // missed run 3 days ago
  ord({ id: 3, discord: 'U3', expiry: shift(1) }),           // tomorrow: not yet
  ord({ id: 4, expiry: shift(-40) }),                        // never activated, long overdue
  ord({ id: 5, discord: 'U5', expiry: shift(-10), old: true }), // already handled
  ord({ id: 6, discord: 'U6' }),                             // lifetime
];
let p = planExpiryRun(orders, TODAY);
check('A expiring today -> remove, not overdue', byId(p, 1)?.action === 'remove' && !byId(p, 1).overdue);
check('A 3 days overdue -> remove, daysOverdue=3', byId(p, 2)?.action === 'remove' && byId(p, 2).daysOverdue === 3);
check('A tomorrow not included', !byId(p, 3));
check('A overdue never-activated -> no_discord_id (overdue)', byId(p, 4)?.action === 'no_discord_id' && byId(p, 4).overdue);
check('A is_old excluded, lifetime excluded', !byId(p, 5) && !byId(p, 6));
check('A summary counts', p.summary.remove === 2 && p.summary.remove_overdue === 1 && p.summary.no_discord_id_overdue === 1);

// renewal still protects an overdue old order
orders = [ord({ id: 10, discord: 'R', expiry: shift(-5), created: '2026-06-01T00:00:00' }), ord({ id: 11, discord: 'R', expiry: shift(60), created: '2026-09-01T00:00:00' })];
p = planExpiryRun(orders, TODAY);
check('B overdue order with active renewal -> keep', byId(p, 10)?.action === 'keep_active_order' && byId(p, 10).activeOrderId === 11);

// ---- orders the Telegram checker already closed (finished + is_old) while the Discord role is on ----
const closed = o => ord({ status: 'finished', old: true, ...o });
orders = [
  closed({ id: 30, discord: 'T1', expiry: TODAY }),                 // closed today by expirychecker.py
  closed({ id: 31, discord: 'T2', expiry: shift(-3) }),             // within the 7-day window
  closed({ id: 32, discord: 'T3', expiry: shift(-8) }),             // outside it
  closed({ id: 33, discord: 'T4', expiry: TODAY, handled: true }),  // Discord side already done
  closed({ id: 34, expiry: TODAY }),                                // never activated
  closed({ id: 35, discord: 'T5', expiry: shift(1) }),              // not due yet
  closed({ id: 36, discord: 'T6', expiry: shift(-1) }), ord({ id: 37, discord: 'T6', expiry: shift(90) }), // renewed
];
p = planExpiryRun(orders, TODAY);
check('H closed today / 3 days ago -> remove, flagged closedElsewhere', byId(p, 30)?.action === 'remove' && byId(p, 30).closedElsewhere && byId(p, 31)?.action === 'remove');
check('H outside window, already handled, never activated, not due -> excluded', ![32, 33, 34, 35].some(id => byId(p, id)));
check('H closed order with an active renewal -> keep', byId(p, 36)?.action === 'keep_active_order' && byId(p, 36).activeOrderId === 37);
check('H summary counts closed-elsewhere removals', p.summary.remove === 2 && p.summary.closed_elsewhere === 2);
check('H recheckDays widens the window', Boolean(byId(planExpiryRun(orders, TODAY, { recheckDays: 10 }), 32)));
p = markAlreadyWithoutRole(p, id => id === 'T1');
check('H member without the role -> already_without_role (not a removal)', byId(p, 31).action === 'already_without_role' && byId(p, 30).action === 'remove' &&
  p.summary.remove === 1 && p.summary.already_without_role === 1);
const done = [];
const outs = await executeExpiryPlan({ ...p, results: [byId(p, 31)] }, { removeMember: async () => { throw new Error('must not remove'); }, markOrderFinished: async id => done.push(id), log: () => {}, critical: async () => {}, notifyRenewal: async () => {} });
check('H already_without_role: only marked done, no removal', done.join() === '31' && outs[0].outcome === 'already_without_role');

// ---- activation expiry rule ----
check('C expiry yesterday -> refused', isExpiredForActivation(shift(-1), TODAY));
check('C expiry today -> refused (remover acts on the expiry date)', isExpiredForActivation(TODAY, TODAY));
check('C expiry tomorrow -> allowed', !isExpiredForActivation(shift(1), TODAY));
check('C no expiry / lifetime -> allowed', !isExpiredForActivation(undefined, TODAY) && !isExpiredForActivation('', TODAY));
check('C unparseable -> allowed (not blocked on bad data)', !isExpiredForActivation('30/09/2026x', TODAY));
check('C localTodayIso uses +7 (23:30 UTC -> next day)', localTodayIso(7, Date.parse('2026-09-29T23:30:00Z')) === '2026-09-30');

// ---- glue from index.js, run in a sandbox with mocks ----
const src = fs.readFileSync(BOT + '/index.js', 'utf8');
const cut = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const expiryGlue = cut('// --- AUTO-KICK JOB (runs daily) ---', '// Schedule daily run');
const activationGlue = cut('async function activateOrderForDiscordUser', '// Post a persistent activation message');
check('D cron at 05:30 UTC, after expirychecker.py, wraps runExpiryCheck', /cron\.schedule\("30 5 \* \* \*", \(\) => runExpiryCheck\(/.test(src));

class Embed { setColor() { return this } setTitle() { return this } addFields() { return this } setTimestamp() { return this } setFooter() { return this } setDescription() { return this } }
function sandbox({ wcOrders = [], leftGuild = [], channelOk = true, findResult = null, env = {}, roleHolders = [], finishedFails = false } = {}) {
  const st = { sent: [], removed: [], finished: [], critical: [], rolesAdded: [], wcUpdates: [], fetches: [] };
  const guild = {
    members: { fetch: async id => {
      if (id === undefined) return new Map(roleHolders.map(h => [h, { user: { id: h }, roles: { cache: { has: r => r === 'MEMBER' } } }]));
      if (leftGuild.includes(id)) { const e = new Error('Unknown Member'); e.code = 10007; throw e; }
      return { user: { id, tag: id }, roles: { add: async r => st.rolesAdded.push(r), cache: { has: () => true } } };
    } },
  };
  const ctx = {
    process: { env: { TZ_OFFSET_HOURS: '7', GUILD_ID: 'g', MEMBER_ROLE_ID: 'MEMBER', ...env } }, Date, JSON, Promise, console, Number, parseInt, String, Error,
    ADMIN_LOG_CHANNEL_ID: 'admin', ACTIVATION_LOG_CHANNEL_ID: undefined, WEBINAR_LOCK_PATH: 'x',
    ...plan,
    woocommerce: {
      getAllOrders: async (status, params) => {
        st.fetches.push([status, params]);
        if (status === 'finished' && finishedFails) throw new Error('boom');
        return wcOrders;
      },
      markOrderFinished: async id => st.finished.push(id),
      findOrderByUUID: async () => findResult,
      updateOrderMemberData: async (id, m) => st.wcUpdates.push(id),
    },
    client: { user: {}, guilds: { fetch: async () => guild }, channels: { fetch: async () => channelOk ? { isTextBased: () => true, send: async m => st.sent.push(m) } : null } },
    removeMember: async (g, id) => (st.removed.push(id), { success: true }),
    appendBotLog: () => {}, logCritical: async t => st.critical.push(t), EmbedBuilder: Embed,
    acquireLock: async () => {}, releaseLock: () => {}, readWebinarCsv: () => [], writeWebinarCsv: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(expiryGlue + activationGlue + '\n;this.runExpiryCheck = runExpiryCheck; this.activate = activateOrderForDiscordUser;', ctx);
  return { ctx, st };
}

// E. live run removes overdue; member who left is marked finished without an alert
let sb = sandbox({ wcOrders: [ord({ id: 20, discord: 'A', expiry: shift(-2) }), ord({ id: 21, discord: 'GONE', expiry: shift(-7) }), ord({ id: 22, expiry: shift(-30) })], leftGuild: ['GONE'] });
let r = await sb.ctx.runExpiryCheck();
check('E overdue member removed + finished', sb.st.removed.includes('A') && sb.st.finished.includes(20));
check('E left-server member: finished, no removal call, no critical', sb.st.finished.includes(21) && !sb.st.removed.includes('GONE') && sb.st.critical.length === 0);
check('E never-activated overdue: untouched, hidden from list', !sb.st.finished.includes(22) && sb.st.sent.join('').includes('1 overdue orders were never activated'));
check('E run reports success', r.success === true);

// F. safety cap
const many = Array.from({ length: 101 }, (_, i) => ord({ id: 100 + i, discord: 'M' + i, expiry: shift(-1) }));
sb = sandbox({ wcOrders: many });
r = await sb.ctx.runExpiryCheck();
check('F 101 removals > cap 100 -> halted, nobody removed, critical raised', r.halted && sb.st.removed.length === 0 && sb.st.finished.length === 0 && sb.st.critical.some(t => t.includes('Halted')));
r = await sb.ctx.runExpiryCheck({ dryRun: true });
check('F dryRun reports wouldHalt without side effects', r.wouldHalt === true && sb.st.removed.length === 0);
r = await sb.ctx.runExpiryCheck({ maxRemovals: 200 });
check('F manual run with maxRemovals=200 proceeds', r.success && sb.st.removed.length === 101);
sb = sandbox({ wcOrders: many, env: {} });
r = await sb.ctx.runExpiryCheck({ maxRemovals: NaN });
check('F invalid maxRemovals falls back to default cap', r.halted === true);

// I. daily run: orders closed by the Telegram checker
sb = sandbox({ wcOrders: [closed({ id: 40, discord: 'H1', expiry: TODAY }), closed({ id: 41, discord: 'H2', expiry: TODAY })], roleHolders: ['H1'] });
r = await sb.ctx.runExpiryCheck({ dryRun: true });
check('I dry run: 1 removal (role still on), 1 already without role, nothing changed', r.summary.remove === 1 && r.summary.already_without_role === 1 && sb.st.removed.length === 0 && sb.st.finished.length === 0);
check('I finished orders fetched with modified_after (not all 5,000)', sb.st.fetches.some(([st, p]) => st === 'finished' && /^\d{4}-\d{2}-\d{2}T00:00:00$/.test(p?.modified_after || '')));
r = await sb.ctx.runExpiryCheck();
check('I live run: role removed for H1, both orders marked done', sb.st.removed.join() === 'H1' && sb.st.finished.sort().join() === '40,41' && r.tally.removed === 1 && r.tally.already_without_role === 1);
sb = sandbox({ wcOrders: [ord({ id: 42, discord: 'L1', expiry: shift(-1) })], finishedFails: true });
r = await sb.ctx.runExpiryCheck();
check('I finished-order fetch failing does not stop the normal run', r.success && sb.st.removed.join() === 'L1');

// G. activation
const found = expiry => ({ orderId: 50, order: { meta_data: expiry === undefined ? [] : [{ key: 'expiry_date', value: expiry }], line_items: [] } });
for (const [label, exp, ok] of [['yesterday', shift(-1), false], ['today', TODAY, false], ['tomorrow', shift(1), true], ['none (lifetime)', undefined, true]]) {
  sb = sandbox({ findResult: found(exp) });
  const res = await sb.ctx.activate('uuid', { id: 'D1', tag: 'd#1' });
  if (ok) check(`G activation, expiry ${label} -> granted`, res.success && sb.st.rolesAdded.includes('MEMBER') && sb.st.wcUpdates.includes(50));
  else check(`G activation, expiry ${label} -> EXPIRED, no role, no WC write`, !res.success && res.code === 'EXPIRED' && res.expiry === exp && sb.st.rolesAdded.length === 0 && sb.st.wcUpdates.length === 0);
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
