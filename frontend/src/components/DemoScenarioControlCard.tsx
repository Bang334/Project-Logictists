import React, { useMemo, useRef } from 'react';
import {
  Card,
  Select,
  Space,
  Button,
  Tag,
  Typography,
  Tooltip,
  Row,
  Col,
  InputNumber,
  Upload,
  Alert,
} from 'antd';
import {
  ExperimentOutlined,
  ThunderboltOutlined,
  UploadOutlined,
  InfoCircleOutlined,
  DeleteOutlined,
  FileTextOutlined,
  ClockCircleOutlined,
  CarOutlined,
  BranchesOutlined,
  UserOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import { DemoCaseSummaryUI } from '../types';

const { Text } = Typography;

interface DemoScenarioControlCardProps {
  cases: DemoCaseSummaryUI[];
  loadingCases: boolean;
  selectedCaseId: string;
  onSelectCaseId: (caseId: string) => void;
  timeBudgetSeconds: number;
  onChangeTimeBudget: (seconds: number) => void;
  running: boolean;
  onRunDemo: () => void;
  onClearDemo: () => void;
  hasResult: boolean;
  isCustomUpload: boolean;
  onToggleCustomUpload: (isCustom: boolean) => void;
  customFileName?: string;
  onCustomJsonLoaded: (json: any, fileName: string) => void;
}

export const DemoScenarioControlCard: React.FC<DemoScenarioControlCardProps> = ({
  cases,
  loadingCases,
  selectedCaseId,
  onSelectCaseId,
  timeBudgetSeconds,
  onChangeTimeBudget,
  running,
  onRunDemo,
  onClearDemo,
  hasResult,
  isCustomUpload,
  onToggleCustomUpload,
  customFileName,
  onCustomJsonLoaded,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedCase = useMemo(
    () => cases.find((c) => c.id === selectedCaseId) || cases[0],
    [cases, selectedCaseId],
  );

  // Group cases by category
  const selectOptions = useMemo(() => {
    const novelCases = cases.filter((c) => c.category === 'NOVEL');
    const scenarioCases = cases.filter((c) => c.category === 'SCENARIO');
    const realDataCases = cases.filter((c) => c.category === 'REAL_DATA');

    return [
      {
        label: (
          <span style={{ fontWeight: 700, color: '#7c3aed' }}>
            🌟 Novel Benchmarks Nâng Cao ({novelCases.length} kịch bản)
          </span>
        ),
        options: novelCases.map((c) => ({
          value: c.id,
          label: `${c.name} (${c.orders_count} đơn · ${c.vehicles_count} xe)`,
        })),
      },
      {
        label: (
          <span style={{ fontWeight: 700, color: '#0284c7' }}>
            📦 Kịch Bản Vận Tải Đặc Thù ({scenarioCases.length} kịch bản)
          </span>
        ),
        options: scenarioCases.map((c) => ({
          value: c.id,
          label: `${c.name} (${c.orders_count} đơn · ${c.vehicles_count} xe)`,
        })),
      },
      {
        label: (
          <span style={{ fontWeight: 700, color: '#059669' }}>
            🏢 Dữ Liệu Thực Tế Doanh Nghiệp ({realDataCases.length} kịch bản)
          </span>
        ),
        options: realDataCases.map((c) => ({
          value: c.id,
          label: `${c.name} (${c.orders_count} đơn · ${c.vehicles_count} xe)`,
        })),
      },
    ];
  }, [cases]);

  const handleFileUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        onCustomJsonLoaded(json, file.name);
      } catch {
        alert('File JSON không hợp lệ! Vui lòng kiểm tra lại định dạng tệp.');
      }
    };
    reader.readAsText(file);
    return false;
  };

  return (
    <Card
      bordered={false}
      style={{
        borderRadius: 14,
        background: 'linear-gradient(135deg, #fbfbfe 0%, #f5f3ff 100%)',
        border: '1.5px solid #ddd6fe',
        boxShadow: '0 4px 20px -4px rgba(124, 58, 237, 0.08)',
        marginBottom: 20,
      }}
      styles={{ body: { padding: '20px 24px' } }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space size={10} align="center">
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff',
              fontSize: 18,
              boxShadow: '0 2px 8px rgba(124, 58, 237, 0.25)',
            }}
          >
            <ExperimentOutlined />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#4c1d95', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>Thử Nghiệm Demo Kịch Bản Mẫu (Algorithm Benchmarks)</span>
              <Tag color="purple" style={{ borderRadius: 6, fontWeight: 600 }}>
                Production Hybrid ALNS
              </Tag>
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Chạy trực tiếp thuật toán tối ưu trên 17 bộ kịch bản tự trị hoặc nạp tệp JSON tùy biến (không cần dữ liệu chi nhánh).
            </Text>
          </div>
        </Space>

        <Space>
          <Button
            size="middle"
            icon={<UploadOutlined />}
            onClick={() => onToggleCustomUpload(!isCustomUpload)}
            style={{
              borderColor: isCustomUpload ? '#7c3aed' : '#cbd5e1',
              color: isCustomUpload ? '#7c3aed' : '#475569',
              fontWeight: 600,
            }}
          >
            {isCustomUpload ? 'Dùng kịch bản chuẩn có sẵn' : 'Tải lên JSON riêng'}
          </Button>
          {hasResult && (
            <Button size="middle" danger icon={<DeleteOutlined />} onClick={onClearDemo} disabled={running}>
              Xóa kết quả Demo
            </Button>
          )}
        </Space>
      </div>

      {isCustomUpload ? (
        <div style={{ padding: '16px', background: '#ffffff', borderRadius: 10, border: '1px dashed #7c3aed', marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text strong style={{ color: '#5b21b6' }}>
                <FileTextOutlined style={{ marginRight: 6 }} />
                Nạp tệp JSON cấu hình FleetOptimizationRequest riêng:
              </Text>
              <Upload beforeUpload={handleFileUpload} showUploadList={false} accept=".json">
                <Button icon={<UploadOutlined />} type="dashed" style={{ borderColor: '#7c3aed', color: '#6d28d9' }}>
                  Chọn tệp JSON từ máy tính
                </Button>
              </Upload>
            </div>
            {customFileName && (
              <Tag color="success" style={{ padding: '4px 10px', fontSize: 13, borderRadius: 6 }}>
                ✓ Đã nạp tệp: <strong>{customFileName}</strong>
              </Tag>
            )}
          </Space>
        </div>
      ) : (
        <Row gutter={[16, 16]} align="middle" style={{ marginBottom: 16 }}>
          <Col xs={24} md={12} lg={10}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontWeight: 600, fontSize: 12 }}>
              CHỌN TẬP DỮ LIỆU KỊCH BẢN (17 BỘ BENCHMARK)
            </Text>
            <Select
              aria-label="Chọn kịch bản benchmark"
              value={selectedCaseId}
              loading={loadingCases}
              disabled={loadingCases || running}
              placeholder="Chọn kịch bản benchmark"
              showSearch
              style={{ width: '100%' }}
              onChange={(val) => {
                onSelectCaseId(val);
                const found = cases.find((c) => c.id === val);
                if (found) {
                  onChangeTimeBudget(found.suggested_time_limit_sec || 6);
                }
              }}
              options={selectOptions}
            />
          </Col>

          <Col xs={24} md={12} lg={6}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontWeight: 600, fontSize: 12 }}>
              NGÂN SÁCH TÌM KIẾM
            </Text>
            <Space align="center">
              <InputNumber
                min={1}
                max={120}
                precision={0}
                value={timeBudgetSeconds}
                onChange={(v) => onChangeTimeBudget(v || 6)}
                addonAfter="giây"
                disabled={running}
                style={{ width: 140 }}
              />
              {selectedCase && (
                <Tooltip title="Khuyến nghị thời gian chạy tối ưu cho bài toán này">
                  <Tag color="purple" style={{ margin: 0, borderRadius: 6 }}>
                    Gợi ý: {selectedCase.suggested_time_limit_sec}s
                  </Tag>
                </Tooltip>
              )}
            </Space>
          </Col>

          <Col xs={24} md={24} lg={8} style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-end' }}>
            <Button
              type="primary"
              size="large"
              icon={<ThunderboltOutlined style={{ fontSize: 18, color: '#fbbf24' }} />}
              loading={running}
              onClick={onRunDemo}
              style={{
                background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)',
                borderColor: '#6d28d9',
                height: 44,
                padding: '0 28px',
                fontWeight: 700,
                fontSize: 15,
                borderRadius: 8,
                boxShadow: '0 4px 14px rgba(109, 40, 217, 0.3)',
              }}
            >
              Chạy tối ưu Demo
            </Button>
          </Col>
        </Row>
      )}

      {/* Tóm tắt kịch bản đã chọn */}
      {selectedCase && !isCustomUpload && (
        <div
          style={{
            background: '#ffffff',
            borderRadius: 10,
            padding: '12px 16px',
            border: '1px solid #ede9fe',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ flex: '1 1 300px' }}>
            <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 14, marginBottom: 2 }}>
              {selectedCase.name}
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {selectedCase.description}
            </Text>
          </div>

          <Space size={16} wrap>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <BranchesOutlined style={{ color: '#2563eb' }} />
              <span style={{ fontSize: 12, color: '#475569' }}>Đơn hàng:</span>
              <strong style={{ color: '#1e40af' }}>{selectedCase.orders_count}</strong>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <CarOutlined style={{ color: '#059669' }} />
              <span style={{ fontSize: 12, color: '#475569' }}>Đội xe:</span>
              <strong style={{ color: '#065f46' }}>{selectedCase.vehicles_count}</strong>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <UserOutlined style={{ color: '#d97706' }} />
              <span style={{ fontSize: 12, color: '#475569' }}>Tài xế:</span>
              <strong style={{ color: '#92400e' }}>{selectedCase.drivers_count}</strong>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <InboxOutlined style={{ color: '#7c3aed' }} />
              <span style={{ fontSize: 12, color: '#475569' }}>Tổng tải:</span>
              <strong style={{ color: '#5b21b6' }}>{selectedCase.total_weight_kg.toLocaleString('vi-VN')} kg</strong>
            </div>
          </Space>
        </div>
      )}

      {hasResult && (
        <Alert
          type="info"
          showIcon
          message="Đang hiển thị kết quả từ Chế độ Demo (Benchmark)"
          description="Toàn bộ bản đồ lộ trình, danh sách điểm dừng, sơ đồ xếp dỡ 2D thùng xe và bảng đối chuẩn 4 thuật toán đều hiển thị đầy đủ bên dưới. Phương án demo không ghi đè dữ liệu chuyến thực tế trong cơ sở dữ liệu."
          style={{ marginTop: 14, borderRadius: 8, borderColor: '#c4b5fd', background: '#f5f3ff' }}
        />
      )}
    </Card>
  );
};
