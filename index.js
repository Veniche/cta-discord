import axios from 'axios';
import express from "express";
import { Client, GatewayIntentBits, EmbedBuilder, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import dotenv from "dotenv";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import { WooCommerceService } from "./woocommerce-service.js";

dotenv.config();

const app = express();
app.use(express.json());

const woocommerce = new WooCommerceService();

// --- LOGGING UTILITY ---
const BOT_LOG_FILE = process.env.BOT_LOG_FILE || path.join(process.cwd(), 'bot-activity.log');
const ADMIN_LOG_CHANNEL_ID = process.env.ADMIN_LOG_CHANNEL_ID;
const ACTIVATION_LOG_CHANNEL_ID = process.env.ACTIVATION_LOG_CHANNEL_ID;

function appendBotLog(level, message, data = {}) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...data
    }) + '\n';
    fs.appendFileSync(BOT_LOG_FILE, line);
  } catch (e) {
    console.error('Failed to write bot log:', e.message);
  }
}

async function logCritical(title, details = {}) {
  appendBotLog('CRITICAL', title, details);
  try {
    if (!ADMIN_LOG_CHANNEL_ID || !client.user) return;
    const channel = await client.channels.fetch(ADMIN_LOG_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased()) return;
    
    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle('⚠️ ' + title)
      .setDescription(JSON.stringify(details, null, 2).slice(0, 2000))
      .setTimestamp()
      .setFooter({ text: 'Critical Alert' });
    
    await channel.send({ embeds: [embed] }).catch(() => null);
  } catch (e) {
    appendBotLog('ERROR', 'Failed to send critical alert to Discord', { error: e.message });
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// --- BOT STARTUP ---
client.once("clientReady", () => {
  const msg = `✅ Logged in as ${client.user.tag}`;
  console.log(msg);
  appendBotLog('INFO', msg);
  // Post activation message on startup if configured
  postActivationMessage().catch(() => null);
});

client.login(process.env.DISCORD_TOKEN);

// Invite cache removed — using direct activation flow only

// Webinar Implementation
const WEBINAR_CSV_PATH = path.join(process.cwd(), 'webinar_final.csv');
const WEBINAR_LOCK_PATH = WEBINAR_CSV_PATH + ".lock";

function readWebinarCsv() {
  if (!fs.existsSync(WEBINAR_CSV_PATH)) return [];
  const raw = fs.readFileSync(WEBINAR_CSV_PATH, 'utf8').trim();
  if (!raw) return [];

  const [headerLine, ...lines] = raw.split('\n');
  const headers = headerLine.split(',');

  return lines.map(line => {
    const values = line.split(',');
    const row = {};
    headers.forEach((h, i) => {
      row[h.trim()] = (values[i] || '').trim();
    });
    return row;
  });
}

function writeWebinarCsv(rows) {
  if (!rows.length) return;

  const headers = Object.keys(rows[0]);
  const csv =
    headers.join(',') + '\n' +
    rows.map(r => headers.map(h => r[h] ?? '').join(',')).join('\n');

  fs.writeFileSync(WEBINAR_CSV_PATH, csv, 'utf8');
}

// Lockfile
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_TIMEOUT_MS = 10_000;

async function acquireLock(lockPath) {
  const start = Date.now();

  while (true) {
    try {
      fs.writeFileSync(lockPath, process.pid.toString(), { flag: "wx" });
      return;
    } catch {
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error("CSV lock timeout");
      }
      await new Promise(res => setTimeout(res, LOCK_RETRY_DELAY_MS));
    }
  }
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {}
}

// --- Activation helper (shared by DM and modal flows) ---
async function activateOrderForDiscordUser(uuid, discordUser) {
  // unified activation with attempt logging
  const attempt = { uuid, userId: discordUser.id, userTag: discordUser.tag, ts: new Date().toISOString() };
  let result = { success: false, code: 'UNKNOWN', orderId: null, error: null };

  try {
    // ─────────────────────────────────────────────
    // 1️⃣ CHECK WEBINAR CSV FIRST (LOCKED)
    // ─────────────────────────────────────────────
    await acquireLock(WEBINAR_LOCK_PATH);

    try {
      const webinarRows = readWebinarCsv();
      const webinarRow = webinarRows.find(
        r => r.activation_uuid === uuid
      );

      if (webinarRow) {
        if (String(webinarRow.is_used).toLowerCase() === 'true') {
          appendBotLog('INFO', 'Webinar activation already used', {
            uuid,
            email: webinarRow.email,
            userId: discordUser.id
          });
          result = { success: false, code: 'ALREADY_USED', orderId: 'WEBINAR' };
          return result;
        }

        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        const member = await guild.members.fetch(discordUser.id).catch(() => null);
        if (!member) {
          result = { success: false, code: 'NOT_IN_GUILD', orderId: 'WEBINAR' };
          return result;
        }

        const memberRoleId = process.env.MEMBER_ROLE_ID;
        const lifetimeRoleId = process.env.LIFETIME_ROLE_ID;
        if (!memberRoleId || !lifetimeRoleId) {
          result = { success: false, code: 'NO_ROLE_CONFIG', orderId: 'WEBINAR' };
          return result;
        }

        await member.roles.add(memberRoleId);
        await member.roles.add(lifetimeRoleId);

        webinarRow.is_used = 'True';
        webinarRow.discord_id = discordUser.id;
        webinarRow.discord_username = discordUser.tag;
        writeWebinarCsv(webinarRows);

        appendBotLog('INFO', 'Webinar activation successful', {
          userId: discordUser.id,
          uuid,
          email: webinarRow.email
        });

        result = { success: true, code: 'OK', orderId: 'WEBINAR' };
        return result;
      }
    } finally {
      releaseLock(WEBINAR_LOCK_PATH);
    }

    // ─────────────────────────────────────────────
    // 2️⃣ FALL THROUGH TO WOO LOGIC (UNCHANGED)
    // ─────────────────────────────────────────────
    const found = await woocommerce.findOrderByUUID(uuid);
    if (!found) {
      result = { success: false, code: 'NOT_FOUND' };
      return result;
    }

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(discordUser.id).catch(() => null);
    if (!member) {
      result = { success: false, code: 'NOT_IN_GUILD' };
      return result;
    }

    const roleId = process.env.MEMBER_ROLE_ID;
    if (!roleId) {
      result = { success: false, code: 'NO_ROLE_CONFIG' };
      return result;
    }

    await member.roles.add(roleId);

    // Grant an additional lifetime role if the purchased product name contains 'lifetime' (case-insensitive)
    try {
      const lifetimeRoleId = process.env.LIFETIME_ROLE_ID;
      const hasLifetimeProduct = (found?.order?.line_items || []).some(li => typeof li.name === 'string' && /lifetime/i.test(li.name));
      if (hasLifetimeProduct) {
        if (!lifetimeRoleId) {
          appendBotLog('WARN', 'LIFETIME_ROLE_ID not configured but order indicates lifetime product', { orderId: found.orderId });
        } else {
          try {
            await member.roles.add(lifetimeRoleId);
            appendBotLog('INFO', 'Granted lifetime role to member', { userId: discordUser.id, orderId: found.orderId, lifetimeRoleId });
          } catch (lrErr) {
            appendBotLog('ERROR', 'Failed to add lifetime role', { userId: discordUser.id, orderId: found.orderId, lifetimeRoleId, error: lrErr.message });
          }
        }
      }
    } catch (e) {
      appendBotLog('WARN', 'Error while checking/granting lifetime role', { error: e.message });
    }

    try {
      await woocommerce.updateOrderMemberData(found.orderId, [
        { key: 'activation_used', value: '1' },
        { key: 'activation_used_at', value: new Date().toISOString() },
        { key: 'discord_id', value: discordUser.id },
        { key: 'discord_username', value: discordUser.tag }
      ]);
      result = { success: true, code: 'OK', orderId: found.orderId };
    } catch (err) {
      appendBotLog('ERROR', 'Failed to update WC order after activation (modal/button)', { orderId: found.orderId, userId: discordUser.id, error: err.message });
      await logCritical('Activation WC Update Failed', { orderId: found.orderId, userId: discordUser.id, error: err.message });
      result = { success: false, code: 'WC_UPDATE_FAILED', error: err.message, orderId: found.orderId };
    }
  } catch (e) {
    appendBotLog('ERROR', 'Error during activation helper', { userId: discordUser.id, error: e.message });
    result = { success: false, code: 'ERROR', error: e.message };
  } finally {
    // Log attempt to activation log channel if configured
    try {
      if (ACTIVATION_LOG_CHANNEL_ID && client.user) {
        const ch = await client.channels.fetch(ACTIVATION_LOG_CHANNEL_ID).catch(() => null);
        if (ch?.isTextBased()) {
          const embed = new EmbedBuilder()
            .setTitle('Activation Attempt')
            .setColor(result.success ? 0x00ff00 : 0xffcc00)
            .addFields(
              { name: 'User', value: `${attempt.userTag} (${attempt.userId})`, inline: true },
              { name: 'UUID', value: `${attempt.uuid}`, inline: true },
              { name: 'Result', value: `${result.success ? 'SUCCESS' : 'FAIL'} (${result.code})`, inline: true }
            )
            .setTimestamp();
          if (result.orderId) embed.addFields({ name: 'Order ID', value: `${result.orderId}`, inline: true });
          if (result.error) embed.addFields({ name: 'Error', value: `${result.error}` });
          await ch.send({ embeds: [embed] }).catch(() => null);
        }
      }
    } catch (logErr) {
      appendBotLog('WARN', 'Failed to send activation attempt log to channel', { error: logErr.message });
    }
    return result;
  }
}

// Post a persistent activation message with a button to the configured activation channel
async function postActivationMessage() {
  if (!process.env.ACTIVATION_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(process.env.ACTIVATION_CHANNEL_ID).catch(() => null);
    if (!ch?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTitle('Aktivasi keanggotaan Crypto Teknikal Academy kamu')
      .setDescription('Klik tombol dibawah dan isi kode aktivasi yang kamu dapatkan saat pembelian untuk mengaktivasi keanggotaan kamu')
      .setColor(0x00AAFF)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open-activate-modal').setLabel('Aktivasi sekarang').setStyle(ButtonStyle.Primary)
    );

    // Send message and keep it — admins can pin it if desired
    await ch.send({ embeds: [embed], components: [row] });
    appendBotLog('INFO', 'Posted activation message to channel', { channelId: process.env.ACTIVATION_CHANNEL_ID });
  } catch (e) {
    appendBotLog('WARN', 'Could not post activation message', { error: e.message });
  }
}

client.on('messageCreate', async (message) => {
  // ignore bots
  if (message.author?.bot) return;

  // simple ping command
  if (message.content === '!ping') {
    await message.reply('Pong!');
    appendBotLog('INFO', 'Ping command', { userId: message.author.id });
    return;
  }

  // Activation / membership commands via DM
  // Support several aliases for activate and an expiry-check command
  if (!message.guild) {
    const content = message.content?.trim();
    if (!content) return;
    const contentLower = content.toLowerCase();

    const activateAliases = ['/activate', '.activate', '!activate', '/act', '.act', '!act'];
    const expiryAliases = ['/expiry', '.expiry', '!expiry', '/exp', '.exp', '!exp', '/expires', '.expires', '!expires', '/membership', '.membership', '!membership', '/member', '.member', '!member'];

    // Activation aliases
    for (const a of activateAliases) {
      if (contentLower.startsWith(a)) {
        const parts = content.split(/\s+/);
        const uuid = parts[1];
        if (!uuid) {
          await message.reply('Usage: /activate {UUID} — please provide the activation code you received at checkout.');
          return;
        }

        try {
          await message.reply('Checking your activation code...');
          const result = await activateOrderForDiscordUser(uuid, message.author);

          if (!result.success) {
            switch (result.code) {
              case 'NOT_FOUND':
                await message.reply('No valid order found for that code, or it has already been used. If you believe this is an error, contact support.');
                break;
              case 'ALREADY_USED':
                await message.reply('No valid order found for that code, or it has already been used. If you believe this is an error, contact support.');
                break;
              case 'NOT_IN_GUILD':
                await message.reply('Please join the server using the permanent invite link first, then run /activate {UUID} again.');
                break;
              case 'NO_ROLE_CONFIG':
                await message.reply('Server role is not configured (MEMBER_ROLE_ID). Contact the admins.');
                break;
              case 'WC_UPDATE_FAILED':
                await message.reply('Activation succeeded but failed to persist to WooCommerce. Admins have been alerted.');
                break;
              default:
                await message.reply('An error occurred while activating your code. Please try again later or contact support.');
            }
            return;
          }

          appendBotLog('INFO', 'Member activation successful', { userId: message.author.id, orderId: result.orderId });
          await message.reply('Activation successful — your role has been granted. Welcome!');
        } catch (e) {
          appendBotLog('ERROR', 'Error during activation flow', { userId: message.author.id, error: e.message });
          await message.reply('An error occurred while activating your code. Please try again later or contact support.');
        }
        return;
      }
    }

    // Note: we still support the button/modal flow via interactions

    // Expiry check aliases
    for (const ex of expiryAliases) {
      if (contentLower.startsWith(ex)) {
        try {
          await message.reply('Checking your membership status...');
          const order = await woocommerce.findActiveOrderByDiscordId(message.author.id);
          if (!order) {
            await message.reply('No active membership found for your account. If you believe this is an error, contact support.');
            return;
          }

          const meta = order.meta_data || [];
          const expiryMeta = meta.find(m => m.key === 'expiry_date');
          if (!expiryMeta || !expiryMeta.value) {
            await message.reply('An active membership was found but no expiry date is recorded. Contact support.');
            return;
          }

          const tzOffsetHours = parseInt(process.env.TZ_OFFSET_HOURS || '7', 10);
          const nowAdj = new Date(Date.now() + tzOffsetHours * 60 * 60 * 1000);
          const expiryDate = new Date(expiryMeta.value);
          const diffMs = expiryDate.getTime() - nowAdj.getTime();
          const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
          const expiryIso = expiryDate.toISOString().slice(0, 10);

          const replyMsg = `Your membership expires on ${expiryIso} (UTC${tzOffsetHours >= 0 ? '+' : ''}${tzOffsetHours}). ${daysLeft >= 0 ? `${daysLeft} day(s) remaining.` : `Expired ${Math.abs(daysLeft)} day(s) ago.`}`;
          await message.reply(replyMsg);
          appendBotLog('INFO', 'Membership expiry queried', { userId: message.author.id, orderId: order.id, expiry: expiryIso, daysLeft });
        } catch (e) {
          appendBotLog('ERROR', 'Error checking membership expiry', { userId: message.author.id, error: e.message });
          await message.reply('An error occurred while checking your membership. Try again later.');
        }
        return;
      }
    }
  }
});

// --- INTERACTION HANDLERS (buttons + modals) ---
client.on('interactionCreate', async (interaction) => {
  try {
    // Button: open the activation modal
    if (interaction.isButton() && interaction.customId === 'open-activate-modal') {
      const modal = new ModalBuilder()
        .setCustomId('activate-modal')
        .setTitle('Enter your activation code');

      const input = new TextInputBuilder()
        .setCustomId('activation_uuid')
        .setLabel('Activation code (UUID)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 3f6b9d7a-...')
        .setRequired(true);

      const row = new ActionRowBuilder().addComponents(input);
      modal.addComponents(row);

      await interaction.showModal(modal);
      return;
    }

    // Modal submit: process activation
    if (interaction.isModalSubmit() && interaction.customId === 'activate-modal') {
      const uuid = interaction.fields.getTextInputValue('activation_uuid').trim();
      await interaction.deferReply({ ephemeral: true });

      try {
        const result = await activateOrderForDiscordUser(uuid, interaction.user);
        if (!result.success) {
          if (result.code === 'NOT_FOUND') {
            await interaction.editReply('No valid order found for that code, or it has already been used.');
            return;
          }
          if (result.code === 'ALREADY_USED') {
            await interaction.editReply('No valid order found for that code, or it has already been used.');
            return;
          }
          if (result.code === 'NOT_IN_GUILD') {
            await interaction.editReply('You must join the server first before activating.');
            return;
          }
          if (result.code === 'NO_ROLE_CONFIG') {
            await interaction.editReply('Server not configured correctly. Contact admins.');
            return;
          }
          if (result.code === 'WC_UPDATE_FAILED') {
            await interaction.editReply('Activation succeeded but failed to persist to WooCommerce. Admins have been alerted.');
            return;
          }
          await interaction.editReply('An error occurred while activating your code. Please try again later.');
          return;
        }

        // Optionally post a short-lived channel message (controlled by env)
        const showUuid = process.env.SHOW_UUID_IN_CHANNEL === 'true';
        const ttl = parseInt(process.env.ACTIVATION_TEMP_MSG_TTL || '8', 10) * 1000;
        if (process.env.ACTIVATION_CHANNEL_ID) {
          try {
            const ch = await client.channels.fetch(process.env.ACTIVATION_CHANNEL_ID).catch(() => null);
            if (ch?.isTextBased()) {
              const content = showUuid
                ? interaction.user.tag + ' submitted code: `' + uuid + '`'
                : interaction.user.tag + ' submitted an activation code';
              const sent = await ch.send({ content });
              // remove the message after TTL to reduce exposure
              setTimeout(() => sent.delete().catch(() => null), ttl);
            }
          } catch (e) {
            appendBotLog('WARN', 'Failed to post temporary activation message', { error: e.message });
          }
        }

        await interaction.editReply('Activation successful — your role has been granted. Welcome!');
      } catch (e) {
        appendBotLog('ERROR', 'Error processing activation modal submit', { userId: interaction.user.id, error: e.message });
        await interaction.editReply('An unexpected error occurred. Please try again later.');
      }
      return;
    }
  } catch (e) {
    appendBotLog('ERROR', 'Error handling interaction', { error: e.message });
  }
});

// --- NEW MEMBER JOINS ---
client.on("guildMemberAdd", async (member) => {
  try {
    // Log join to audit channel (no invite detection)
    try {
      const auditChannel = await member.guild.channels.fetch(process.env.AUDIT_CHANNEL_ID);
      if (auditChannel?.isTextBased()) {
        const createdTimestamp = member.user.createdTimestamp;
        const accountAge = Math.floor((Date.now() - createdTimestamp) / (1000 * 60 * 60 * 24)); // in days

        const embed = new EmbedBuilder()
          .setColor(0x00ff00)
          .setTitle('New Member Joined')
          .setThumbnail(member.user.displayAvatarURL())
          .addFields(
            { name: 'Member', value: `${member.user.tag} (${member.user.id})`, inline: true },
            { name: 'Account Created', value: `<t:${Math.floor(createdTimestamp / 1000)}:R>`, inline: true },
            { name: 'Account Age', value: `${accountAge} days`, inline: true }
          )
          .setTimestamp()
          .setFooter({ text: `Member #${member.guild.memberCount}` });

        // Add custom profile data if available (e.g., linked roles, badges, etc.)
        const flags = member.user.flags?.toArray() || [];
        if (flags.length > 0) {
          embed.addFields({ name: 'User Badges', value: flags.join(', '), inline: false });
        }

        // Add any roles the member received on join
        if (member.roles.cache.size > 1) { // >1 because everyone has @everyone
          const roles = member.roles.cache
            .filter(role => role.id !== member.guild.id) // Filter out @everyone
            .map(role => role.name)
            .join(', ');
          if (roles) embed.addFields({ name: 'Initial Roles', value: roles, inline: false });
        }

        await auditChannel.send({ embeds: [embed] });
        appendBotLog('INFO', 'Member join logged to audit channel', { userId: member.user.id, tag: member.user.tag });
      }
    } catch (e) {
      appendBotLog('WARN', 'Could not log to audit channel', { error: e.message });
    }

    // Send welcome message (best-effort)
    try {
      const welcomeChannel = await member.guild.channels.fetch(process.env.WELCOME_CHANNEL_ID);
      if (welcomeChannel?.isTextBased()) {
        welcomeChannel.send(`👋 Welcome ${member.user}, thanks for joining!`);
      }
    } catch (e) {
      appendBotLog('WARN', 'Could not send welcome message', { error: e.message });
    }
  } catch (err) {
    appendBotLog('ERROR', 'Error processing guildMemberAdd', { userId: member.user?.id, error: err.message });
  }
});

// --- MODERATION FUNCTIONS ---
async function logModAction(guild, action, member, reason, moderator = 'SYSTEM') {
  try {
    const modLogChannel = await guild.channels.fetch(process.env.MOD_LOG_CHANNEL_ID);
    if (!modLogChannel?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle(`Member ${action}`)
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: 'Member', value: `${member.user.tag} (${member.user.id})`, inline: true },
        { name: 'Action', value: action, inline: true },
        { name: 'Moderator', value: moderator, inline: true },
        { name: 'Reason', value: reason || 'No reason provided', inline: false },
        { name: 'Joined At', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true }
      )
      .setTimestamp();

    await modLogChannel.send({ embeds: [embed] });
    appendBotLog('INFO', `Moderation action: ${action}`, { memberId: member.user.id, reason, moderator });
    return true;
  } catch (e) {
    appendBotLog('WARN', 'Could not log moderation action', { error: e.message });
    return false;
  }
}

