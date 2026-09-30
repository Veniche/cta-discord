// Tests for woocommerce-service.js: every read bypasses the shop's LiteSpeed cache, which served stale
// settings (and can serve stale orders) to authenticated REST GETs.
import { fileURLToPath } from 'url';

const BOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
let fail = 0;
const check = (label, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fail++; };

process.env.WC_API_BASE = process.env.WC_API_BASE || 'https://shop.example';
process.env.WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY || 'ck_test';
process.env.WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET || 'cs_test';
const { WooCommerceService } = await import(BOT + '/woocommerce-service.js');
const svc = new WooCommerceService();
const sent = [];
svc.api._request = async (method, endpoint, data, params) => (sent.push({ method, endpoint, params }), { data: [], headers: {} });
await svc.api.get('orders/1');
await svc.api.get('orders/1');
await svc.api.get('orders', { status: 'completed', page: 2 });
check('every read carries a unique cache-busting parameter', sent.length === 3 && sent.every(r => r.params?._nocache) && new Set(sent.map(r => r.params._nocache)).size === 3);
check('the caller\'s own parameters are kept', sent[2].params.status === 'completed' && sent[2].params.page === 2);
await svc.api.put('orders/1', { status: 'completed' });
check('writes are not changed', sent[3].method === 'put' && !sent[3].params?._nocache);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
