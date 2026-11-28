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
    sources = new globalThis.Map<string, { setData: ReturnType<typeof vi.fn> }>();
    layers = new Set<string>();
    layerListeners = new globalThis.Map<string, (event: unknown) => void>();
    canvas = { style: { cursor: '' } };
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
    getCanvas() { return this.canvas; }
    on(
      event: string,
      layerOrCallback: string | ((event: { originalEvent?: Event }) => void),
      callback?: (event: unknown) => void,
    ) {
      if (typeof layerOrCallback === 'function') {
        if (event === 'zoomstart') this.zoomStart = layerOrCallback;
      } else if (typeof callback === 'function') {
        this.layerListeners.set(`${event}:${layerOrCallback}`, callback);
      }
    }
    off(
      event?: string,
      layerOrCallback?: string | ((event: { originalEvent?: Event }) => void),
    ) {
      if (event && typeof layerOrCallback === 'string') {
        this.layerListeners.delete(`${event}:${layerOrCallback}`);
      }
    }
    once(_event: string, callback: () => void) { callback(); }
    addSource(id: string, config?: { data?: unknown }) { this.sources.set(id, { setData: vi.fn(), ...(config ? { initialData: config.data } : {}) }); }
    getSource(id: string) { return this.sources.get(id); }
    addLayer(layer: { id: string }, _beforeId?: string) { this.layers.add(layer.id); }
    getLayer(id: string) { return this.layers.has(id) ? { id } : undefined; }
    getZoom() { return this.zoom; }
    setPaintProperty() {}
    fitBounds() {}
  }

  const popupInstances: MockPopup[] = [];

  class MockPopup {
    content?: HTMLElement;
    lngLat?: unknown;
    addedMap?: unknown;
    remove = vi.fn();
    constructor() {
      popupInstances.push(this);
    }
    setLngLat(lngLat: unknown) {
      this.lngLat = lngLat;
      return this;
    }
    setDOMContent(content: HTMLElement) {
      this.content = content;
      return this;
    }
    addTo(map: unknown) {
      this.addedMap = map;
      return this;
    }
  }

  class MockMarker {
    readonly element?: HTMLElement;
    addedMap?: MockMap;
    removed = false;
    coordinate?: [number, number];
    popup?: MockPopup;

    constructor(options?: { element?: HTMLElement }) {
      this.element = options?.element;
      markerInstances.push(this);
    }

    setLngLat(coordinate: [number, number]) { this.coordinate = coordinate; return this; }
    setPopup(popup: MockPopup) { this.popup = popup; return this; }
    getPopup() { return this.popup; }
    addTo(map: MockMap) {
      this.addedMap = map;
      return this;
    }
    remove() { this.removed = true; }
    togglePopup = vi.fn();
  }

  return { mapInstances, markerInstances, popupInstances, MockBounds, MockMap, MockMarker, MockPopup };
});

vi.mock('mapbox-gl', () => ({
  default: {
    Map: mapboxMocks.MockMap,
    Marker: mapboxMocks.MockMarker,
    Popup: mapboxMocks.MockPopup,
    LngLatBounds: mapboxMocks.MockBounds,
    NavigationControl: class {},
    FullscreenControl: class {},
    accessToken: '',
  },
}));

