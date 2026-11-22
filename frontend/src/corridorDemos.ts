import catalog from '../../optimizer/benchmarks/corridor/catalog.json';
import type { DemoCaseSummaryUI } from './types';

type Dataset = typeof import('../../optimizer/benchmarks/corridor/corridor_03_rotate.json');
const datasets = import.meta.glob<Dataset>('../../optimizer/benchmarks/corridor/corridor_*.json', {
  eager: true,
  import: 'default',
});

export const corridorDemos = Object.entries(catalog).map(([id, profile]) => {
  const filename = id + '.json';
  const request = datasets['../../optimizer/benchmarks/corridor/' + filename];
  const packages = request.orders.flatMap(order => order.items);
  const summary: DemoCaseSummaryUI = {
    id, filename, ...profile, category: 'SCENARIO', category_name: 'Xếp dỡ trên tuyến thẳng',
    orders_count: request.orders.length, vehicles_count: request.vehicles.length,
    drivers_count: request.drivers.length, supports_stacking: false,
    suggested_time_limit_sec: request.max_time_seconds,
    total_weight_kg: packages.reduce((sum, pkg) => sum + pkg.weight_kg, 0),
    total_volume_cbm: Number((packages.reduce((sum, pkg) =>
      sum + pkg.length_cm * pkg.width_cm * pkg.height_cm, 0) / 1_000_000).toFixed(3)),
  };
  return { summary, request };
});

export const demoCases = corridorDemos.map(demo => demo.summary);
