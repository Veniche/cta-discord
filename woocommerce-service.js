import WooCommerceRestApiModule from '@woocommerce/woocommerce-rest-api';
import fs from 'fs';
import path from 'path';

// Handle both default export and named export
const WooCommerceRestApi = WooCommerceRestApiModule.default || WooCommerceRestApiModule;

// --- WOOCOMMERCE SERVICE ---
export class WooCommerceService {
  constructor() {
    this.api = new WooCommerceRestApi({
      url: process.env.WC_API_BASE,
      consumerKey: process.env.WC_CONSUMER_KEY,
      consumerSecret: process.env.WC_CONSUMER_SECRET,
      version: 'wc/v3'
    });
  }

  async getOrdersTotal() {
    try {
      const response = await this.api.get('orders', { per_page: 1 });
      const total = response.headers['x-wp-total'] || 0;
      console.debug('WC getOrdersTotal ->', 'total:', total);
      appendWCLog({ event: 'getOrdersTotal', total });
      return parseInt(total, 10);
    } catch (error) {
      console.error('Error fetching orders total:', error.message);
      appendWCLog({ event: 'getOrdersTotal.error', error: error.message });
      throw error;
    }
  }

  async findOrderByUUID(uuid, uuidMetaKey = process.env.WC_UUID_META_KEY || 'activation_uuid') {
    try {
      const totalOrders = await this.getOrdersTotal();
      const totalPages = Math.max(1, Math.ceil(totalOrders / 100));
      console.debug('WC findOrderByUUID -> searching for UUID:', uuid);
      appendWCLog({ event: 'findOrderByUUID.start', uuid, totalOrders });

      for (let page = 1; page <= totalPages; page++) {
        const response = await this.api.get('orders', { per_page: 100, page });
        const orders = response.data || [];
        console.debug(`WC findOrderByUUID -> page ${page}: ${orders.length} orders`);

        for (const order of orders) {
          const metaData = order.meta_data || [];

          const matching = metaData.find(data => data.key === uuidMetaKey && `${data.value}` === `${uuid}`);
          if (!matching) continue;

          const isOldMeta = metaData.find(data => data.key === 'is_old');
          const isOldValue = isOldMeta && (isOldMeta.value === true || isOldMeta.value === 'true' || isOldMeta.value === 'True');
          if (isOldValue) {
            console.debug('Skipping old order:', order.id);
            return null; // stop searching entirely
          }

          // Ignore orders that are already claimed (have discord_id or activation_used)
          const claimed = metaData.some(d => d.key === 'discord_id' || d.key === 'activation_used');
          if (claimed) {
            console.debug('Found matching UUID but order already claimed:', order.id);
            return null; // stop searching entirely
          }

          console.debug('Found matching UUID on order:', order.id);
          appendWCLog({ event: 'findOrderByUUID.found', orderId: order.id, uuid });
          return { orderId: order.id, order };
        }
      }

      console.warn('No valid order found for UUID:', uuid);
      appendWCLog({ event: 'findOrderByUUID.notFound', uuid });
      return null;
    } catch (error) {
      console.error('Error finding order by UUID:', error.message);
      appendWCLog({ event: 'findOrderByUUID.error', error: error.message });
      throw error;
    }
  }

  async updateOrderMemberData(orderId, metadata = []) {
    try {
      const payload = {
        meta_data: metadata
      };
      console.debug('WC updateOrderMemberData ->', 'orderId:', orderId);
      const response = await this.api.put(`orders/${orderId}`, payload);
      console.debug('Updated order:', orderId);
      appendWCLog({ event: 'updateOrderMemberData.success', orderId });
      return response.data;
    } catch (error) {
      console.error('Error updating order:', error.message);
      appendWCLog({ event: 'updateOrderMemberData.error', orderId, error: error.message });
      throw error;
    }
  }

  // Find a non-old order associated with a Discord user (by discord_id meta)
  async findActiveOrderByDiscordId(discordId) {
    try {
      const totalOrders = await this.getOrdersTotal();
      const totalPages = Math.max(1, Math.ceil(totalOrders / 100));
      appendWCLog({ event: 'findActiveOrderByDiscordId.start', discordId, totalOrders });

      for (let page = 1; page <= totalPages; page++) {
        const response = await this.api.get('orders', { per_page: 100, page, status: 'completed' });
        const orders = response.data || [];

        for (const order of orders) {
          const metaData = order.meta_data || [];

          const isOldMeta = metaData.find(data => data.key === 'is_old');
          const isOldValue = isOldMeta && (isOldMeta.value === true || isOldMeta.value === 'true' || isOldMeta.value === 'True' || isOldMeta.value === '1');
          if (isOldValue) continue;

          const discordMeta = metaData.find(d => d.key === 'discord_id' && `${d.value}` === `${discordId}`);
          if (discordMeta) {
            appendWCLog({ event: 'findActiveOrderByDiscordId.found', orderId: order.id, discordId });
            return order;
          }
        }
      }

      appendWCLog({ event: 'findActiveOrderByDiscordId.notFound', discordId });
      return null;
    } catch (error) {
      appendWCLog({ event: 'findActiveOrderByDiscordId.error', discordId, error: error.message });
      throw error;
    }
  }

