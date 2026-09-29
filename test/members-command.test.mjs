// Tests for the /members slash command: admin gate, key modal, key unlock window, read-only replies.
// Discord and WooCommerce are mocked; discord.js builders are the real ones.
import fs from 'fs';
import vm from 'vm';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import * as discord from 'discord.js';

const BOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const plan = await import(BOT + '/expiry-plan.js');
const report = await import(BOT + '/membership-report.js');
const { localTodayIso } = plan;

let fail = 0;
const check = (label, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fail++; };
const TODAY = localTodayIso();
const shift = d => new Date(Date.parse(TODAY) + d * 86400000).toISOString().slice(0, 10);
const KEY = 'correct-horse-battery-staple';
const ord = ({ id, discord: did, expiry, status = 'completed' }) => ({
  id, status, total: '499000', billing: { email: `u${id}@x.com` }, date_created_gmt: shift(-20) + 'T00:00:00',
  line_items: [{ name: 'CTA 3 Bulan', quantity: 1, subtotal: '499000' }],
  meta_data: [{ key: 'activation_uuid', value: `c${id}` }, ...(did ? [{ key: 'discord_id', value: did }] : []), ...(expiry ? [{ key: 'expiry_date', value: expiry }] : [])],
});
const gm = (id, roles) => ({ user: { id, username: `user_${id.toLowerCase()}`, globalName: null, bot: false }, displayName: `user_${id.toLowerCase()}`,
  joinedTimestamp: Date.parse('2025-01-01'), roles: { cache: new Map(roles.map(r => [r, {}])) }, permissions: { has: () => false } });

const src = fs.readFileSync(BOT + '/index.js', 'utf8');
const glue = src.slice(src.indexOf('// --- AUTO-KICK JOB (runs daily) ---'), src.indexOf('// Schedule daily run'));

function sandbox({ env = {} } = {}) {
  const st = { registered: [], critical: [], wcFetches: 0, memberFetches: 0,
    orders: [ord({ id: 1, discord: 'A', expiry: shift(30) }), ord({ id: 2, discord: 'G', expiry: shift(-9), status: 'finished' })],
    members: [gm('A', ['MEMBER']), gm('G', ['MEMBER'])] };
  const guild = {
    id: 'G',
    members: { fetch: async id => (id ? null : (st.memberFetches++, new Map(st.members.map(m => [m.user.id, m])))) },
    commands: { create: async json => { st.registered.push(json); } },
  };
  const ctx = {
    process: { env: { TZ_OFFSET_HOURS: '7', GUILD_ID: 'G', MEMBER_ROLE_ID: 'MEMBER', LIFETIME_ROLE_ID: 'LIFE', EXPIRY_COMMAND_KEY: KEY, ...env } },
    Date, JSON, Promise, console, Number, parseInt, String, Error, Map, Set, Buffer, Array, Boolean, Math, Object,
    ADMIN_LOG_CHANNEL_ID: 'admin', randomUUID, createHash, timingSafeEqual, ...plan, ...report,
    SlashCommandBuilder: discord.SlashCommandBuilder, PermissionFlagsBits: discord.PermissionFlagsBits, MessageFlags: discord.MessageFlags,
    AttachmentBuilder: discord.AttachmentBuilder, ActionRowBuilder: discord.ActionRowBuilder, ButtonBuilder: discord.ButtonBuilder, ButtonStyle: discord.ButtonStyle,
    EmbedBuilder: discord.EmbedBuilder, ModalBuilder: discord.ModalBuilder, TextInputBuilder: discord.TextInputBuilder, TextInputStyle: discord.TextInputStyle,
    woocommerce: {
      getAllOrdersAnyStatus: async () => (st.wcFetches++, st.orders),
      getAllOrders: async () => (st.wcFetches++, st.orders.filter(o => o.status === 'completed')),
      markOrderFinished: async () => { throw new Error('read-only command must not write'); },
    },
    client: { user: {}, guilds: { fetch: async () => guild }, channels: { fetch: async () => ({ isTextBased: () => true, send: async () => {} }) } },
    readWebinarCsv: () => [],
    removeMember: async () => { throw new Error('read-only command must not remove'); },
    appendBotLog: () => {}, logCritical: async t => st.critical.push(t),
  };
  vm.createContext(ctx);
  vm.runInContext(glue + '\n;Object.assign(this, { registerMembersCommand, handleMembersCommand, handleMembersKeyModal, handleExpiryCommand, handleExpiryKeyModal, pendingMembersRequests });', ctx);
  return { ctx, st };
}

