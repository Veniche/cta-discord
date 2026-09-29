// Tests for membership-report.js: duration port, membership per member, audit codes, find, CSV.
import { fileURLToPath } from 'url';

const BOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const { localTodayIso } = await import(BOT + '/expiry-plan.js');
const R = await import(BOT + '/membership-report.js');

let fail = 0;
const check = (label, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fail++; };
const TODAY = localTodayIso();
const shift = d => new Date(Date.parse(TODAY) + d * 86400000).toISOString().slice(0, 10);

const o = ({ id, status = 'completed', product = 'CTA Membership 3 Bulan', total = '499000', discount = '0', discord, username, expiry, old,
  code = `code-${id}`, created = shift(-20), email = `u${id}@x.com` }) => ({
  id, status, total, discount_total: discount, discount_tax: '0', billing: { email },
  date_created_gmt: created + 'T03:00:00', date_paid_gmt: created + 'T03:00:00',
  line_items: [{ name: product, quantity: 1, subtotal: total, subtotal_tax: '0' }],
  meta_data: [
    ...(code ? [{ key: 'activation_uuid', value: code }] : []),
    ...(discord ? [{ key: 'discord_id', value: discord }] : []),
    ...(username ? [{ key: 'discord_username', value: username }] : []),
    ...(expiry !== undefined ? [{ key: 'expiry_date', value: expiry }] : []),
    ...(old ? [{ key: 'is_old', value: 'True' }] : []),
  ],
});
const MR = 'MEMBER', LR = 'LIFE';
const mem = (id, roles, extra = {}) => ({
  id, username: `user_${id.toLowerCase()}`, globalName: null, displayName: `user_${id.toLowerCase()}`,
  joinedAt: Date.parse('2025-01-01'), bot: false, staff: false, roles, ...extra,
});

// ---- duration: port of cta_bot_resolve_duration ----
const dur = x => R.resolveDuration(o({ id: 0, ...x }));
check('dur "3 Bulan" -> 3 months', dur({}).label === '3 months');
check('dur lifetime name beats a 12-month price', dur({ product: 'CTA Lifetime Access', total: '1499000' }).kind === 'lifetime');
check('dur "Akses Unlimited 1 Bulan" -> 1 month (explicit duration beats keyword)', dur({ product: 'Akses Unlimited 1 Bulan', total: '0' }).label === '1 month');
check('dur price tier: total + discount = 1,499,000 -> 12 months', dur({ product: 'Membership', total: '999000.00', discount: '500000' }).label === '12 months');
check('dur "1 Tahun" -> 12 months', dur({ product: 'Membership 1 Tahun', total: '0' }).label === '12 months');
check('dur "Seumur Hidup" -> lifetime', dur({ product: 'Seumur Hidup Pass', total: '0' }).kind === 'lifetime');
check('dur test product priced 1 -> 1 day', dur({ product: 'Test', total: '1' }).label === '1 day');
check('dur no match -> unknown', dur({ product: 'Mystery', total: '123' }).kind === 'unknown');
check('expected expiry: Jan 31 + 3 months overflows like PHP strtotime', R.orderView(o({ id: 0, created: '2026-01-31' }), TODAY).expected === '2026-05-01');

// ---- scenario ----
const orders = [
  o({ id: 1, discord: 'A', expiry: shift(30) }),
  o({ id: 2, discord: 'B', product: 'CTA Lifetime' }),
  o({ id: 3, discord: 'C', expiry: shift(-5) }),                               // overdue, still completed
  o({ id: 4, expiry: shift(-10) }),                                             // never activated, expired
  o({ id: 5, discord: 'D' }),                                                   // 3 months, no expiry
  o({ id: 6, discord: 'E', product: 'Lifetime Pass', expiry: shift(100) }),     // lifetime with expiry
  o({ id: 7, discord: 'F', status: 'processing', expiry: shift(30) }),          // activated, not completed
  o({ id: 8, discord: 'G', status: 'finished', old: true, expiry: shift(-100) }),
  o({ id: 9, code: null, expiry: shift(60) }),                                  // no code
  o({ id: 10, code: 'DUP', expiry: shift(50) }),
  o({ id: 11, code: 'DUP', expiry: shift(50) }),
  o({ id: 12, discord: 'Q', expiry: 'bogus' }),
  o({ id: 13, discord: 'Z', status: 'finished' }),                              // finished without is_old
  o({ id: 14, discord: 'Y', old: true, expiry: shift(20) }),                    // completed but is_old
  o({ id: 15, discord: 'H', username: 'oldname#1234', product: 'CTA Lifetime', status: 'finished', old: true, expiry: shift(-30) }),
  o({ id: 16, discord: 'I', product: 'CTA 1 Tahun', total: '1499000', expiry: shift(200) }),     // left the server
  o({ id: 17, expiry: shift(50), created: shift(-10) }),                        // not activated yet
  o({ id: 18, discord: 'R', product: 'Mystery', total: '123' }),               // unknown duration, no expiry
  o({ id: 19, discord: 'S', expiry: '2062-01-01' }),                            // implausible
  o({ id: 20, discord: 'L', expiry: shift(40) }),                               // lifetime role, 3-month purchase
  o({ id: 21, discord: 'M', product: 'Akses Unlimited' }),                      // lifetime by plugin rules, bot gave no lifetime role
  o({ id: 22, discord: 'N', expiry: shift(10) }),                               // active, no member role
  o({ id: 23, discord: 'X', status: 'finished', old: true, expiry: shift(-60), created: shift(-150) }),
  o({ id: 24, discord: 'X', product: 'CTA 1 Tahun', total: '1499000', expiry: shift(300), created: shift(-5) }),
];
const members = [
  mem('A', [MR]), mem('B', [MR, LR]), mem('C', [MR]), mem('D', [MR]), mem('E', [MR, LR]), mem('F', [MR]), mem('G', [MR]),
  mem('J', [MR], { staff: true }), mem('Q', [MR]), mem('R', [MR]), mem('S', [MR]), mem('L', [MR, LR]), mem('M', [MR]),
  mem('N', []), mem('X', [MR]), mem('K', [LR]), mem('W', [MR, LR], { username: '=HYPERLINK("x")' }), mem('a_b', [], { username: 'a_b' }),
  mem('BOT', [MR], { bot: true }),
];
const webinarRows = [
  { email: 'k@x.com', is_used: 'True', discord_id: 'K', discord_username: 'webk' },
  { email: 'w@x.com', is_used: 'True', discord_id: 'W', discord_username: 'webw' },
  { email: 'unused@x.com', is_used: 'False', discord_id: '' },
];
const data = { orders, members, webinarRows, memberRoleId: MR, lifetimeRoleId: LR, todayIso: TODAY };

