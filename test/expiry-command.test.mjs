// Tests for the /expiry slash command: admin gate, EXPIRY_COMMAND_KEY modal, preview + confirm flow.
// Discord and WooCommerce are mocked; discord.js builders are the real ones.
import fs from 'fs';
import vm from 'vm';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import * as discord from 'discord.js';

const BOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const plan = await import(BOT + '/expiry-plan.js');
const { localTodayIso } = plan;

let fail = 0;
const check = (label, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fail++; };
const TODAY = localTodayIso();
const shift = d => new Date(Date.parse(TODAY) + d * 86400000).toISOString().slice(0, 10);
const KEY = 'correct-horse-battery-staple';
const ord = ({ id, discord: did, expiry, email = `u${id}@x.com` }) => ({
  id, status: 'completed', billing: { email }, date_created_gmt: '2026-01-01T00:00:00',
  meta_data: [...(did ? [{ key: 'discord_id', value: did }] : []), ...(expiry !== undefined ? [{ key: 'expiry_date', value: expiry }] : [])],
});

const src = fs.readFileSync(BOT + '/index.js', 'utf8');
const glue = src.slice(src.indexOf('// --- AUTO-KICK JOB (runs daily) ---'), src.indexOf('// Schedule daily run'));

function sandbox({ orders = [], env = { EXPIRY_COMMAND_KEY: KEY } } = {}) {
  const st = { removed: [], finished: [], critical: [], posts: [], registered: null, wcOrders: orders, wcFetches: 0 };
  const guild = {
    id: 'G',
    members: { fetch: async id => ({ user: { id, tag: id }, roles: { cache: { has: () => true } } }) },
    commands: { create: async json => { st.registered = json; } },
  };
  const ctx = {
    process: { env: { TZ_OFFSET_HOURS: '7', GUILD_ID: 'G', ...env } }, Date, JSON, Promise, console, Number, parseInt, String, Error, Map, Set, Buffer, Array, Boolean, Math,
    ADMIN_LOG_CHANNEL_ID: 'admin', randomUUID, createHash, timingSafeEqual, ...plan,
    SlashCommandBuilder: discord.SlashCommandBuilder, PermissionFlagsBits: discord.PermissionFlagsBits, MessageFlags: discord.MessageFlags,
    AttachmentBuilder: discord.AttachmentBuilder, ActionRowBuilder: discord.ActionRowBuilder, ButtonBuilder: discord.ButtonBuilder, ButtonStyle: discord.ButtonStyle,
    EmbedBuilder: discord.EmbedBuilder, ModalBuilder: discord.ModalBuilder, TextInputBuilder: discord.TextInputBuilder, TextInputStyle: discord.TextInputStyle,
    woocommerce: { getAllOrders: async () => (st.wcFetches++, st.wcOrders), markOrderFinished: async id => st.finished.push(id) },
    client: { user: {}, guilds: { fetch: async () => guild }, channels: { fetch: async () => ({ isTextBased: () => true, send: async m => st.posts.push(m) }) } },
    removeMember: async (g, id) => (st.removed.push(id), { success: true }),
    appendBotLog: () => {}, logCritical: async t => st.critical.push(t),
  };
  vm.createContext(ctx);
  vm.runInContext(glue + '\n;Object.assign(this, { runExpiryCheck, handleExpiryCommand, handleExpiryKeyModal, handleExpiryButton, registerAdminCommands, pendingExpiryRuns, setBusy: v => { expiryRunActive = v; } });', ctx);
  return { ctx, st };
}

// Minimal interaction mocks
const base = ({ userId = 'ADMIN', perms = true, roles = [] }) => {
  const it = {
    user: { id: userId, tag: userId + '#0' }, guildId: 'G', inGuild: () => true,
    member: { roles }, memberPermissions: { has: () => perms },
    deferred: false, replies: [], edits: [], updates: [], modal: null,
    reply: async p => { it.replies.push(p); it.replied = true; },
    deferReply: async p => { it.deferred = true; it.deferFlags = p?.flags; },
    editReply: async p => it.edits.push(typeof p === 'string' ? { content: p } : p),
    update: async p => it.updates.push(p),
    showModal: async m => { it.modal = m.toJSON(); },
  };
  return it;
};
const cmd = ({ sub, date = null, ...who }) => Object.assign(base(who), { options: { getSubcommand: () => sub, getString: () => date } });
const modalSubmit = (customId, key, who = {}) => Object.assign(base(who), { customId, fields: { getTextInputValue: id => (id === 'expiry_key' ? key : '') } });
const btn = (customId, who = {}) => Object.assign(base(who), { customId });

