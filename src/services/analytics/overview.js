import { getSubscriberOverview } from './subscribers.js';
import { getRevenueOverview, getRevenueTrend, getRevenueByPackage } from './revenue.js';
import { getVoucherLifecycleCounts } from './vouchers.js';
import { getConnectedClients } from '../omada.js';

export async function getOverviewData() {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);

  const [subscribers, revenue, vouchersLifecycleToday, live, revenueTrend, topPackages] = await Promise.all([
    Promise.resolve(getSubscriberOverview()),
    Promise.resolve(getRevenueOverview()),
    Promise.resolve(getVoucherLifecycleCounts({ from: today, to: today })),
    getConnectedClients(),
    Promise.resolve(getRevenueTrend({ from, to: today })),
    Promise.resolve(getRevenueByPackage({ from, to: today })),
  ]);

  return {
    subscribers,
    revenue,
    vouchersToday: vouchersLifecycleToday.sold,
    live,
    revenueTrend,
    topPackages,
  };
}