import MapboxMap, { type MapMarker, type MapSimulationControls } from '../components/MapboxMap';
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
  it('updates a shared pin to the next visit and reveals every colored stop on hover', () => {
    const stops: MapMarker[] = [
      { id: '4', type: 'PICKUP', title: 'Nhận hàng', sequence: 4, longitude: 108.2, latitude: 16.05 },
      { id: '8', type: 'DELIVERY', title: 'Giao hàng', sequence: 8, longitude: 108.20000000001, latitude: 16.05 },
      { id: '10', type: 'PICKUP', title: 'Nhận hàng', sequence: 10, longitude: 108.2, latitude: 16.05 },
      { id: '12', type: 'DELIVERY', title: 'Giao hàng', sequence: 12, longitude: 108.2, latitude: 16.05 },
      { id: '9', type: 'DELIVERY', title: 'Điểm kế tiếp', sequence: 9, longitude: 108.201, latitude: 16.05 },
    ];
    const onMarkerClick = vi.fn();
    const { rerender } = render(<MapboxMap markers={stops} groupCoincidentStops onMarkerClick={onMarkerClick} />);

    const [shared, separate] = mapboxMocks.markerInstances as InstanceType<typeof mapboxMocks.MockMarker>[];
    expect(mapboxMocks.markerInstances).toHaveLength(2);
    const pin = shared.element?.querySelector('[role="button"]');
    const list = shared.element?.querySelector('.map-shared-stop-list');
    if (!pin || !list || !shared.element || !separate.element) throw new Error('Missing map marker');
    expect(pin).toHaveTextContent('4');
    expect(pin).toHaveAttribute('aria-label', 'Các điểm dừng 4, 8, 10, 12');
    expect(list).toHaveAttribute('hidden');
    rerender(<MapboxMap markers={stops} groupCoincidentStops completedStopSequence={5} onMarkerClick={onMarkerClick} />);
    expect(mapboxMocks.markerInstances).toHaveLength(2);
    expect(pin).toHaveTextContent('8');
    expect(pin).toHaveAttribute('data-stop-type', 'DELIVERY');
    fireEvent.mouseEnter(shared.element);
    expect(list).not.toHaveAttribute('hidden');
    expect(onMarkerClick).not.toHaveBeenCalled();
    fireEvent.mouseLeave(shared.element);
    expect(list).toHaveAttribute('hidden');
    fireEvent.keyDown(pin, { key: 'Enter' });
    expect(list).not.toHaveAttribute('hidden');
    const choices = list.querySelectorAll('button');
    expect(Array.from(choices, choice => [choice.textContent, choice.dataset.stopType])).toEqual([
      ['4', 'PICKUP'], ['8', 'DELIVERY'], ['10', 'PICKUP'], ['12', 'DELIVERY'],
    ]);
    fireEvent.click(choices[1]);
    expect(onMarkerClick).toHaveBeenLastCalledWith(stops[1]);
    expect(list).toHaveAttribute('hidden');
    fireEvent.mouseEnter(shared.element);
    fireEvent.click(choices[0]);
    expect(onMarkerClick).toHaveBeenLastCalledWith(stops[0]);
    fireEvent.click(separate.element);
    expect(onMarkerClick).toHaveBeenLastCalledWith(stops[4]);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mapboxMocks.mapInstances.length = 0;
    mapboxMocks.markerInstances.length = 0;
    mapboxMocks.popupInstances.length = 0;
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
    const simulationControlsRef = React.createRef<MapSimulationControls>();
    const onSimulationPlayingChange = vi.fn();
    const { getByRole, rerender } = render(
      <MapboxMap routeGeometry={routeGeometry} enableSimulation autoPlaySimulation simulationMilestonesKm={simulationMilestonesKm} />,
    );
    const map = mapboxMocks.mapInstances[0] as InstanceType<typeof mapboxMocks.MockMap>;
    rerender(
      <MapboxMap
        routeGeometry={routeGeometry}
        enableSimulation
        followSimulationVehicle
        simulationControlsRef={simulationControlsRef}
        onSimulationPlayingChange={onSimulationPlayingChange}
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

    expect(onSimulationPlayingChange).toHaveBeenLastCalledWith(false);
    act(() => simulationControlsRef.current?.togglePlayback());
    expect(onSimulationPlayingChange).toHaveBeenLastCalledWith(true);
    act(() => {
      for (let timestamp = 1000; timestamp <= 1800; timestamp += 20) nextFrame?.(timestamp);
    });
    expect(truck).not.toMatchObject({ coordinate: coordinates[1] });
    expect(map.jumpTo).toHaveBeenLastCalledWith({ center: (truck as InstanceType<typeof mapboxMocks.MockMarker>).coordinate, zoom: 12 });

    const updatesBeforeZoom = map.jumpTo.mock.calls.length;
    map.zooming = true;
    map.zoomStart?.({ originalEvent: new MouseEvent('click') });
    act(() => nextFrame?.(1820));
    expect(map.jumpTo).toHaveBeenCalledTimes(updatesBeforeZoom);

    map.zoom = 11;
    map.zooming = false;
    act(() => nextFrame?.(1840));
    expect(map.jumpTo).toHaveBeenLastCalledWith({ center: (truck as InstanceType<typeof mapboxMocks.MockMarker>).coordinate });
    expect(map.getZoom()).toBe(11);

    act(() => simulationControlsRef.current?.togglePlayback());
    expect(onSimulationPlayingChange).toHaveBeenLastCalledWith(false);
    const cameraUpdates = map.jumpTo.mock.calls.length;
    act(() => nextFrame?.(1860));
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
    expect(onSimulationProgress.mock.lastCall?.[4]).toBe('animation');
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
    const overviewSpeed = advance(10);
    const closeupSpeed = advance(20);
    expect(overviewSpeed).toBeCloseTo(normalSpeed * 2, 8);
    expect(closeupSpeed).toBeCloseTo(normalSpeed * 0.0025, 8);
    expect(advance(6)).toBeCloseTo(overviewSpeed, 8);
    expect(advance(22)).toBeCloseTo(closeupSpeed, 8);
    expect(advance(12)).toBeCloseTo(normalSpeed * Math.SQRT2, 8);
    const streetSpeed = advance(16);
    const buildingSpeed = advance(18);
    expect(streetSpeed).toBeLessThan(normalSpeed);
    expect(buildingSpeed).toBeLessThan(streetSpeed);
    expect(buildingSpeed).toBeLessThan(normalSpeed * 0.02);
    expect(buildingSpeed).toBeGreaterThan(closeupSpeed);

    const speedInput = getByRole('textbox', { name: 'Hệ số tốc độ mô phỏng' });
    fireEvent.change(speedInput, { target: { value: '0.5' } });
    fireEvent.keyDown(speedInput, { key: 'Enter' });
    expect(advance(10)).toBeCloseTo(overviewSpeed / 2, 8);
    expect(advance(20)).toBeCloseTo(closeupSpeed / 2, 8);
  });

  it('renders active restricted zones and shows zone details popup on click', () => {
    render(
      <MapboxMap
        routeGeometry={firstRoute}
        restrictedZones={[
          {
            id: 'zone-han',
            branchId: 'branch-han',
            name: 'Nội thành Hà Nội (Vành đai 3)',
            active: true,
            maxPayloadKg: 2500,
            polygon: [[[105.78, 21.08], [105.82, 20.97], [105.86, 21.02], [105.78, 21.08]]],
            curfewWindows: [
              { startTime: '06:00', endTime: '09:00' },
              { startTime: '16:00', endTime: '20:00' },
            ],
            createdAt: '2026-11-26T00:00:00.000Z',
            updatedAt: '2026-11-26T00:00:00.000Z',
          },
        ]}
      />,
    );

    const map = mapboxMocks.mapInstances[0] as InstanceType<typeof mapboxMocks.MockMap>;
    expect(map.getLayer('restricted-zones-fill')).toBeDefined();
    expect(map.getLayer('restricted-zones-outline')).toBeDefined();

    const clickHandler = map.layerListeners.get('click:restricted-zones-fill');
    expect(clickHandler).toBeTypeOf('function');
    act(() => {
      clickHandler?.({
        lngLat: { lng: 105.85, lat: 21.02 },
        features: [
          {
            properties: {
              name: 'Nội thành Hà Nội (Vành đai 3)',
              maxPayloadKg: 2500,
              curfewSummary: '06:00–09:00, 16:00–20:00',
            },
          },
        ],
      });
    });

    const zonePopup = mapboxMocks.popupInstances[mapboxMocks.popupInstances.length - 1];
    expect(zonePopup?.content).toHaveTextContent('Nội thành Hà Nội (Vành đai 3)');
    expect(zonePopup?.content).toHaveTextContent('Hạn chế xe > 2.500 kg');
    expect(zonePopup?.content).toHaveTextContent('Khung giờ cấm: 06:00–09:00, 16:00–20:00');
  });
});
