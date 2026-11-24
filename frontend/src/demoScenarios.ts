import catalog from '../../optimizer/benchmarks/demo/catalog.json';
import type { DemoCaseSummaryUI } from './types';

type Dataset = typeof import('../../optimizer/benchmarks/demo/demo_3d_danang_complex.json');
const datasets = import.meta.glob<Dataset>('../../optimizer/benchmarks/demo/*.json', {
  eager: true,
  import: 'default',
});

export const demoScenarios = Object.entries(catalog).map(([id, profile]) => {
  const filename = `${id}.json`;
  const request = datasets[`../../optimizer/benchmarks/demo/${filename}`];
  const packages = request.orders.flatMap((order) => order.items);
  const summary: DemoCaseSummaryUI = {
    id,
    filename,
    name: profile.name,
    description: profile.description,
    category: (profile.category as DemoCaseSummaryUI['category']) ?? 'SCENARIO',
    category_name: profile.category_name ?? 'Xếp chồng 3D & Đường bộ thực tế',
    orders_count: request.orders.length,
    vehicles_count: request.vehicles.length,
    drivers_count: request.drivers.length,
    supports_stacking: Boolean(request.demo_stacking),
    suggested_time_limit_sec: request.max_time_seconds,
    total_weight_kg: packages.reduce((sum, pkg) => sum + pkg.weight_kg, 0),
    total_volume_cbm: Number(
      (
        packages.reduce(
          (sum, pkg) => sum + pkg.length_cm * pkg.width_cm * pkg.height_cm,
          0,
        ) / 1_000_000
      ).toFixed(3),
    ),
  };
  return { summary, request };
});

export const demoCases = demoScenarios.map((demo) => demo.summary);
