import React from 'react';
import { App as AntdApp } from 'antd';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../api/client';
import RetailAnalyticsPage from '../pages/RetailAnalyticsPage';

vi.mock('../api/client', () => ({
  apiClient: { get: vi.fn() },
}));

beforeAll(() => {
  const getComputedStyle = window.getComputedStyle.bind(window);
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => getComputedStyle(element),
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

describe('RetailAnalyticsPage', () => {
  it('renders a singular occupancy response as a table row', async () => {
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      const responses: Record<string, unknown> = {
        '/retail-analytics/financial-summary': {
          orderCount: 2,
          grossSales: '150000',
          payments: '100000',
          refunds: '0',
          netRevenue: '100000',
        },
        '/retail-analytics/funnel': {
          total: 2,
          byStatus: { CONFIRMED: 1, COMPLETED: 1 },
        },
        '/retail-analytics/fulfillment-performance': {
          totalFulfillments: 2,
          totalTasks: 2,
          completedTasks: 1,
          shortPickTasks: 0,
          completionRate: 50,
        },
        '/retail-analytics/occupancy': {
          locationId: 'location-1',
          totalSlots: 20,
          occupiedSlots: 3,
          availableSlots: 17,
          occupancyRate: 15,
        },
      };
      return { data: responses[url] };
    });

    render(
      <AntdApp>
        <RetailAnalyticsPage />
      </AntdApp>,
    );

    await waitFor(() => {
      expect(screen.getByText('3 / 20 kiện')).toBeInTheDocument();
    });
    expect(screen.getByText('location-1')).toBeInTheDocument();
  }, 15_000);
});