  // Fetch every order with the given status in one pass (newest first), retrying transient
  // failures (429 / 5xx / network) so one hiccup doesn't abort the daily expiry run.
  // `params` adds query filters, e.g. { modified_after: ISO } (ignored by WooCommerce < 5.8).
  async getAllOrders(status = 'completed', params = {}) {
    const perPage = 100;
    const all = [];
    for (let page = 1; ; page++) {
      let response;
      for (let attempt = 1; ; attempt++) {
        try {
          response = await this.api.get('orders', { per_page: perPage, page, status, orderby: 'date', order: 'desc', ...params });
          break;
        } catch (error) {
          const code = error.response?.status;
          const transient = !code || code === 429 || code >= 500;
          if (!transient || attempt >= 4) {
            appendWCLog({ event: 'getAllOrders.error', status, page, attempt, code, error: error.message });
            throw error;
          }
          await new Promise(res => setTimeout(res, 2000 * attempt));
        }
      }
      const orders = response.data || [];
      all.push(...orders);
      const totalPages = parseInt(response.headers?.['x-wp-totalpages'] || '0', 10);
      if (orders.length < perPage || (totalPages && page >= totalPages)) break;
    }
    appendWCLog({ event: 'getAllOrders', status, ...params, count: all.length });
    return all;
  }

  // Every order regardless of status, for read-only reports. 'any' can leave out custom statuses that
  // aren't registered as searchable (such as 'finished'), so those are fetched explicitly and merged.
  async getAllOrdersAnyStatus(extraStatuses = ['finished']) {
    const byId = new Map();
    for (const o of await this.getAllOrders('any')) byId.set(o.id, o);
    const seen = new Set([...byId.values()].map(o => o.status));
    for (const status of extraStatuses.filter(st => !seen.has(st))) {
      const orders = await this.getAllOrders(status).catch(error => {
        appendWCLog({ event: 'getAllOrdersAnyStatus.skipped', status, error: error.message });
        return [];
      });
      for (const o of orders) byId.set(o.id, o);
    }
    return [...byId.values()];
  }

  // Find orders that expire on the given date (local date comparison)
  async findOrdersExpiringOn(targetDate) {
    const isoTarget = new Date(targetDate).toISOString().slice(0, 10); // YYYY-MM-DD
    const totalOrders = await this.getOrdersTotal();
    const totalPages = Math.max(1, Math.ceil(totalOrders / 100));
    const matches = [];

    for (let page = 1; page <= totalPages; page++) {
      const response = await this.api.get('orders', { per_page: 100, page, status: 'completed' });
      const orders = response.data || [];

      for (const order of orders) {
        const metaData = order.meta_data || [];

        const isOldMeta = metaData.find(m => m.key === 'is_old');
        const isOld = isOldMeta && (isOldMeta.value === true || isOldMeta.value === 'true' || isOldMeta.value === 'True' || isOldMeta.value === '1');
        if (isOld) continue;

        const expiryMeta = metaData.find(m => m.key === 'expiry_date');
        if (!expiryMeta || !expiryMeta.value) continue;

        // Normalize expiry date value and compare YYYY-MM-DD
        const expiryIso = new Date(expiryMeta.value).toISOString().slice(0, 10);
        if (expiryIso === isoTarget) {
          matches.push(order);
        }
      }
    }

    return matches;
  }

  // Mark an order finished, set is_old, and record that its Discord side is done
  // (discord_role_removed_at: status/is_old are shared with the Telegram expiry checker).
  async markOrderFinished(orderId) {
    try {
      const payload = {
        status: 'finished',
        meta_data: [
          { key: 'is_old', value: 'True' },
          { key: 'discord_role_removed_at', value: new Date().toISOString() }
        ]
      };
      const response = await this.api.put(`orders/${orderId}`, payload);
      appendWCLog({ event: 'markOrderFinished', orderId });
      return response.data;
    } catch (error) {
      appendWCLog({ event: 'markOrderFinished.error', orderId, error: error.message });
      throw error;
    }
  }
}

// Debug helper: append WooCommerce operation details to a local file
const WC_DEBUG_FILE = process.env.WC_DEBUG_FILE || path.join(process.cwd(), 'wc-debug.log');

export function appendWCLog(entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(WC_DEBUG_FILE, line);
  } catch (e) {
    console.warn('Failed to write WC debug file:', e.message);
  }
}