const base = ({ userId = 'ADMIN', perms = true }) => {
  const it = {
    user: { id: userId, tag: userId + '#0' }, guildId: 'G', inGuild: () => true,
    member: { roles: [] }, memberPermissions: { has: () => perms },
    deferred: false, replies: [], edits: [], modal: null,
    reply: async p => { it.replies.push(p); it.replied = true; },
    deferReply: async p => { it.deferred = true; it.deferFlags = p?.flags; },
    editReply: async p => it.edits.push(typeof p === 'string' ? { content: p } : p),
    showModal: async m => { it.modal = m.toJSON(); },
  };
  return it;
};
const cmd = ({ sub, detailed = null, user = null, query = null, ...who }) => Object.assign(base(who), {
  options: { getSubcommand: () => sub, getBoolean: () => detailed, getUser: () => (user ? { id: user } : null), getString: () => query },
});
const modalSubmit = (customId, key, who = {}) => Object.assign(base(who), { customId, fields: { getTextInputValue: id => (id === 'expiry_key' ? key : '') } });

// slash command -> (modal -> key). Returns { c, m }; m is null when no modal was shown.
async function flow(sb, opts, key = KEY, submitter = {}) {
  const c = cmd(opts);
  await sb.ctx.handleMembersCommand(c);
  if (!c.modal) return { c, m: null };
  const m = modalSubmit(c.modal.custom_id, key, { userId: opts.userId, ...submitter });
  await sb.ctx.handleMembersKeyModal(m);
  return { c, m };
}
const last = it => it.edits[it.edits.length - 1];
const csvLines = e => e?.files?.[0]?.attachment.toString().trim().split('\n').length;

// 1. registration
let sb = sandbox();
await sb.ctx.registerMembersCommand();
const reg = sb.st.registered[0];
check('1 /members registered with list, find, audit (Manage Roles by default)', reg?.name === 'members' &&
  reg.options.map(o => o.name).join() === 'list,find,audit' && reg.default_member_permissions === String(discord.PermissionFlagsBits.ManageRoles));
check('1 list has detailed; find has user + query; no key option', reg.options[0].options[0].name === 'detailed' &&
  reg.options[1].options.map(o => o.name).join() === 'user,query' && !JSON.stringify(reg).includes('"key"'));

// 2. gates before the key prompt
let r = await flow(sb, { sub: 'audit', perms: false });
check('2 user without Manage Roles refused, no modal', r.c.replies[0]?.content.includes('not allowed') && !r.c.modal);
r = await flow(sandbox({ env: { EXPIRY_COMMAND_KEY: '' } }), { sub: 'audit' });
check('2 no EXPIRY_COMMAND_KEY -> disabled', r.c.replies[0]?.content.includes('disabled') && !r.c.modal);
r = await flow(sb, { sub: 'find' });
check('2 find with neither user nor query refused before the key prompt', r.c.replies[0]?.content.includes('Give a `user`') && !r.c.modal);

// 3. wrong key: refused, alerted, nothing read
sb = sandbox();
r = await flow(sb, { sub: 'audit' }, 'wrong-key-000000');
check('3 modal carries only a nonce', /^members-key:[0-9a-f-]{36}$/.test(r.c.modal?.custom_id || ''));
check('3 wrong key refused; nothing fetched from Discord or WooCommerce', r.m.replies[0]?.content.includes('Wrong key') && sb.st.wcFetches === 0 && sb.st.memberFetches === 0);
check('3 wrong key raises a critical alert', sb.st.critical.some(t => t.includes('/members — wrong admin key')));

// 4. correct key: audit reply is ephemeral, no pings, CSV attached
r = await flow(sb, { sub: 'audit' });
let e = last(r.m);
check('4 audit: ephemeral reply', r.m.deferFlags === discord.MessageFlags.Ephemeral);
check('4 audit: summary + CSV, mentions disabled', e.content.includes('Membership audit') && e.content.includes('Member role, but no active order') &&
  csvLines(e) >= 2 && e.allowedMentions?.parse?.length === 0);

