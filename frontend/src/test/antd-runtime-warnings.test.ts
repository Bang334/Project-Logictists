import { describe, expect, it } from 'vitest';
import appSource from '../App.tsx?raw';
import catalogSource from '../pages/CatalogPage.tsx?raw';
import customerPortalSource from '../pages/CustomerPortalPage.tsx?raw';
import inventorySource from '../pages/InventoryPage.tsx?raw';
import orderProcessingSource from '../pages/OrderProcessingPage.tsx?raw';
import pickupPointOpsSource from '../pages/PickupPointOpsPage.tsx?raw';
import retailAnalyticsSource from '../pages/RetailAnalyticsPage.tsx?raw';
import retailOrdersSource from '../pages/RetailOrdersPage.tsx?raw';

const messageConsumers = [
  ['CatalogPage', catalogSource],
  ['CustomerPortalPage', customerPortalSource],
  ['InventoryPage', inventorySource],
  ['OrderProcessingPage', orderProcessingSource],
  ['PickupPointOpsPage', pickupPointOpsSource],
  ['RetailAnalyticsPage', retailAnalyticsSource],
  ['RetailOrdersPage', retailOrdersSource],
] as const;

describe('Ant Design runtime warning guardrails', () => {
  it('does not use Spin tip outside a nested or fullscreen pattern', () => {
    expect(appSource).not.toMatch(/<Spin\b[^>]*\btip=/);
  });

  for (const [name, source] of messageConsumers) {
    it(`${name} uses the App message instance instead of the static API`, () => {
      expect(source).toContain('App as AntdApp');
      expect(source).toContain('AntdApp.useApp()');
      expect(source).not.toMatch(
        /import\s*\{[\s\S]*?\bmessage\b[\s\S]*?\}\s*from\s*['"]antd['"]/,
      );
      expect(source).not.toMatch(
        /\bModal\.(confirm|info|success|error|warning)\s*\(/,
      );
    });
  }
});
