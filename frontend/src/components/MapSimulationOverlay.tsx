import React, { useState } from 'react';
import { Button, Slider, Tooltip } from 'antd';
import {
  CaretRightOutlined,
  PauseOutlined,
  ReloadOutlined,
} from '@ant-design/icons';

interface MapSimulationOverlayProps {
  isPlaying: boolean;
  progress: number; // 0..1
  speedMultiplier: number;
  followVehicle?: boolean;
  currentSpeedKmh?: number;
  traveledDistanceKm?: number;
  totalDistanceKm?: number;
  vehiclePlate?: string;
  driverName?: string;
  onTogglePlay: () => void;
  onSeek: (value: number) => void;
  onReset: () => void;
  onChangeSpeed: (speed: number) => void;
  onToggleFollow?: (follow: boolean) => void;
}

export const MapSimulationOverlay: React.FC<MapSimulationOverlayProps> = ({
  isPlaying,
  progress,
  speedMultiplier,
  onTogglePlay,
  onSeek,
  onReset,
  onChangeSpeed,
}) => {
  const [speedDraft, setSpeedDraft] = useState<string | null>(null);
  const percent = Math.round(progress * 100);

  const applySpeed = () => {
    if (speedDraft === null) return;

    const value = speedDraft.trim().replace(',', '.');
    const speed = Number(value);
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(speed) && speed > 0) {
      onChangeSpeed(speed);
    }
    setSpeedDraft(null);
  };

  return (
    <div className="map-sim-controls">
      {/* Nút Play / Pause nhỏ gọn */}
      <Tooltip title={isPlaying ? 'Tạm dừng' : 'Chạy tiếp'}>
        <Button
          type="primary"
          shape="circle"
          size="small"
          icon={isPlaying ? <PauseOutlined style={{ fontSize: 11 }} /> : <CaretRightOutlined style={{ fontSize: 11 }} />}
          onClick={onTogglePlay}
          aria-label={isPlaying ? 'Tạm dừng mô phỏng' : 'Chạy mô phỏng'}
          style={{
            width: 32,
            height: 32,
            minWidth: 32,
            backgroundColor: isPlaying ? '#f59e0b' : '#10b981',
            borderColor: 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
        />
      </Tooltip>

      {/* Nút chạy lại */}
      <Tooltip title="Chạy lại từ đầu">
        <Button
          type="text"
          shape="circle"
          size="small"
          icon={<ReloadOutlined style={{ color: '#cbd5e1', fontSize: 12 }} />}
          onClick={onReset}
          aria-label="Chạy lại mô phỏng từ đầu"
          style={{ width: 30, height: 30, minWidth: 30, padding: 0 }}
        />
      </Tooltip>

      {/* Thanh Slider tua ngắn gọn */}
      <div className="map-sim-seek">
        <Slider
          min={0}
          max={100}
          value={percent}
          onChange={(val) => onSeek(val / 100)}
          tooltip={{ formatter: (val) => `${val}%` }}
          style={{ width: '100%', margin: '0 4px' }}
        />
      </div>
      <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 28, textAlign: 'right' }}>
        {percent}%
      </span>

      <Tooltip title="Hệ số tốc độ cơ sở, ví dụ 0.5 hoặc 1.5. Xe chạy nhanh hơn khi thu nhỏ bản đồ.">
        <label className="map-sim-speed">
          <input
            aria-label="Hệ số tốc độ mô phỏng"
            inputMode="decimal"
            value={speedDraft ?? String(speedMultiplier)}
            onChange={(event) => setSpeedDraft(event.target.value)}
            onBlur={applySpeed}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applySpeed();
              }
            }}
          />
          <span aria-hidden="true">×</span>
        </label>
      </Tooltip>
    </div>
  );
};

export default MapSimulationOverlay;
