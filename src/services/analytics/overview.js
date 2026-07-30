import { getSubscriberOverview } from './subscribers.js';
import { getRevenueOverview, getRevenueTrend, getRevenueByPackage } from './revenue.js';
import { getVoucherLifecycleCounts } from './vouchers.js';
import { getConnectedClients } from '../omada.js';

export async function getOverviewData() {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);

  const subscribers = getSubscriberOverview();
  const revenue = getRevenueOverview();
  const vouchersLifecycleToday = getVoucherLifecycleCounts({ from: today, to: today });
  const revenueTrend = getRevenueTrend({ from, to: today });
  const topPackages = getRevenueByPackage({ from, to: today });

  const [liveResult] = await Promise.allSettled([getConnectedClients()]);
  const live = liveResult.status === 'fulfilled'
    ? liveResult.value
    : { total: 0, clients: [], unavailable: true };

  return {
    subscribers,
    revenue,
    vouchersToday: vouchersLifecycleToday.sold,
    live,
    revenueTrend,
    topPackages,
  };
}
