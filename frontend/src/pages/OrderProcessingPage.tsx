import React, { useCallback, useEffect, useState } from 'react';
import { App as AntdApp, Button, Card, Col, Row, Space, Table, Tag, Typography } from 'antd';
import { InboxOutlined, ReloadOutlined } from '@ant-design/icons';
import { apiClient } from '../api/client';
import { ExpandableText } from '../components/ExpandableText';

const { Title, Text } = Typography;

interface ProcessingOrder {
  id: string;
  orderNumber: string;
  customer?: { name: string };
  allocatedSource?: { id: string; name: string };
  selectedPickupPoint?: { id: string; name: string };
  items?: Array<{ id: string; quantity: number; description: string }>;
  packages?: Array<{ id: string; packageCode: string; status: string }>;
}

const OrderProcessingPage: React.FC = () => {
  const { message, modal } = AntdApp.useApp();
  const [orders, setOrders] = useState<ProcessingOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiClient.get('/sales-orders', { params: { limit: 100 } });
      setOrders(response.data?.data ?? []);
    } catch (error: any) {
      setOrders([]);
      message.error(error.response?.data?.message || 'Không thể tải danh sách chuẩn bị hàng');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { void load(); }, [load]);

  const allocate = async (order: ProcessingOrder) => {
    setActingId(order.id);
    try {
      await apiClient.post('/allocation/orders', {
        salesOrderId: order.id,
        idempotencyKey: `allocate_${order.id}_${crypto.randomUUID()}`,
      });
      message.success(`Đã chọn nguồn và giữ tồn kho cho ${order.orderNumber}`);
      await load();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Không thể chọn nguồn hàng');
    } finally {
      setActingId(undefined);
    }
  };

  const pack = (order: ProcessingOrder) => {
    modal.confirm({
      title: `Đóng kiện cho ${order.orderNumber}?`,
      content: 'Hệ thống sẽ chốt số lượng đã giữ, trừ tồn kho và tạo một kiện chứa toàn bộ dòng hàng.',
      okText: 'Đóng kiện',
      cancelText: 'Đóng',
      onOk: async () => {
        setActingId(order.id);
        try {
          await apiClient.post('/order-processing/packages', { orderId: order.id });
          message.success(`Đã đóng kiện cho ${order.orderNumber}`);
          await load();
        } catch (error: any) {
          message.error(error.response?.data?.message || 'Không thể đóng kiện');
          throw error;
        } finally {
          setActingId(undefined);
        }
      },
    });
  };

  return (
    <div className="tms-page">
      <Row justify="space-between" align="middle" style={{ marginBottom: 20 }}>
        <Col>
          <Title level={3} style={{ margin: 0 }}>
            <InboxOutlined style={{ marginRight: 8, color: '#2563eb' }} />
            Chuẩn bị & đóng kiện
          </Title>
          <Text type="secondary">Một luồng trực tiếp trên đơn hàng, tồn kho và kiện hàng.</Text>
        </Col>
        <Col><Button icon={<ReloadOutlined />} loading={loading} onClick={load}>Làm mới</Button></Col>
      </Row>
      <Card>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={orders}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: 'Đơn hàng', dataIndex: 'orderNumber', width: 140, render: (value: string) => <Text strong>{value}</Text> },
            {
              title: 'Khách hàng',
              width: 180,
              render: (_, order) => (
                <ExpandableText text={order.customer?.name} maxChars={22} strong maxWidth={170} />
              ),
            },
            {
              title: 'Nguồn hàng',
              width: 180,
              render: (_, order) => (
                order.allocatedSource?.name ? (
                  <ExpandableText text={order.allocatedSource.name} maxChars={22} maxWidth={170} />
                ) : (
                  <Tag>Chưa chọn</Tag>
                )
              ),
            },
            {
              title: 'Điểm nhận',
              width: 180,
              render: (_, order) => (
                order.selectedPickupPoint?.name ? (
                  <ExpandableText text={order.selectedPickupPoint.name} maxChars={22} maxWidth={170} />
                ) : (
                  '—'
                )
              ),
            },
            { title: 'Số dòng hàng', render: (_, order) => order.items?.length ?? 0 },
            {
              title: 'Kiện hàng',
              render: (_, order) => order.packages?.length
                ? order.packages.map((pkg) => <Tag color="green" key={pkg.id}>{pkg.packageCode}</Tag>)
                : <Tag>Chưa đóng</Tag>,
            },
            {
              title: 'Thao tác',
              render: (_, order) => (
                <Space>
                  {!order.allocatedSource && <Button loading={actingId === order.id} onClick={() => allocate(order)}>Chọn nguồn & giữ hàng</Button>}
                  {order.allocatedSource && !order.packages?.length && <Button type="primary" loading={actingId === order.id} onClick={() => pack(order)}>Đóng kiện</Button>}
                  {!!order.packages?.length && <Tag color="success">Đã chuẩn bị</Tag>}
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

export default OrderProcessingPage;
