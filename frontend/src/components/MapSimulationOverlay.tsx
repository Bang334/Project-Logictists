import React from 'react';
import { Button, Slider, Space, Tooltip } from 'antd';
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

const SPEED_OPTIONS = [1, 2, 5];

export const MapSimulationOverlay: React.FC<MapSimulationOverlayProps> = ({
  isPlaying,
  progress,
  speedMultiplier,
  onTogglePlay,
  onSeek,
  onReset,
  onChangeSpeed,
}) => {
  const percent = Math.round(progress * 100);

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
            width: 44,
            height: 44,
            minWidth: 44,
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
          style={{ width: 44, height: 44, minWidth: 44, padding: 0 }}
        />
      </Tooltip>

      {/* Thanh Slider tua ngắn gọn */}
      <div style={{ width: 85, display: 'flex', alignItems: 'center' }}>
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

      <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />

      {/* Tốc độ 1x, 2x, 5x */}
      <Space size={3}>
        {SPEED_OPTIONS.map((speed) => (
          <Button
            key={speed}
            size="small"
            type={speedMultiplier === speed ? 'primary' : 'text'}
            onClick={() => onChangeSpeed(speed)}
            style={{
              fontSize: 10,
              padding: '0 5px',
              minWidth: 44,
              height: 44,
              lineHeight: '44px',
              backgroundColor: speedMultiplier === speed ? '#3b82f6' : 'transparent',
              color: speedMultiplier === speed ? '#ffffff' : '#94a3b8',
              borderRadius: 4,
            }}
          >
            {speed}x
          </Button>
        ))}
      </Space>
    </div>
  );
};

export default MapSimulationOverlay;
