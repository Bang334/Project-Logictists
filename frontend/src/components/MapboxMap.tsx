import React, { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';

interface MapMarker {
  id: string;
  latitude: number;
  longitude: number;
  title: string;
  type: 'DEPOT' | 'PICKUP' | 'DELIVERY' | 'VEHICLE';
  subtitle?: string;
  sequence?: number;
}

interface MapboxMapProps {
  markers?: MapMarker[];
  routeGeometry?: any; // GeoJSON LineString
  height?: string | number;
  interactive?: boolean;
}

const MapboxMap: React.FC<MapboxMapProps> = ({
  markers = [],
  routeGeometry,
  height = '100%',
  interactive = true,
}) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);

  useEffect(() => {
    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!token || !mapContainer.current) return;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [105.8540, 21.0283], // Mặc định Hà Nội
      zoom: 11,
      interactive,
    });

    if (interactive) {
      map.addControl(new mapboxgl.NavigationControl(), 'top-right');
      map.addControl(new mapboxgl.FullscreenControl(), 'top-right');
    }

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [interactive]);

  // Cập nhật Markers và Route
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Xóa markers cũ
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    if (markers.length === 0 && !routeGeometry) return;

    const bounds = new mapboxgl.LngLatBounds();

    // Thêm markers mới
    markers.forEach((marker) => {
      const el = document.createElement('div');
      el.className = `custom-marker marker-${marker.type.toLowerCase()}`;
      el.innerHTML = marker.sequence ? `${marker.sequence}` : marker.type === 'DEPOT' ? '🏢' : '📍';

      const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(`
        <div style="font-family: Inter, sans-serif; padding: 4px;">
          <strong style="color: #1e3a8a; font-size: 13px;">${marker.title}</strong>
          ${marker.subtitle ? `<div style="color: #64748b; font-size: 12px; margin-top: 2px;">${marker.subtitle}</div>` : ''}
          <div style="color: #94a3b8; font-size: 11px; margin-top: 4px;">Tọa độ: ${marker.latitude.toFixed(4)}, ${marker.longitude.toFixed(4)}</div>
        </div>
      `);

      const m = new mapboxgl.Marker(el)
        .setLngLat([marker.longitude, marker.latitude])
        .setPopup(popup)
        .addTo(map);

      markersRef.current.push(m);
      bounds.extend([marker.longitude, marker.latitude]);
    });

    // Vẽ Lộ trình (Route GeoJSON)
    map.on('load', () => {
      drawRoute();
    });

    if (map.isStyleLoaded()) {
      drawRoute();
    }

    function drawRoute() {
      if (!map) return;
      if (map.getSource('route')) {
        (map.getSource('route') as mapboxgl.GeoJSONSource).setData(
          routeGeometry || { type: 'FeatureCollection', features: [] }
        );
      } else if (routeGeometry) {
        map.addSource('route', {
          type: 'geojson',
          data: routeGeometry,
        });

        map.addLayer({
          id: 'route-line-bg',
          type: 'line',
          source: 'route',
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': '#1d4ed8',
            'line-width': 7,
            'line-opacity': 0.8,
          },
        });

        map.addLayer({
          id: 'route-line',
          type: 'line',
          source: 'route',
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': '#60a5fa',
            'line-width': 4,
          },
        });
      }

      if (routeGeometry && routeGeometry.coordinates && routeGeometry.coordinates.length > 0) {
        routeGeometry.coordinates.forEach((coord: [number, number]) => {
          bounds.extend(coord);
        });
      }

      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 1000 });
      }
    }
  }, [markers, routeGeometry]);

  return (
    <div
      ref={mapContainer}
      style={{
        width: '100%',
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    />
  );
};

export default MapboxMap;