// ---- membership per member ----
const idx = R.indexData(data);
let ms = R.membershipFor('X', idx);
check('membership: newest active order wins (12 months via #24, latest #24)', ms.label === '12 months' && ms.accessOrder.id === 24 && ms.latestOrder.id === 24 && ms.daysLeft === 300);
check('membership: lifetime order', R.membershipFor('B', idx).label === 'lifetime');
check('membership: webinar code -> lifetime (webinar)', R.membershipFor('W', idx).label === 'lifetime (webinar)' && R.membershipFor('W', idx).source === 'webinar');
check('membership: no expiry on a 3-month product is still access (the bot never removes it)', R.membershipFor('D', idx).kind === 'no_expiry' && R.membershipFor('D', idx).active);
ms = R.membershipFor('G', idx);
check('membership: only a finished order -> none, last expiry shown', !ms.active && ms.kind === 'none' && ms.lastExpiry === shift(-100));
check('membership: order expiring today still counts', R.membershipFor('T', R.indexData({ orders: [o({ id: 99, discord: 'T', expiry: TODAY })], todayIso: TODAY })).active);

// ---- audit ----
const audit = R.auditMemberships(data);
const got = code => audit.findings.filter(f => f.code === code);
const ids = code => got(code).map(f => f.orderId).sort((a, b) => a - b).join();
const who = code => got(code).map(f => f.discordId).sort().join();
check('audit overdue_not_removed = #3', ids('overdue_not_removed') === '3');
check('audit expired_never_activated = #4', ids('expired_never_activated') === '4');
check('audit no_expiry_not_lifetime = #5 (with expected date)', ids('no_expiry_not_lifetime') === '5' && got('no_expiry_not_lifetime')[0].detail.includes('expected'));
check('audit lifetime_with_expiry = #6', ids('lifetime_with_expiry') === '6');
check('audit activated_order_not_completed = #7', ids('activated_order_not_completed') === '7');
check('audit role_without_access = G, J (overdue C and processing F not repeated; bot ignored)', who('role_without_access') === 'G,J');
check('audit role_without_access marks staff', got('role_without_access').find(f => f.discordId === 'J').detail.includes('staff'));
check('audit completed_without_code = #9', ids('completed_without_code') === '9');
check('audit duplicate_code = #10, #11 (code value never printed)', ids('duplicate_code') === '10,11' && !JSON.stringify(got('duplicate_code')).includes('DUP'));
check('audit invalid_expiry = #12', ids('invalid_expiry') === '12');
check('audit finished_without_is_old = #13', ids('finished_without_is_old') === '13');
check('audit completed_but_is_old = #14', ids('completed_but_is_old') === '14');
check('audit lifetime_order_finished = #15', ids('lifetime_order_finished') === '15');
check('audit active_member_left_server = I', who('active_member_left_server') === 'I');
check('audit not_activated_yet = #9, #10, #11, #17', ids('not_activated_yet') === '9,10,11,17');
check('audit no_expiry_unknown_duration = #18', ids('no_expiry_unknown_duration') === '18');
check('audit expiry_implausible = #19', ids('expiry_implausible') === '19');
check('audit lifetime_role_without_lifetime_purchase = L', who('lifetime_role_without_lifetime_purchase') === 'L');
check('audit lifetime_missing_lifetime_role = M ("Unlimited" product)', who('lifetime_missing_lifetime_role') === 'M');
check('audit active_missing_member_role = K (webinar lifetime), N', who('active_missing_member_role') === 'K,N');
check('audit: every finding has a known code', audit.findings.every(f => R.AUDIT_CODES[f.code]));
check('audit: action codes sorted before info', audit.summary.findIndex(s => s.severity === 'info') > audit.summary.map(s => s.severity).lastIndexOf('action'));
check('audit: status counts', audit.statusCounts.completed === 19 && audit.statusCounts.finished === 4 && audit.statusCounts.processing === 1);
check('audit: bots not counted as scanned members', audit.scannedMembers === members.length - 1);
const clean = R.auditMemberships({ ...data, orders: [orders[0], orders[1]], members: [members[0], members[1]], webinarRows: [] });
check('audit: consistent data -> no findings', clean.findings.length === 0 && clean.summary.length === 0);
check('audit without Discord data: order checks only', R.auditMemberships({ ...data, members: null }).findings.every(f => !['role_without_access', 'active_missing_member_role'].includes(f.code)));