// 5. unlock window: same user skips the key; other users and /expiry still ask
const c2 = cmd({ sub: 'find', user: 'A' });
await sb.ctx.handleMembersCommand(c2);
check('5 unlocked: next /members runs without a modal', !c2.modal && c2.deferred && last(c2).content.includes('**3 months**'));
const other = cmd({ sub: 'audit', userId: 'OTHER' });
await sb.ctx.handleMembersCommand(other);
check('5 unlock is per user', Boolean(other.modal));
const ex = Object.assign(base({}), { options: { getSubcommand: () => 'check', getString: () => null } });
await sb.ctx.handleExpiryCommand(ex);
check('5 /expiry still asks for the key while unlocked', Boolean(ex.modal));

sb = sandbox({ env: { ADMIN_KEY_UNLOCK_MINUTES: '0' } });
await flow(sb, { sub: 'audit' });
r = await flow(sb, { sub: 'audit' }, 'wrong-key-000000');
check('5 ADMIN_KEY_UNLOCK_MINUTES=0 -> asks every time', Boolean(r.c.modal));

sb = sandbox();
const exc = Object.assign(base({}), { options: { getSubcommand: () => 'check', getString: () => null } });
await sb.ctx.handleExpiryCommand(exc);
await sb.ctx.handleExpiryKeyModal(modalSubmit(exc.modal.custom_id, KEY));
const after = cmd({ sub: 'list' });
await sb.ctx.handleMembersCommand(after);
check('5 a correct /expiry key also unlocks /members', !after.modal && after.deferred);

// 6. wrong keys share the /expiry lockout
sb = sandbox();
for (let i = 0; i < 5; i++) r = await flow(sb, { sub: 'audit' }, 'wrong-key-000000');
check('6 fifth wrong /members key locks the user out', r.m.replies[0]?.content.includes('locked for 15 minutes'));
const lockedEx = Object.assign(base({}), { options: { getSubcommand: () => 'check', getString: () => null } });
await sb.ctx.handleExpiryCommand(lockedEx);
check('6 the lockout applies to /expiry too', lockedEx.replies[0]?.content.includes('Too many wrong keys') && !lockedEx.modal);

// 7. stale / foreign requests
sb = sandbox();
let c = cmd({ sub: 'audit' });
await sb.ctx.handleMembersCommand(c);
for (const v of sb.ctx.pendingMembersRequests.values()) v.createdAt -= 11 * 60 * 1000;
let m = modalSubmit(c.modal.custom_id, KEY);
await sb.ctx.handleMembersKeyModal(m);
check('7 request older than 10 min rejected, nothing read', m.replies[0]?.content.includes('expired') && sb.st.wcFetches === 0);
c = cmd({ sub: 'audit' });
await sb.ctx.handleMembersCommand(c);
m = modalSubmit(c.modal.custom_id, KEY, { userId: 'OTHER' });
await sb.ctx.handleMembersKeyModal(m);
check('7 another admin cannot run someone else\'s pending request', m.replies[0]?.content.includes('expired') && sb.st.wcFetches === 0);
m = modalSubmit(c.modal.custom_id, KEY);
await sb.ctx.handleMembersKeyModal(m);
check('7 ...and the owner still can', m.deferred && last(m).content.includes('Membership audit'));
m = modalSubmit(c.modal.custom_id, KEY);
await sb.ctx.handleMembersKeyModal(m);
check('7 a request runs once', m.replies[0]?.content.includes('expired'));

// 8. list: simple skips WooCommerce; detailed reads it
sb = sandbox();
r = await flow(sb, { sub: 'list' });
check('8 list: 2 role holders, CSV, WooCommerce not read', last(r.m).content.includes('member role: 2') && csvLines(last(r.m)) === 3 && sb.st.wcFetches === 0);
c = cmd({ sub: 'list', detailed: true });
await sb.ctx.handleMembersCommand(c);
check('8 list detailed: membership buckets + detailed CSV', sb.st.wcFetches === 1 && last(c).content.includes('3 months: 1') &&
  last(c).files[0].name.startsWith('members-detailed-') && last(c).files[0].attachment.toString().split('\n')[0].includes('membership'));

// 9. find by query
c = cmd({ sub: 'find', query: 'u2@x.com' });
await sb.ctx.handleMembersCommand(c);
check('9 find by email -> G, no membership, issue listed', last(c).content.includes('`G`') && last(c).content.includes('**none**') && last(c).content.includes('no active order'));

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
