import { describe, expect, it } from 'vitest';
import appSource from '../App.tsx?raw';
import automaticDispatchSource from '../pages/AutomaticDispatchPage.tsx?raw';
import dispatchSource from '../pages/DispatchPage.tsx?raw';
import fleetSource from '../pages/FleetPage.tsx?raw';

const messageConsumers = [
  ['AutomaticDispatchPage', automaticDispatchSource],
  ['DispatchPage', dispatchSource],
  ['FleetPage', fleetSource],
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