async function removeMember(guild, userId, reason = '', moderator = 'SYSTEM') {
  try {
    const member = await guild.members.fetch(userId);
    if (!member) {
      return { success: false, error: 'Member not found' };
    }
    
    // Remove the membership role instead of kicking the user (exclusive role model)
    const roleId = process.env.MEMBER_ROLE_ID;
    if (!roleId) {
      appendBotLog('ERROR', 'MEMBER_ROLE_ID not configured', { userId });
      return { success: false, error: 'Server not configured' };
    }

    // Remove role if present
    let removed = false;
    try {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, reason);
        removed = true;
      } else {
        // Role not assigned; still treat as success but note it
        appendBotLog('WARN', 'Member did not have membership role', { userId });
      }
    } catch (remErr) {
      appendBotLog('ERROR', 'Could not remove membership role', { userId, roleId, error: remErr.message });
      try {
        await logCritical('Membership Role Removal Failed', { userId, roleId, error: remErr.message, reason, moderator });
      } catch (lcErr) {
        appendBotLog('WARN', 'Failed to send critical alert for role removal', { error: lcErr.message });
      }
      return { success: false, error: remErr.message };
    }

    // Record the moderation action in the mod-log (role removal)
    await logModAction(guild, 'Membership Removed', member, reason, moderator);

    appendBotLog('INFO', 'Member membership role removed', { userId, removed, reason, moderator });

    return {
      success: true,
      member: {
        id: member.user.id,
        tag: member.user.tag,
        joinedAt: member.joinedTimestamp,
        roleRemoved: removed
      }
    };
  } catch (e) {
    appendBotLog('ERROR', 'Error in kickMember (role removal)', { userId, error: e.message });
    return { success: false, error: e.message };
  }
}