// full flow: slash command -> modal -> submit key. Returns { c, m } (command + modal-submit interactions)
async function flow(sb, opts, key = KEY, submitter = {}) {
  const c = cmd(opts);
  await sb.ctx.handleExpiryCommand(c);
  if (!c.modal) return { c, m: null };
  const m = modalSubmit(c.modal.custom_id, key, submitter);
  await sb.ctx.handleExpiryKeyModal(m);
  return { c, m };
}
const lastEdit = it => it.edits[it.edits.length - 1];
const buttonIds = edit => (edit?.components || []).flatMap(r => r.toJSON().components.map(c => c.custom_id));

// 1. registration
let sb = sandbox();
await sb.ctx.registerAdminCommands();
check('1 /expiry registered (check + run, Manage Roles by default)', sb.st.registered?.name === 'expiry' &&
  sb.st.registered.options.map(o => o.name).join() === 'check,run' &&
  sb.st.registered.default_member_permissions === String(discord.PermissionFlagsBits.ManageRoles));

// 2. key configuration fails closed
sb = sandbox({ env: {} });
let { c } = await flow(sb, { sub: 'check' });
check('2 no EXPIRY_COMMAND_KEY -> disabled, no modal', c.replies[0]?.content.includes('disabled') && !c.modal);
sb = sandbox({ env: { EXPIRY_COMMAND_KEY: 'short' } });
({ c } = await flow(sb, { sub: 'check' }));
check('2 key shorter than 12 chars -> disabled', c.replies[0]?.content.includes('disabled') && !c.modal);

// 3. admin gate still applies before the key
sb = sandbox({ orders: [ord({ id: 1, discord: 'A', expiry: shift(-1) })] });
({ c } = await flow(sb, { sub: 'check', perms: false }));
check('3 user without Manage Roles refused, never sees key prompt', c.replies[0]?.content.includes('not allowed') && !c.modal);
sb = sandbox({ orders: [], env: { EXPIRY_COMMAND_KEY: KEY, EXPIRY_ADMIN_ROLE_IDS: 'R1,R2' } });
({ c } = await flow(sb, { sub: 'check', perms: true, roles: ['R9'] }));
check('3 allowlist set: Manage Roles alone not enough', c.replies[0]?.content.includes('not allowed'));
let r = await flow(sb, { sub: 'check', perms: false, roles: ['R2'] }, KEY, { perms: false, roles: ['R2'] });
check('3 allowlist set: listed role + key allowed', r.m?.deferred && r.m.edits.length === 1);

// 4. key is asked in a modal, not as a command option
sb = sandbox({ orders: [ord({ id: 10, discord: 'A', expiry: shift(-2) })] });
({ c } = await flow(sb, { sub: 'run', date: shift(-1) }, 'wrong-key-000000'));
check('4 modal shown with key field', c.modal?.custom_id === `expiry-key:run:${shift(-1)}` && JSON.stringify(c.modal).includes('expiry_key'));
check('4 command has no key option', !JSON.stringify(sb.st.registered || {}).includes('key'));

// 5. wrong key: refused, alerted, no data fetched; lockout after 5
sb = sandbox({ orders: [ord({ id: 10, discord: 'A', expiry: shift(-2) })] });
r = await flow(sb, { sub: 'check' }, 'wrong-key-000000');
check('5 wrong key refused, nothing fetched from WooCommerce', r.m.replies[0]?.content.includes('Wrong key') && sb.st.wcFetches === 0 && !r.m.deferred);
check('5 wrong key raises critical alert', sb.st.critical.some(t => t.includes('wrong admin key')));
for (let i = 0; i < 4; i++) r = await flow(sb, { sub: 'check' }, 'wrong-key-000000');
check('5 fifth wrong key locks the user out', r.m.replies[0]?.content.includes('locked for 15 minutes'));
r = await flow(sb, { sub: 'check' }, KEY);
check('5 locked user refused even with the right key (at the command)', r.c.replies[0]?.content.includes('Too many wrong keys') && !r.c.modal && sb.st.wcFetches === 0);
r = await flow(sb, { sub: 'check', userId: 'OTHER_ADMIN' }, KEY, { userId: 'OTHER_ADMIN' });
check('5 lockout is per user (other admin unaffected)', r.m?.deferred === true);

// 6. forged/replayed modal submit from a non-admin is refused
sb = sandbox({ orders: [ord({ id: 10, discord: 'A', expiry: shift(-2) })] });
let m = modalSubmit('expiry-key:run:', KEY, { perms: false });
await sb.ctx.handleExpiryKeyModal(m);
check('6 modal submit by non-admin refused', m.replies[0]?.content.includes('not allowed') && sb.st.wcFetches === 0);

