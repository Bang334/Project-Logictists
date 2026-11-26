import React from 'react';
import { Card, Empty, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import {
  LATE_PENALTY_MODE_LABELS,
  SETTING_AUDIT_ACTION_LABELS,
  SETTING_FIELD_LABELS,
  STACKING_OWNER_MODE_LABELS,
  SettingAuditLogItem,
} from '../../types/settings';

const { Text } = Typography;

interface SettingsAuditLogCardProps {
  items: SettingAuditLogItem[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  onPageChange: (page: number, pageSize: number) => void;
}

function formatDiffValue(key: string, val: unknown): string {
  if (val === null || val === undefined) {
    return key === 'optimization.maxRoutesPerDay' ? 'Không giới hạn' : '—';
  }
  if (typeof val === 'boolean') return val ? 'Bật' : 'Tắt';
  if (key === 'stacking.ownerMode' && typeof val === 'string') {
    return STACKING_OWNER_MODE_LABELS[val as keyof typeof STACKING_OWNER_MODE_LABELS] ?? val;
  }
  if (key === 'costPenalty.lateDeliveryPenaltyMode' && typeof val === 'string') {
    return LATE_PENALTY_MODE_LABELS[val as keyof typeof LATE_PENALTY_MODE_LABELS] ?? val;
  }
  if (typeof val === 'number') return val.toLocaleString('vi-VN');
  return String(val);
}

export const SettingsAuditLogCard: React.FC<SettingsAuditLogCardProps> = ({
  items,
  total,
  page,
  pageSize,
  loading,
  onPageChange,
}) => {
  return (
    <Card title="Lịch sử thay đổi cấu hình (Audit Log)">
      <Table<SettingAuditLogItem>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={items}
        locale={{
          emptyText: <Empty description="Chưa có lịch sử chỉnh sửa cấu hình" />,
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: false,
          onChange: onPageChange,
        }}
        columns={[
          {
            title: 'Thời gian',
            dataIndex: 'timestamp',
            width: 155,
            render: (ts: string) => dayjs(ts).format('DD/MM/YYYY HH:mm:ss'),
          },
          {
            title: 'Người thao tác',
            dataIndex: 'performedBy',
            width: 170,
            render: (username: string, row) => (
              <Space direction="vertical" size={0}>
                <Text strong>{row.actorFullName || username}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  @{username}
                </Text>
              </Space>
            ),
          },
          {
            title: 'Phạm vi',
            width: 165,
            render: (_, row) =>
              row.entityId === 'COMPANY' ? (
                <Tag color="geekblue">Toàn công ty</Tag>
              ) : (
                <Tag color="gold">
                  {row.details?.branchCode
                    ? `${row.details.branchCode} - ${row.details.branchName || ''}`
                    : row.entityId}
                </Tag>
              ),
          },
          {
            title: 'Thao tác',
            dataIndex: 'action',
            width: 190,
            render: (action: string, row) => (
              <Space direction="vertical" size={2}>
                <Text>{SETTING_AUDIT_ACTION_LABELS[action] || action}</Text>
                {row.changeSummary?.versionFrom !== undefined &&
                  row.changeSummary?.versionTo !== undefined && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      v{row.changeSummary.versionFrom} → v{row.changeSummary.versionTo}
                    </Text>
                  )}
              </Space>
            ),
          },
          {
            title: 'Chi tiết thay đổi',
            render: (_, row) => {
              const entries = Object.entries(row.changeSummary?.changes ?? {});
              if (entries.length === 0) {
                return <Text type="secondary">Lưu xác nhận phiên bản</Text>;
              }
              return (
                <Space direction="vertical" size={2}>
                  {entries.map(([field, diff]) => (
                    <Text key={field} style={{ fontSize: 12 }}>
                      <strong>{SETTING_FIELD_LABELS[field] || field}:</strong>{' '}
                      <Text type="secondary">{formatDiffValue(field, diff.from)}</Text> →{' '}
                      <Text strong>{formatDiffValue(field, diff.to)}</Text>
                    </Text>
                  ))}
                </Space>
              );
            },
          },
        ]}
      />
    </Card>
  );
};
