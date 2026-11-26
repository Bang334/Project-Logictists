import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
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
    sources = new globalThis.Map<string, { setData: (data: unknown) => void }>();
    layers = new Set<string>();
    removed = false;
    zoom = 11;
    zooming = false;
    zoomStart?: (event: { originalEvent?: Event }) => void;
    easeTo = vi.fn(({ zoom }: { zoom: number }) => { this.zoom = zoom; });
    jumpTo = vi.fn(({ zoom }: { center: [number, number]; zoom?: number }) => { this.zoom = zoom ?? this.zoom; });

    constructor() {
      mapInstances.push(this);
    }

    addControl() {}
    resize() {}
    remove() { this.removed = true; }
    isStyleLoaded() { return true; }
    isZooming() { return this.zooming; }
    on(_event: string, callback: (event: { originalEvent?: Event }) => void) { this.zoomStart = callback; }
    off() {}
    once(_event: string, callback: () => void) { callback(); }
    addSource(id: string) { this.sources.set(id, { setData: vi.fn() }); }
    getSource(id: string) { return this.sources.get(id); }
    addLayer(layer: { id: string }) { this.layers.add(layer.id); }
    getLayer(id: string) { return this.layers.has(id) ? { id } : undefined; }
    getZoom() { return this.zoom; }
    setPaintProperty() {}
    fitBounds() {}
  }

  class MockMarker {
    readonly element?: HTMLElement;
    addedMap?: MockMap;
    removed = false;
    coordinate?: [number, number];

    constructor(options?: { element?: HTMLElement }) {
      this.element = options?.element;
      markerInstances.push(this);
    }

    setLngLat(coordinate: [number, number]) { this.coordinate = coordinate; return this; }
    setPopup() { return this; }
    getPopup() { return undefined; }
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
import { buildRouteProfile } from '../utils/geoSimulation';

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
    expect(document.querySelector('[aria-label="Chạy mô phỏng"]')).toBeInTheDocument();

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

  it('requires route geometry before displaying a simulation', () => {
    const { queryByRole } = render(<MapboxMap enableSimulation autoPlaySimulation />);
    expect(queryByRole('button', { name: 'Tạm dừng mô phỏng' })).not.toBeInTheDocument();
    expect(mapboxMocks.markerInstances).toHaveLength(0);
  });

  it('pauses at the selected stop, zooms to the truck and highlights the next leg', () => {
    let nextFrame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 1;
    });
    const coordinates: [number, number][] = [[105, 21], [106, 21], [107, 21], [108, 21]];
    const { cumulativeDistances, totalDistanceKm } = buildRouteProfile(coordinates);
    const routeGeometry = { type: 'LineString', coordinates };
    const simulationMilestonesKm = cumulativeDistances.slice(1);
    const { getByRole, rerender } = render(
      <MapboxMap routeGeometry={routeGeometry} enableSimulation autoPlaySimulation simulationMilestonesKm={simulationMilestonesKm} />,
    );
    const map = mapboxMocks.mapInstances[0] as InstanceType<typeof mapboxMocks.MockMap>;
    rerender(
      <MapboxMap
        routeGeometry={routeGeometry}
        enableSimulation
        followSimulationVehicle
        simulationMilestonesKm={simulationMilestonesKm}
        simulationFocus={{ coordinate: coordinates[1], progress: cumulativeDistances[1] / totalDistanceKm }}
      />,
    );

    expect(getByRole('button', { name: 'Chạy mô phỏng' })).toBeInTheDocument();
    const truck = mapboxMocks.markerInstances[mapboxMocks.markerInstances.length - 1];
    expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ center: coordinates[1], zoom: 13 }));
    expect(truck).toMatchObject({ coordinate: coordinates[1] });
    expect(map.getSource('next-route')?.setData).toHaveBeenLastCalledWith(expect.objectContaining({
      geometry: { type: 'LineString', coordinates: [coordinates[1], coordinates[2]] },
    }));

    fireEvent.click(getByRole('button', { name: 'Chạy mô phỏng' }));
    act(() => {
      for (let timestamp = 1000; timestamp <= 1700; timestamp += 20) nextFrame?.(timestamp);
    });
    expect(truck).not.toMatchObject({ coordinate: coordinates[1] });
    expect(map.jumpTo).toHaveBeenLastCalledWith({ center: (truck as InstanceType<typeof mapboxMocks.MockMarker>).coordinate, zoom: 14 });

    const updatesBeforeZoom = map.jumpTo.mock.calls.length;
    map.zooming = true;
    map.zoomStart?.({ originalEvent: new MouseEvent('click') });
    act(() => nextFrame?.(1720));
    expect(map.jumpTo).toHaveBeenCalledTimes(updatesBeforeZoom);

    map.zoom = 10;
    map.zooming = false;
    act(() => nextFrame?.(1740));
    expect(map.jumpTo).toHaveBeenLastCalledWith({ center: (truck as InstanceType<typeof mapboxMocks.MockMarker>).coordinate });
    expect(map.getZoom()).toBe(10);

    fireEvent.click(getByRole('button', { name: 'Tạm dừng mô phỏng' }));
    const cameraUpdates = map.jumpTo.mock.calls.length;
    act(() => nextFrame?.(1760));
    expect(map.jumpTo).toHaveBeenCalledTimes(cameraUpdates);
  });

  it('keeps moving the truck without jumping or redrawing the trail on each frame', () => {
    let nextFrame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 1;
    });
    const onSimulationProgress = vi.fn();
    render(<MapboxMap routeGeometry={firstRoute} enableSimulation autoPlaySimulation onSimulationProgress={onSimulationProgress} />);
    const trail = mapboxMocks.mapInstances[0] as InstanceType<typeof mapboxMocks.MockMap>;
    trail.zoom = 14;
    const setTrail = trail.getSource('traveled-route')?.setData;
    act(() => nextFrame?.(1000));
    const initialTrailUpdates = vi.mocked(setTrail!).mock.calls.length;

    act(() => nextFrame?.(1016));
    const beforeStopUpdate = onSimulationProgress.mock.lastCall?.[0];
    act(() => nextFrame?.(1216));
    const afterStopUpdate = onSimulationProgress.mock.lastCall?.[0];

    expect(afterStopUpdate - beforeStopUpdate).toBeGreaterThan(0);
    expect(afterStopUpdate - beforeStopUpdate).toBeLessThan(0.003);
    expect(setTrail).toHaveBeenCalledTimes(initialTrailUpdates + 1);
  });

  it('adjusts playback to the zoom level and multiplies it by the entered speed', () => {
    let nextFrame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 1;
    });
    const onSimulationProgress = vi.fn<(progress: number) => void>();
    const { getByRole } = render(
      <MapboxMap routeGeometry={firstRoute} enableSimulation autoPlaySimulation onSimulationProgress={onSimulationProgress} />,
    );
    const map = mapboxMocks.mapInstances[0] as InstanceType<typeof mapboxMocks.MockMap>;
    act(() => nextFrame?.(1000));
    let timestamp = 1000;
    const advance = (zoom: number) => {
      const before = onSimulationProgress.mock.lastCall![0];
      map.zoom = zoom;
      timestamp += 20;
      act(() => nextFrame?.(timestamp));
      return onSimulationProgress.mock.lastCall![0] - before;
    };
    const normalSpeed = advance(14);
    expect(normalSpeed).toBeCloseTo(0.02 / 75, 8);
    expect(advance(10)).toBeCloseTo(normalSpeed * 2, 8);
    expect(advance(18)).toBeCloseTo(normalSpeed / 2, 8);
    expect(advance(6)).toBeCloseTo(normalSpeed * 2, 8);

    const speedInput = getByRole('textbox', { name: 'Hệ số tốc độ mô phỏng' });
    fireEvent.change(speedInput, { target: { value: '0.5' } });
    fireEvent.keyDown(speedInput, { key: 'Enter' });
    expect(advance(10)).toBeCloseTo(normalSpeed, 8);
  });
});