// 7. correct key: check = ephemeral preview + CSV, nothing changed
sb = sandbox({ orders: [ord({ id: 10, discord: 'A', expiry: shift(-2) }), ord({ id: 11, discord: 'B', expiry: TODAY }), ord({ id: 12, expiry: shift(-9) })] });
r = await flow(sb, { sub: 'check' });
let e = lastEdit(r.m);
check('7 check: ephemeral', r.m.deferFlags === discord.MessageFlags.Ephemeral);
check('7 check: summary shows 2 removals (1 overdue)', e.content.includes('Remove member role: **2** (1 overdue)'));
check('7 check: CSV attached with all 3 rows', e.files?.length === 1 && e.files[0].attachment.toString().trim().split('\n').length === 4);
check('7 check: no buttons, nothing changed', buttonIds(e).length === 0 && sb.st.removed.length === 0 && sb.st.finished.length === 0);

// 8. run: confirm executes the previewed set only; no second key prompt
r = await flow(sb, { sub: 'run' });
const [confirmId, cancelId] = buttonIds(lastEdit(r.m));
check('8 run: confirm + cancel buttons', confirmId?.startsWith('expiry:confirm:') && cancelId?.startsWith('expiry:cancel:'));
let b = btn(confirmId, { userId: 'SOMEONE' });
await sb.ctx.handleExpiryButton(b);
check('8 other user cannot confirm', b.replies[0]?.content.includes('Only the admin') && sb.st.removed.length === 0);
sb.st.wcOrders = [...sb.st.wcOrders, ord({ id: 13, discord: 'C', expiry: shift(-1) })]; // appears after preview
b = btn(confirmId);
await sb.ctx.handleExpiryButton(b);
check('8 confirm removes exactly the previewed members (no key re-prompt)', sb.st.removed.sort().join() === 'A,B' && sb.st.finished.sort().join() === '10,11' && !b.modal);
check('8 order that appeared after preview NOT touched', !sb.st.removed.includes('C'));
check('8 result message + audit post', b.edits[0]?.content.includes('Removed: 2') && sb.st.posts.some(p => String(p).includes('manual run by ADMIN#0')));
b = btn(confirmId);
await sb.ctx.handleExpiryButton(b);
check('8 confirm is single-use', b.updates[0]?.content.includes('expired'));

// 9. plan grew since preview -> halted
sb = sandbox({ orders: [ord({ id: 20, discord: 'K', expiry: shift(-1) }), ord({ id: 21, discord: 'K', expiry: shift(30) })] });
r = await flow(sb, { sub: 'run' });
const cid = buttonIds(lastEdit(r.m))[0];
sb.st.wcOrders = [sb.st.wcOrders[0]];
b = btn(cid);
await sb.ctx.handleExpiryButton(b);
check('9 keep turned into remove -> halted, nothing changed', b.edits[0]?.content.includes('plan changed') && sb.st.removed.length === 0 && sb.st.finished.length === 0);

// 10. cancel, busy, dates, expiry of confirmation
sb = sandbox({ orders: [ord({ id: 30, discord: 'X', expiry: shift(-1) })] });
r = await flow(sb, { sub: 'run' });
b = btn(buttonIds(lastEdit(r.m))[1]);
await sb.ctx.handleExpiryButton(b);
check('10 cancel changes nothing', b.updates[0]?.content.includes('Cancelled') && sb.st.removed.length === 0);
r = await flow(sb, { sub: 'run' });
sb.ctx.setBusy(true);
b = btn(buttonIds(lastEdit(r.m))[0]);
await sb.ctx.handleExpiryButton(b);
check('10 another live run in progress -> refused', b.edits[0]?.content.includes('Another expiry run') && sb.st.removed.length === 0);
sb.ctx.setBusy(false);
r = await flow(sb, { sub: 'run', date: shift(1) });
check('10 run with future date refused', lastEdit(r.m).content.includes('future date'));
r = await flow(sb, { sub: 'check', date: shift(1) });
check('10 check with future date allowed', lastEdit(r.m).content.includes(`as of ${shift(1)}`));
({ c } = await flow(sb, { sub: 'check', date: '2026:09:30' }));
check('10 malformed date rejected before the key prompt', c.replies[0]?.content.includes('YYYY-MM-DD') && !c.modal);
r = await flow(sb, { sub: 'run' });
const nid = buttonIds(lastEdit(r.m))[0];
for (const v of sb.ctx.pendingExpiryRuns.values()) v.createdAt -= 11 * 60 * 1000;
b = btn(nid);
await sb.ctx.handleExpiryButton(b);
check('10 confirmation older than 10 min rejected', b.updates[0]?.content.includes('expired') && sb.st.removed.length === 0);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