// ---- list ----
let rep = R.buildMembersReport({ members, memberRoleId: MR, lifetimeRoleId: LR, todayIso: TODAY });
check('list: member-role holders only, bot excluded', rep.rows.length === 15 && !rep.rows.some(r => r.discordId === 'BOT' || r.discordId === 'N'));
check('list: simple has no order columns', rep.rows[0].membership === undefined && rep.summary.lifetimeRole === 4);
rep = R.buildMembersReport(data);
const row = id => rep.rows.find(r => r.discordId === id);
check('list detailed: X -> 12 months, access #24, latest #24', row('X').membership === '12 months' && row('X').accessOrderId === 24 && row('X').latestOrderId === 24);
check('list detailed: G -> none, latest #8 finished', row('G').kind === 'none' && row('G').latestOrderId === 8 && row('G').latestOrderStatus === 'finished');
check('list detailed: summary buckets', rep.summary.byMembership.lifetime === 2 && rep.summary.byMembership['lifetime (webinar)'] === 1 && rep.summary.byMembership.none === 4);
const csv = R.membersToCsv(rep);
check('csv: header + one line per member', csv.trim().split('\n').length === 16 && csv.startsWith('discord_id,username,display_name'));
check('csv: formula-looking username neutralised', csv.includes(`"'=HYPERLINK(""x"")"`));
check('csv: audit export has every finding', R.auditToCsv(audit).trim().split('\n').length === audit.findings.length + 1);

// ---- find ----
const pq = R.parseFindQuery;
check('find parse: mention / snowflake -> discord_id', pq('<@!123456789012345678>').value === '123456789012345678' && pq('123456789012345678').type === 'discord_id');
check('find parse: #7700 / 7700 -> order_id', pq('#7700').value === 7700 && pq('7700').type === 'order_id');
check('find parse: email lowercased', pq(' A@B.com ').type === 'email' && pq('A@B.com').value === 'a@b.com');
check('find parse: @name -> name', pq('@Some_User').type === 'name' && pq('@Some_User').value === 'some_user');

let res = R.findMembership({ type: 'discord_id', value: 'G' }, data);
let txt = R.formatFindResult(res, { memberRoleId: MR, lifetimeRoleId: LR });
check('find G: no membership, role_without_access issue shown', txt.includes('Membership: ❌ **none**') && txt.includes('Member role, but no active order'));
res = R.findMembership(pq('user_x'), data);
check('find by exact username -> one subject (X)', res.subjects.length === 1 && res.subjects[0].discordId === 'X');
txt = R.formatFindResult(res, { memberRoleId: MR, lifetimeRoleId: LR });
check('find X: shows 12 months, both orders, member role yes', txt.includes('**12 months**') && txt.includes('#24') && txt.includes('#23') && txt.includes('member role: yes'));
res = R.findMembership(pq('user_'), data);
check('find ambiguous name -> candidate list, no details', res.subjects.length === 0 && res.candidates.length > 3 && R.formatFindResult(res, {}).includes('run again with the Discord ID'));
res = R.findMembership(pq('oldname'), data);
check('find by username stored on the order (member left)', res.subjects[0]?.discordId === 'H' && R.formatFindResult(res, { memberRoleId: MR }).includes('Not in the server'));
res = R.findMembership(pq('u4@x.com'), data);
check('find by email: unlinked order with its issue', res.subjects.length === 0 && res.unlinked[0]?.id === 4 && res.unlinkedFindings.some(f => f.code === 'expired_never_activated'));
res = R.findMembership(pq('#24'), data);
check('find by order number -> its Discord member', res.subjects[0]?.discordId === 'X');
res = R.findMembership(pq('nobody-like-this'), data);
check('find: no match message', R.formatFindResult(res, {}).includes('No Discord member'));
res = R.findMembership(pq('a_b'), data);
check('find: markdown in names escaped', R.formatFindResult(res, { memberRoleId: MR }).includes('a\\_b'));
check('find: output fits one Discord message', R.formatFindResult(R.findMembership(pq('user_x'), data), {}).length <= 1900);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
