import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mapboxMocks = vi.hoisted(() => {
  const mapInstances: Array<{ removed: boolean }> = [];
  const markerInstances: Array<{
    element?: HTMLElement;
    addedMap?: object;
    removed: boolean;
  }> = [];

  class MockBounds {
    private empty = true;

    extend() {
      this.empty = false;
      return this;
    }

    isEmpty() {
      return this.empty;
    }
  }

  class MockMap {
    sources = new globalThis.Map<string, { setData: () => void }>();
    layers = new Set<string>();
    removed = false;

    constructor() {
      mapInstances.push(this);
    }

    addControl() {}
    resize() {}
    remove() { this.removed = true; }
    isStyleLoaded() { return true; }
    once(_event: string, callback: () => void) { callback(); }
    addSource(id: string) { this.sources.set(id, { setData: () => {} }); }
    getSource(id: string) { return this.sources.get(id); }
    addLayer(layer: { id: string }) { this.layers.add(layer.id); }
    getLayer(id: string) { return this.layers.has(id) ? { id } : undefined; }
    setPaintProperty() {}
    fitBounds() {}
  }

  class MockMarker {
    readonly element?: HTMLElement;
    addedMap?: MockMap;
    removed = false;

    constructor(options?: { element?: HTMLElement }) {
      this.element = options?.element;
      markerInstances.push(this);
    }

    setLngLat() { return this; }
    setPopup() { return this; }
    addTo(map: MockMap) {
      this.addedMap = map;
      return this;
    }
    remove() { this.removed = true; }
    togglePopup() {}
  }

  return { mapInstances, markerInstances, MockBounds, MockMap, MockMarker };
});

vi.mock('mapbox-gl', () => ({
  default: {
    Map: mapboxMocks.MockMap,
    Marker: mapboxMocks.MockMarker,
    Popup: class {
      setDOMContent() { return this; }
    },
    LngLatBounds: mapboxMocks.MockBounds,
    NavigationControl: class {},
    FullscreenControl: class {},
    accessToken: '',
  },
}));

import MapboxMap from '../components/MapboxMap';

const firstRoute = {
  type: 'LineString',
  coordinates: [[105.8, 21], [105.9, 21.1]],
};

const secondRoute = {
  type: 'LineString',
  coordinates: [[106, 21.2], [106.1, 21.3]],
};

describe('MapboxMap vehicle simulation lifecycle', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mapboxMocks.mapInstances.length = 0;
    mapboxMocks.markerInstances.length = 0;
    vi.stubEnv('VITE_MAPBOX_TOKEN', 'test-token');
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  });

  it('attaches a visible truck marker to the replacement map after changing route', () => {
    const { rerender } = render(
      <MapboxMap
        routeGeometry={firstRoute}
        enableSimulation
        autoPlaySimulation={false}
      />,
    );

    rerender(
      <MapboxMap
        routeGeometry={secondRoute}
        enableSimulation
        autoPlaySimulation={false}
      />,
    );

    const truckMarkers = mapboxMocks.markerInstances.filter((marker) =>
      marker.element?.classList.contains('truck-sim-marker-container'),
    );

    expect(mapboxMocks.mapInstances).toHaveLength(2);
    expect(truckMarkers[truckMarkers.length - 1]?.addedMap).toBe(mapboxMocks.mapInstances[1]);
  });

  it('stops playback when switching to a different driver', () => {
    const onSimulationStop = vi.fn();
    const { getByRole, rerender } = render(
      <MapboxMap
        routeGeometry={firstRoute}
        enableSimulation
        autoPlaySimulation
        vehiclePlate="29A-000.01"
        driverName="Tài xế A"
        onSimulationStop={onSimulationStop}
      />,
    );

    expect(getByRole('button', { name: 'Tạm dừng mô phỏng' })).toBeInTheDocument();

    rerender(
      <MapboxMap
        routeGeometry={secondRoute}
        enableSimulation
        autoPlaySimulation
        vehiclePlate="29A-000.02"
        driverName="Tài xế B"
        onSimulationStop={onSimulationStop}
      />,
    );

    expect(getByRole('button', { name: 'Chạy mô phỏng' })).toBeInTheDocument();
    expect(onSimulationStop).toHaveBeenCalledTimes(1);
  });
});
