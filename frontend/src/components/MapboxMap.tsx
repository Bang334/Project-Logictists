import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import {
  buildRouteProfile,
  interpolateAlongRoute,
  HANOI_SAMPLE_DEMO_ROUTE,
  RouteProfile,
} from '../utils/geoSimulation';
import { MapSimulationOverlay } from './MapSimulationOverlay';

export interface MapMarker {
  id: string;
  latitude: number;
  longitude: number;
  title: string;
  type: 'DEPOT' | 'PICKUP' | 'DELIVERY' | 'VEHICLE';
  subtitle?: string;
  sequence?: number;
  routeIndex?: number;
  color?: string;
  plateNumber?: string;
  driverName?: string;
}

export const MAP_ROUTE_COLORS = [
  '#2563eb', // Tuyến 1: Xanh dương hoàng gia
  '#059669', // Tuyến 2: Xanh ngọc lục bảo
  '#d97706', // Tuyến 3: Hổ phách
  '#7c3aed', // Tuyến 4: Tím thạch anh
  '#e11d48', // Tuyến 5: Đỏ hồng
  '#0891b2', // Tuyến 6: Xanh lơ cyan
];

interface MapboxMapProps {
  markers?: MapMarker[];
  routeGeometry?: any; // GeoJSON LineString or FeatureCollection
  height?: string | number;
  interactive?: boolean;
  onMarkerClick?: (marker: MapMarker) => void;

  // Realtime Simulation Props
  enableSimulation?: boolean;
  autoPlaySimulation?: boolean;
  showControls?: boolean;
  vehiclePlate?: string;
  driverName?: string;
  onSimulationProgress?: (
    progress: number,
    currentCoord: [number, number],
    speedKmh: number,
    traveledKm: number,
  ) => void;
}

const TRUCK_SVG_HTML = `
  <div class="truck-sim-marker-container">
    <div class="truck-sim-radar"></div>
    <div class="truck-sim-badge">
      <span class="plate-text">29H-842.15</span>
      <span class="speed-pill">0 km/h</span>
    </div>
    <div class="truck-sim-rotator">
      <div class="truck-headlight-beam"></div>
      <svg class="truck-sim-svg" viewBox="0 0 36 68" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Bánh xe 4 góc -->
        <rect x="1" y="8" width="4" height="12" rx="2" fill="#0f172a"/>
        <rect x="31" y="8" width="4" height="12" rx="2" fill="#0f172a"/>
        <rect x="1" y="46" width="4" height="12" rx="2" fill="#0f172a"/>
        <rect x="31" y="46" width="4" height="12" rx="2" fill="#0f172a"/>

        <!-- Thân xe thùng tải màu cam nổi bật -->
        <rect x="4" y="20" width="28" height="44" rx="4" fill="#f59e0b" stroke="#d97706" stroke-width="2"/>
        <!-- Rãnh gân thùng xe -->
        <line x1="9" y1="28" x2="27" y2="28" stroke="#fef3c7" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="9" y1="36" x2="27" y2="36" stroke="#fef3c7" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="9" y1="44" x2="27" y2="44" stroke="#fef3c7" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="9" y1="52" x2="27" y2="52" stroke="#fef3c7" stroke-width="1.5" stroke-linecap="round"/>

        <!-- Cabin đầu xe -->
        <path d="M5 20V9C5 6.24 7.24 4 10 4H26C28.76 4 31 6.24 31 9V20H5Z" fill="#1e3a8a"/>
        <!-- Kính chắn gió cong -->
        <path d="M7 15V10C7 7.79 8.79 6 11 6H25C27.21 6 29 7.79 29 10V15H7Z" fill="#67e8f9"/>
        <!-- Gương chiếu hậu -->
        <rect x="0" y="11" width="3" height="5" rx="1" fill="#0f172a"/>
        <rect x="33" y="11" width="3" height="5" rx="1" fill="#0f172a"/>
        <!-- Đèn pha trước công nghệ LED siêu sáng -->
        <circle cx="8" cy="5" r="2" fill="#fef08a"/>
        <circle cx="28" cy="5" r="2" fill="#fef08a"/>
      </svg>
    </div>
  </div>
`;

const DEPOT_SVG_HTML = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="m2.5 8.5 9.5-6 9.5 6H2.5ZM4 9.5h16v2H4v-2ZM5.5 18.5h13v2h-13v-2Z" fill="currentColor"/>
    <path d="M7 11.5v7M11 11.5v7M15 11.5v7M19 11.5v7" fill="none" stroke="currentColor" stroke-width="2"/>
  </svg>