// --- MODERATION API ENDPOINTS ---
app.post("/mod/remove", async (req, res) => {
  try {
    const { user_id, reason } = req.body;

    const authHeader = req.headers["x-api-key"];

    // 🔒 Validate the shared secret
    if (authHeader !== process.env.DISCORD_API_SECRET) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    if (!user_id) {
      return res.status(400).json({ success: false, error: 'user_id is required' });
    }

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const result = await removeMember(guild, user_id, reason || 'Role removed via API', 'API');

    res.json(result);
  } catch (err) {
    console.error("❌ Error in kick API:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

function getDateWithOffset(daysFromNow = 0) {
  const tzOffsetHours = parseInt(process.env.TZ_OFFSET_HOURS || '7', 10);
  const date = new Date(Date.now() + tzOffsetHours * 60 * 60 * 1000);
  date.setDate(date.getDate() + daysFromNow);
  return date;
}

function parseMembershipDuration(productName) {
  const name = productName.toLowerCase();

  if (name.includes('3 bulan')) {
    return {
      label: '3 Bulan',
      months: 3,
      renewUrl: 'https://s.id/PerpanjangCTA_3-Bulan'
    };
  }

  if (name.includes('1 tahun') || name.includes('12 bulan')) {
    return {
      label: '1 Tahun',
      months: 12,
      renewUrl: 'https://s.id/PerpanjangCTA_1-Tahun'
    };
  }

  return null; // manual review / unknown
}

function formatDateIndonesia(date) {
  const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const months = [
    'Januari','Februari','Maret','April','Mei','Juni',
    'Juli','Agustus','September','Oktober','November','Desember'
  ];

  const d = new Date(date);
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function buildReminderMessage({ firstName, durationLabel, expiryDateFormatted, renewUrl }) {
  return `
Halo ${firstName},

Keanggotaan **Crypto Teknikal Academy** kamu yang berdurasi **${durationLabel}** akan habis pada esok hari, yaitu **${expiryDateFormatted}**.
Segera lakukan perpanjang membership kamu sebelum habis!

Untuk kamu yang ingin perpanjang, bisa gunakan kode voucher **MEMBER10** untuk mendapatkan diskon 10% saat perpanjang keanggotaan kamu.

👉 **Perpanjang Keanggotaan Kamu Disini**
${renewUrl}

Jika link di atas tidak bisa diklik, silakan copy & paste ke browser kamu.
`;
}

function buildEmailContent({ firstName, durationLabel, expiryDateFormatted, renewUrl }) {
  return `
    <p>Halo ${firstName},</p>

    <p>Keanggotaan <strong>Crypto Teknikal Academy</strong> kamu yang berdurasi <strong>${durationLabel}</strong> akan habis pada esok hari, yaitu <strong>${expiryDateFormatted}</strong>. Segera lakukan perpanjang membership kamu sebelum habis!</p>

    <p>Untuk kamu yang ingin perpanjang, bisa gunakan kode voucher <strong>MEMBER10</strong> untuk mendapatkan diskon 10% saat perpanjang keanggotaan kamu.</p>

    <p>
      <a href="${renewUrl}" style="
        display:inline-block;
        padding:10px 18px;
        font-size:16px;
        color:#fff;
        background-color:#5865F2;
        text-decoration:none;
        border-radius:6px;
      ">👉 Perpanjang Keanggotaan Kamu Disini</a>
    </p>

    <p>Jika tombol di atas tidak berfungsi, bisa klik link di sini: <a href="${renewUrl}">${renewUrl}</a></p>
  `;
}

async function sendExpiryReminderEmail({ firstName, email, durationLabel, expiryDateFormatted, renewUrl }) {
  if (!email) return { success: false, reason: 'NO_EMAIL' };

  const htmlContent = buildEmailContent({ firstName, durationLabel, expiryDateFormatted, renewUrl });

  appendBotLog('DEBUG', 'Email HTML preview', {
    email,
    htmlLength: htmlContent.length
  });

  const payload = new URLSearchParams({
    from_name: process.env.MAIL_FROM_NAME,
    from_email: process.env.MAIL_FROM_EMAIL,
    recipient: email,
    subject: '⚠️ Reminder: Keanggotaan CTA Anda Akan Habis Besok',
    content: htmlContent,
    attach1: '',
    attach2: '',
    attach3: '',
    api_token: process.env.MAIL_API_TOKEN
  });

  try {
    const response = await axios.post(
      'https://api.mailketing.co.id/api/v1/send',
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 15000
      }
    );

    appendBotLog('INFO', 'Expiry reminder email sent', { email, apiResponse: response.data });
    return { success: true };
  } catch (err) {
    appendBotLog('ERROR', 'Failed to send expiry reminder email', { email, error: err.message });
    return { success: false, error: err.message };
  }
}

async function sendExpiryReminderDMAndEmail(order) {
  const meta = order.meta_data || [];
  const discordId = meta.find(m => m.key === 'discord_id')?.value;
  const firstName =
    order.billing?.first_name ||
    'Member';

  const item = order.line_items?.[0];
  if (!item) {
    appendBotLog('WARN', 'Reminder skipped — no line item', { orderId: order.id });
    return { success: false };
  }

  const membership = parseMembershipDuration(item.name);
  if (!membership) {
    appendBotLog('WARN', 'Reminder skipped — unknown product duration', {
      orderId: order.id,
      productName: item.name
    });
    return { success: false };
  }

  const orderExpiry = meta.find(m => m.key === 'expiry_date')?.value;
  const expiryDate = new Date(orderExpiry);
  const expiryFormatted = formatDateIndonesia(expiryDate);

  if (order.billing?.email) {
    await sendExpiryReminderEmail({
      firstName,
      email: order.billing.email,
      durationLabel: membership.label,
      expiryDateFormatted: expiryFormatted,
      renewUrl: membership.renewUrl
    });
  }

  if (!discordId) {
    appendBotLog('WARN', 'Reminder skipped — NO DISCORD ID', { orderId: order.id });
    return { success: false, reason: 'NO_DISCORD_ID' };
  }

  try {
    const user = await client.users.fetch(discordId);
    if (!user) throw new Error('User not found');

    const message = buildReminderMessage({
      firstName,
      durationLabel: membership.label,
      expiryDateFormatted: expiryFormatted,
      renewUrl: membership.renewUrl
    });

    await user.send(message);

    appendBotLog('INFO', 'Expiry reminder DM sent', {
      orderId: order.id,
      discordId,
      duration: membership.label
    });

    return { success: true };
  } catch (err) {
    appendBotLog('ERROR', 'Failed to send expiry reminder DM', {
      orderId: order.id,
      discordId,
      error: err.message
    });

    return { success: false, error: err.message };
  }
}

async function runExpiryReminder() {
  appendBotLog('INFO', 'Running expiry reminder (tomorrow)...');

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    // Find orders expiring today using a fixed timezone offset (default UTC+7)
    const tomorrow = getDateWithOffset(1);

    const expiringTomorrow = await woocommerce.findOrdersExpiringOn(tomorrow);
    appendBotLog(
      'INFO',
      `Found ${expiringTomorrow.length} orders expiring tomorrow`,
      { count: expiringTomorrow.length, date: tomorrow.toISOString().slice(0, 10) }
    );

    if (!ADMIN_LOG_CHANNEL_ID || !client.user) return;

    const channel = await client.channels.fetch(ADMIN_LOG_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased()) return;

    if (expiringTomorrow.length === 0) {
      await channel.send(
        `🟢 **Expiry Reminder**\nNo memberships expiring tomorrow (${tomorrow.toISOString().slice(0, 10)})`
      );
      return;
    }

    let buffer = `⏳ **Memberships Expiring Tomorrow** (${tomorrow.toISOString().slice(0, 10)})\n`;

    for (const order of expiringTomorrow) {
      const meta = order.meta_data || [];
      const discordId = meta.find(m => m.key === 'discord_id')?.value || 'N/A';
      const expiry = meta.find(m => m.key === 'expiry_date')?.value || 'unknown';

      const warning = discordId === 'N/A' ? ' ⚠️' : '';
      const line = `• Order #${order.id} | Discord: ${discordId} | Expiry: ${expiry}${warning}\n`;

      if ((buffer + line).length > 1800) {
        await channel.send(buffer);
        buffer = '';
      }
      buffer += line;
      if (order.id == 8311 || order.id == 8312) {
        await sendExpiryReminderDMAndEmail(order);
      }
    }

    if (buffer.trim()) {
      await channel.send(buffer);
    }

    return { success: true, count: expiringTomorrow.length };
  } catch (err) {
    appendBotLog('ERROR', 'Expiry reminder failed', { error: err.message });
    return { success: false, error: err.message };
  }
}

// --- AUTO-KICK JOB (runs daily) ---
async function runExpiryCheck() {
  appendBotLog('INFO', 'Running expiry check...');

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);

    // Find orders expiring today using a fixed timezone offset (default UTC+7)
    const tzOffsetHours = parseInt(process.env.TZ_OFFSET_HOURS || '7', 10);
    const today = new Date(Date.now() + tzOffsetHours * 60 * 60 * 1000);
    appendBotLog('INFO', `Using timezone offset for expiry check`, { tzOffsetHours, iso: today.toISOString().slice(0,10) });
    const expiringOrders = await woocommerce.findOrdersExpiringOn(today);
    appendBotLog('INFO', `Found ${expiringOrders.length} orders expiring today`, { count: expiringOrders.length });
    // --- ADMIN LOG: EXPIRING ORDERS (PLAIN TEXT) ---
    try {
      if (ADMIN_LOG_CHANNEL_ID && client.user) {
        const channel = await client.channels.fetch(ADMIN_LOG_CHANNEL_ID).catch(() => null);
        if (!channel?.isTextBased()) return;

        if (expiringOrders.length === 0) {
          await channel.send(
            `🟢 **Expiry Check**\nNo memberships expiring today (${today.toISOString().slice(0, 10)})`
          );
          return;
        }

        const header = `⏰ **Expiry Check — ${expiringOrders.length} Orders Expiring Today** (${today.toISOString().slice(0, 10)})\n`;
        let buffer = header;

        for (const order of expiringOrders) {
          const meta = order.meta_data || [];
          const discordId = meta.find(m => m.key === 'discord_id')?.value || 'N/A';
          const expiry = meta.find(m => m.key === 'expiry_date')?.value || 'unknown';

          const warning = discordId === 'N/A' ? ' ⚠️' : '';
          const line = `• Order #${order.id} | Discord: ${discordId} | Expiry: ${expiry}${warning}\n`;

          // Flush if message would exceed Discord limit
          if ((buffer + line).length > 1800) {
            await channel.send(buffer);
            buffer = '';
          }

          buffer += line;
        }

        if (buffer.trim()) {
          await channel.send(buffer);
        }
      }
    } catch (err) {
      appendBotLog('WARN', 'Failed to send expiring orders log to chat', { error: err.message });
    }

    for (const order of expiringOrders) {
      try {
        const meta = order.meta_data || [];
        const discordMeta = meta.find(m => m.key === 'discord_id');
        const discordId = discordMeta?.value;
        if (!discordId) {
          appendBotLog('WARN', 'Order expiring but no discord_id meta', { orderId: order.id });
          continue;
        }

        // Check if user has a newer active order (e.g., renewed membership)
        const activeOrder = await woocommerce.findActiveOrderByDiscordId(discordId);
        if (activeOrder && activeOrder.id !== order.id) {
          // Found a newer active order — skip removal and mark this old order finished
          await woocommerce.markOrderFinished(order.id).catch(async err => {
            appendBotLog('ERROR', 'Failed to mark old order finished (newer active exists)', { orderId: order.id, discordId, newerOrderId: activeOrder.id, error: err.message });
          });
          appendBotLog('INFO', 'Skipped role removal — newer active order exists', { discordId, expiredOrderId: order.id, activeOrderId: activeOrder.id });
          
          // Send a notification to the admin log channel
          try {
            if (ADMIN_LOG_CHANNEL_ID && client.user) {
              const channel = await client.channels.fetch(ADMIN_LOG_CHANNEL_ID).catch(() => null);
              if (channel?.isTextBased()) {
                const embed = new EmbedBuilder()
                  .setColor(0x0099ff)
                  .setTitle('📝 Membership Renewal Detected')
                  .addFields(
                    { name: 'Discord ID', value: discordId, inline: true },
                    { name: 'Expired Order ID', value: `${order.id}`, inline: true },
                    { name: 'New Active Order ID', value: `${activeOrder.id}`, inline: true }
                  )
                  .setTimestamp()
                  .setFooter({ text: 'Renewal Alert' });
                await channel.send({ embeds: [embed] });
              }
            }
          } catch (err) {
            appendBotLog('WARN', 'Failed to send renewal alert to Discord', { error: err.message });
          }
          
          continue;
        }

        const result = await removeMember(guild, discordId, 'Membership expired');
        if (!result.success) {
          const msg = `Failed to remove membership role (expiry)`;
          appendBotLog('ERROR', msg, { discordId, orderId: order.id, error: result.error });
          await logCritical('Auto-Removal Failed', { discordId, orderId: order.id, reason: result.error });
          continue;
        }

        // After successful removal, mark order finished and is_old
        await woocommerce.markOrderFinished(order.id).catch(async err => {
          const msg = 'Failed to mark order finished after role removal';
          appendBotLog('ERROR', msg, { orderId: order.id, discordId, error: err.message });
          await logCritical('Mark Order Finished Failed', { orderId: order.id, discordId, error: err.message });
        });
        appendBotLog('INFO', 'Auto-removed membership role and marked order finished', { discordId, orderId: order.id });
      } catch (oe) {
        appendBotLog('ERROR', 'Error handling expiring order', { orderId: order.id, error: oe.message });
        await logCritical('Expiry Check Error', { orderId: order.id, error: oe.message });
      }
    }
    return { success: true, count: expiringOrders.length };
  } catch (err) {
    appendBotLog('ERROR', 'Error running expiry job', { error: err.message });
    await logCritical('Expiry Job Critical Error', { error: err.message });
    return { success: false, error: err.message };
  }
}

// Schedule daily run (default: 5:00 AM UTC; for UTC+7, that's 12:00 PM)
cron.schedule("0 5 * * *", runExpiryCheck);
cron.schedule("0 12 * * *", runExpiryReminder);

// Temporary test API to run expiry check on demand (protected)
app.post('/run-expiry-check', async (req, res) => {
  try {
    const authHeader = req.headers['x-api-key'];
    if (authHeader !== process.env.DISCORD_API_SECRET) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const result = await runExpiryCheck();
    return res.json(result);
  } catch (e) {
    appendBotLog('ERROR', 'Error in /run-expiry-check endpoint', { error: e.message });
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/run-expiry-reminder', async (req, res) => {
  try {
    const authHeader = req.headers['x-api-key'];
    if (authHeader !== process.env.DISCORD_API_SECRET) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const result = await runExpiryReminder();
    return res.json(result);
  } catch (e) {
    appendBotLog('ERROR', 'Error in /run-expiry-reminder endpoint', { error: e.message });
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(3000, () => {
  const msg = '🚀 Server running on port 3000';
  console.log(msg);
  appendBotLog('INFO', msg);
});