`;

const ROUTE_COLOR_EXPRESSION = [
  'match',
  ['get', 'routeIndex'],
  ...MAP_ROUTE_COLORS.flatMap((color, index) => [index, color]),
  MAP_ROUTE_COLORS[0],
];

const MapboxMap: React.FC<MapboxMapProps> = ({
  markers = [],
  routeGeometry,
  height = '100%',
  interactive = true,
  onMarkerClick,
  enableSimulation = false,
  autoPlaySimulation = false,
  showControls = true,
  vehiclePlate = '29C-678.92',
  driverName = 'Tài xế',
  onSimulationProgress,
}) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const truckMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const truckElementRef = useRef<HTMLDivElement | null>(null);

  // Simulation State
  const [isPlaying, setIsPlaying] = useState<boolean>(autoPlaySimulation);
  const [progress, setProgress] = useState<number>(0);
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(1);
  const [currentSpeedKmh, setCurrentSpeedKmh] = useState<number>(45);

  const progressRef = useRef<number>(0);
  const isPlayingRef = useRef<boolean>(autoPlaySimulation);
  const speedMultiplierRef = useRef<number>(1);
  const animationFrameRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);

  // Sync refs with states
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    speedMultiplierRef.current = speedMultiplier;
  }, [speedMultiplier]);

  // Extract flat coordinates array for route profile
  const routeCoordinates = useMemo<[number, number][]>(() => {
    if (!routeGeometry) {
      return enableSimulation ? HANOI_SAMPLE_DEMO_ROUTE : [];
    }

    if (routeGeometry.type === 'LineString' && Array.isArray(routeGeometry.coordinates)) {
      return routeGeometry.coordinates;
    }

    if (routeGeometry.type === 'Feature' && routeGeometry.geometry?.type === 'LineString') {
      return routeGeometry.geometry.coordinates;
    }

    if (routeGeometry.type === 'FeatureCollection' && Array.isArray(routeGeometry.features)) {
      // Ưu tiên Feature LineString có coordinates hợp lệ
      const lineFeature = routeGeometry.features.find(
        (f: any) =>
          f.geometry?.type === 'LineString' &&
          Array.isArray(f.geometry.coordinates) &&
          f.geometry.coordinates.length > 1,
      );
      if (lineFeature) {
        return lineFeature.geometry.coordinates;
      }
    }

    return enableSimulation ? HANOI_SAMPLE_DEMO_ROUTE : [];
  }, [routeGeometry, enableSimulation]);

  const allRouteCoordinates = useMemo<[number, number][]>(() => {
    if (routeGeometry?.type === 'FeatureCollection' && Array.isArray(routeGeometry.features)) {
      return routeGeometry.features.flatMap((feature: any) =>
        feature.geometry?.type === 'LineString' && Array.isArray(feature.geometry.coordinates)
          ? feature.geometry.coordinates
          : [],
      );
    }
    return routeCoordinates;
  }, [routeGeometry, routeCoordinates]);

  const routeProfile = useMemo<RouteProfile>(() => {
    return buildRouteProfile(routeCoordinates);
  }, [routeCoordinates]);

  // Khởi tạo Mapbox Map - Giữ map ĐỨNG YÊN HOÀN TOÀN (pitch = 0, bearing = 0)
  useEffect(() => {
    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!token || !mapContainer.current) return;

    mapboxgl.accessToken = token;

    const initialCenter: [number, number] =
      routeCoordinates.length > 0
        ? [routeCoordinates[0][0], routeCoordinates[0][1]]
        : [105.854, 21.0283];

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: initialCenter,
      zoom: 11,
      pitch: 0, // Giữ phẳng đứng yên
      bearing: 0, // Không xoay bản đồ
      interactive,
    });

    if (interactive) {
      map.addControl(new mapboxgl.NavigationControl(), 'top-right');
      map.addControl(new mapboxgl.FullscreenControl(), 'top-right');
    }

    mapRef.current = map;

    const resizeObserver = new ResizeObserver(() => {
      map.resize();
    });
    if (mapContainer.current) {
      resizeObserver.observe(mapContainer.current);
    }

    return () => {
      resizeObserver.disconnect();
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      map.remove();
      mapRef.current = null;
    };
  }, [interactive]);

  // Reset tiến độ xe khi đổi tuyến / xe
  useEffect(() => {
    setProgress(0);
    progressRef.current = 0;
    if (enableSimulation) {
      setIsPlaying(true);
      isPlayingRef.current = true;
    }
  }, [routeCoordinates, enableSimulation]);

  // Vẽ Tuyến đường và Markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Xóa markers cũ
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const bounds = new mapboxgl.LngLatBounds();

    // Thêm markers mới
    markers.forEach((marker) => {
      // Wrapper gốc cho Mapbox GL JS quản lý vị trí pixel tuyệt đối
      const el = document.createElement('div');
      el.className = 'tms-map-marker-container';

      // Pin nội dung trực quan bên trong (độc lập với transform định vị của Mapbox)
      const pin = document.createElement('div');
      pin.className = `custom-marker-pin marker-${marker.type.toLowerCase()}`;
      pin.setAttribute('role', 'button');
      pin.setAttribute('aria-label', [marker.title, marker.subtitle].filter(Boolean).join('. '));
      pin.setAttribute('title', marker.title);
      pin.tabIndex = 0;

      const routeColor =
        marker.color ||
        (marker.routeIndex !== undefined
          ? MAP_ROUTE_COLORS[marker.routeIndex % MAP_ROUTE_COLORS.length]
          : '#2563eb');
      pin.style.borderColor = marker.type === 'DEPOT' ? '#ffffff' : routeColor;
      pin.style.borderWidth = '3px';
      pin.style.boxShadow = `0 3px 8px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255,255,255,0.85)`;

      if (marker.type === 'DEPOT') {
        pin.innerHTML = DEPOT_SVG_HTML;
      } else {
        pin.textContent = marker.sequence
          ? String(marker.sequence)
          : marker.type === 'PICKUP'
            ? 'N'
            : 'G';
      }

      el.appendChild(pin);

      const popupContent = document.createElement('div');
      popupContent.className = 'map-popup';
      popupContent.style.padding = '4px';

      if (marker.plateNumber) {
        const vehicleBadge = document.createElement('div');
        vehicleBadge.style.display = 'inline-block';
        vehicleBadge.style.padding = '2px 6px';
        vehicleBadge.style.borderRadius = '4px';
        vehicleBadge.style.fontSize = '10px';
        vehicleBadge.style.fontWeight = 'bold';
        vehicleBadge.style.color = '#ffffff';
        vehicleBadge.style.backgroundColor = routeColor;
        vehicleBadge.style.marginBottom = '4px';
        vehicleBadge.textContent = `${marker.plateNumber} · ${marker.driverName || 'Tài xế'}`;
        popupContent.appendChild(vehicleBadge);
      }

      const popupTitle = document.createElement('div');
      popupTitle.style.fontWeight = 'bold';
      popupTitle.style.fontSize = '12px';
      popupTitle.textContent = marker.title;
      popupContent.appendChild(popupTitle);

      if (marker.subtitle) {
        const subtitle = document.createElement('div');
        subtitle.style.fontSize = '11px';
        subtitle.style.color = '#475569';
        subtitle.style.marginTop = '2px';
        subtitle.textContent = marker.subtitle;
        popupContent.appendChild(subtitle);
      }

      const popup = new mapboxgl.Popup({ offset: 25 }).setDOMContent(popupContent);

      const m = new mapboxgl.Marker({
        element: el,
        anchor: 'center',
      })
        .setLngLat([marker.longitude, marker.latitude])
        .setPopup(popup)
        .addTo(map);

      el.addEventListener('click', () => onMarkerClick?.(marker));
      el.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        m.togglePopup();
        onMarkerClick?.(marker);
      });
      markersRef.current.push(m);
      bounds.extend([marker.longitude, marker.latitude]);
    });

    // Cài đặt các layer đường
    function setupRouteLayers() {
      if (!map) return;

      const showAllRoutes = !enableSimulation && routeGeometry?.type === 'FeatureCollection';
      const geojsonData = showAllRoutes
        ? routeGeometry
        : routeCoordinates.length > 1
          ? {
              type: 'Feature',
              properties: { routeIndex: 0 },
              geometry: {
                type: 'LineString',
                coordinates: routeCoordinates,
              },
            }
          : { type: 'FeatureCollection', features: [] };

      // 1. Tuyến đường nền (Đoạn chưa chạy tới: màu xám nhạt nếu đang mô phỏng, hoặc màu xanh nếu tĩnh)
      if (map.getSource('route')) {
        (map.getSource('route') as mapboxgl.GeoJSONSource).setData(geojsonData as any);
      } else if (routeCoordinates.length > 1) {
        map.addSource('route', {
          type: 'geojson',
          data: geojsonData as any,
        });

        map.addLayer({
          id: 'route-line-bg',
          type: 'line',
          source: 'route',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#ffffff',
            'line-width': 8,
            'line-opacity': 0.9,
          },
        });

        map.addLayer({
          id: 'route-line',
          type: 'line',
          source: 'route',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': enableSimulation
              ? '#94a3b8'
              : showAllRoutes
                ? (ROUTE_COLOR_EXPRESSION as any)
                : MAP_ROUTE_COLORS[0],
            'line-width': 5,
            'line-opacity': enableSimulation ? 0.65 : 0.85,
          },
        });
      }

      // Cập nhật màu route-line nếu source đã có sẵn
      if (map.getLayer('route-line')) {
        map.setPaintProperty(
          'route-line',
          'line-color',
          enableSimulation
            ? '#94a3b8'
            : showAllRoutes
              ? (ROUTE_COLOR_EXPRESSION as any)
              : MAP_ROUTE_COLORS[0],
        );
        map.setPaintProperty(
          'route-line',
          'line-opacity',
          enableSimulation ? 0.65 : 0.85,
        );
      }

      // 2. Tuyến đường đã đi qua (CHẠY TỚI ĐÂU ĐỔI MÀU TỚI ĐÓ)
      const emptyTraveled = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [] },
      };

      if (map.getSource('traveled-route')) {
        (map.getSource('traveled-route') as mapboxgl.GeoJSONSource).setData(emptyTraveled as any);
      } else if (routeCoordinates.length > 1) {
        map.addSource('traveled-route', {
          type: 'geojson',
          data: emptyTraveled as any,
        });

        // Vệt phát sáng neon bên dưới
        map.addLayer({
          id: 'traveled-route-glow',
          type: 'line',
          source: 'traveled-route',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#34d399',
            'line-width': 12,
            'line-opacity': 0.45,
            'line-blur': 3,
          },
        });

        // Đường đã chạy qua đổi thành màu xanh ngọc lục bảo rực rỡ
        map.addLayer({
          id: 'traveled-route-line',
          type: 'line',
          source: 'traveled-route',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#059669', // Xanh ngọc lục bảo rực rỡ
            'line-width': 6.5,
            'line-opacity': 1.0,
          },
        });
      }

      allRouteCoordinates.forEach((coordinate) => bounds.extend(coordinate));

      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 50, maxZoom: 14.5, duration: 1000 });
      }
    }

    if (map.isStyleLoaded()) {
      setupRouteLayers();
    } else {
      map.once('load', setupRouteLayers);
    }
  }, [
    markers,
    routeGeometry,
    routeCoordinates,
    allRouteCoordinates,
    onMarkerClick,
    enableSimulation,
  ]);

  // Hàm cập nhật vị trí xe và ĐỔI MÀU ĐƯỜNG TỚI ĐÂU THEO TỚI ĐÓ (Bản đồ đứng yên)
  const updateTruckPosition = useCallback(
    (currentProg: number) => {
      const map = mapRef.current;
      const truck = truckMarkerRef.current;
      const truckEl = truckElementRef.current;
      if (!map || !truck || !truckEl || routeProfile.totalDistanceKm === 0) return;

      const { coord, bearing, traveledKm, traveledCoordinates } = interpolateAlongRoute(
        routeProfile,
        currentProg,
      );

      // Cập nhật vị trí chiếc xe
      truck.setLngLat(coord);

      // Xoay đầu xe theo góc cua của con đường (bearing)
      const rotator = truckEl.querySelector('.truck-sim-rotator') as HTMLElement;
      if (rotator) {
        rotator.style.transform = `rotate(${bearing}deg)`;
      }

      // Giả lập tốc độ xe dao động tự nhiên quanh 45-55 km/h
      const simulatedSpeed = isPlayingRef.current
        ? Math.round(45 + Math.sin(currentProg * 50) * 8 + Math.random() * 3)
        : 0;
      setCurrentSpeedKmh(simulatedSpeed);

      const speedPill = truckEl.querySelector('.speed-pill');
      if (speedPill) {
        speedPill.textContent = `${simulatedSpeed} km/h`;
      }

      // ĐỔI MÀU ĐƯỜNG: Vệt đường đã đi qua (traveled-route) dài ra đến đúng vị trí của chiếc xe
      const traveledSource = map.getSource('traveled-route') as mapboxgl.GeoJSONSource | undefined;
      if (traveledSource) {
        traveledSource.setData({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: traveledCoordinates.length > 1 ? traveledCoordinates : [coord, coord],
          },
        } as any);
      }

      // MAP ĐỨNG YÊN HOÀN TOÀN: Không gọi map.easeTo, giữ nguyên góc nhìn tổng thể cho người dùng
      onSimulationProgress?.(currentProg, coord, simulatedSpeed, traveledKm);
    },
    [routeProfile, onSimulationProgress],
  );

  // Tạo và quản lý Truck Marker (Xe luôn luôn hiện diện trên tuyến đường)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !enableSimulation || routeCoordinates.length < 2) {
      if (truckMarkerRef.current) {
        truckMarkerRef.current.remove();
        truckMarkerRef.current = null;
      }
      return;
    }

    if (!truckMarkerRef.current) {
      const containerEl = document.createElement('div');
      containerEl.innerHTML = TRUCK_SVG_HTML;
      const truckElement = containerEl.firstElementChild as HTMLDivElement;
      truckElementRef.current = truckElement;

      // Gán biển số
      const plateTextEl = truckElement.querySelector('.plate-text');
      if (plateTextEl) {
        plateTextEl.textContent = vehiclePlate;
      }

      const marker = new mapboxgl.Marker({
        element: truckElement,
        rotationAlignment: 'viewport',
        pitchAlignment: 'viewport',
      })
        .setLngLat(routeCoordinates[0])
        .addTo(map);

      truckMarkerRef.current = marker;
    } else {
      // Cập nhật lại biển số nếu đổi xe
      const plateTextEl = truckElementRef.current?.querySelector('.plate-text');
      if (plateTextEl) {
        plateTextEl.textContent = vehiclePlate;
      }
    }

    updateTruckPosition(progressRef.current);
  }, [enableSimulation, routeCoordinates, vehiclePlate, updateTruckPosition]);

  // Animation Loop chạy mô phỏng 60 FPS
  useEffect(() => {
    if (!enableSimulation) return;

    const animate = (timestamp: number) => {
      if (!lastTimestampRef.current) {
        lastTimestampRef.current = timestamp;
      }
      const deltaSeconds = (timestamp - lastTimestampRef.current) / 1000;
      lastTimestampRef.current = timestamp;

      if (isPlayingRef.current && routeProfile.totalDistanceKm > 0) {
        // Tốc độ trực quan: Hoàn thành 1 vòng trong ~20 giây (ở tốc độ 1x)
        const baseDurationSeconds = 20;
        const progressIncrement =
          (deltaSeconds / baseDurationSeconds) * speedMultiplierRef.current;

        let nextProgress = progressRef.current + progressIncrement;
        if (nextProgress >= 1) {
          nextProgress = 0; // Tự động lặp lại (Loop) chạy liên tục!
        }

        setProgress(nextProgress);
        progressRef.current = nextProgress;
        updateTruckPosition(nextProgress);
      }

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [enableSimulation, routeProfile.totalDistanceKm, updateTruckPosition]);

  // Handlers
  const handleTogglePlay = () => {
    setIsPlaying((prev) => !prev);
  };

  const handleSeek = (val: number) => {
    setProgress(val);
    progressRef.current = val;
    updateTruckPosition(val);
  };

  const handleReset = () => {
    setIsPlaying(true);
    setProgress(0);
    progressRef.current = 0;
    updateTruckPosition(0);
  };

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    >
      <div ref={mapContainer} style={{ width: '100%', height: '100%', position: 'relative' }} />

      {enableSimulation && showControls && (
        <MapSimulationOverlay
          isPlaying={isPlaying}
          progress={progress}
          speedMultiplier={speedMultiplier}
          followVehicle={false}
          currentSpeedKmh={currentSpeedKmh}
          traveledDistanceKm={progress * routeProfile.totalDistanceKm}
          totalDistanceKm={routeProfile.totalDistanceKm}
          vehiclePlate={vehiclePlate}
          driverName={driverName}
          onTogglePlay={handleTogglePlay}
          onSeek={handleSeek}
          onReset={handleReset}
          onChangeSpeed={setSpeedMultiplier}
          onToggleFollow={() => {}}
        />
      )}
    </div>
  );
};

export default MapboxMap;
