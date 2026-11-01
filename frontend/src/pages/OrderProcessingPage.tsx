import React, { useCallback, useEffect, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Divider,
  Form,
  InputNumber,
  Modal,
  Row,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  AppstoreAddOutlined,
  CheckCircleOutlined,
  InboxOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { apiClient } from '../api/client';
import { ExpandableText } from '../components/ExpandableText';

const { Title, Text } = Typography;

interface FulfillmentLineData {
  id: string;
  orderItemId: string;
  skuId: string;
  requestedQuantity: number;
  reservedQuantity: number;
  packedQuantity: number;
  sku?: {
    id: string;
    skuCode: string;
    name: string;
    uom: string;
  };
}

interface PackageData {
  id: string;
  packageCode: string;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  weightG: number;
  status: string;
  measuredByUser?: {
    id: string;
    fullName: string;
  };
}

interface FulfillmentGroupData {
  id: string;
  groupNumber: string;
  status: 'PENDING' | 'PREPARING' | 'PACKED' | 'HANDED_OVER' | 'CANCELLED';
  sourceLocationId: string;
  sourceLocation?: {
    id: string;
    code: string;
    name: string;
    address: string;
  };
  order: {
    id: string;
    orderNumber: string;
    customer?: {
      name: string;
      phone: string;
    };
  };
  lines: FulfillmentLineData[];
  packages?: PackageData[];
}

interface LegacyProcessingOrder {
  id: string;
  orderNumber: string;
  customer?: { name: string };
  allocatedSource?: { id: string; name: string };
  selectedPickupPoint?: { id: string; name: string };
  items?: Array<{ id: string; quantity: number; description: string }>;
  packages?: Array<{ id: string; packageCode: string; status: string }>;
}

interface MeasuredPackageFormItem {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  weightG: number;
  items: Array<{ fulfillmentLineId: string; quantity: number }>;
}

const OrderProcessingPage: React.FC = () => {
  const { message, modal } = AntdApp.useApp();
  const [activeTab, setActiveTab] = useState<'groups' | 'legacy'>('groups');

  // Groups state
  const [groups, setGroups] = useState<FulfillmentGroupData[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [measuringGroup, setMeasuringGroup] = useState<FulfillmentGroupData | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submittingMeasurement, setSubmittingMeasurement] = useState(false);

  // Measure form state
  const [packagesToPack, setPackagesToPack] = useState<MeasuredPackageFormItem[]>([]);

  // Legacy state
  const [legacyOrders, setLegacyOrders] = useState<LegacyProcessingOrder[]>([]);
  const [loadingLegacy, setLoadingLegacy] = useState(false);
  const [actingId, setActingId] = useState<string>();

  const loadGroups = useCallback(async () => {
    setLoadingGroups(true);
    try {
      const response = await apiClient.get('/order-processing/groups');
      setGroups(response.data ?? []);
    } catch (error: any) {
      setGroups([]);
      message.error(error.response?.data?.message || 'Không thể tải danh sách nhóm chuẩn bị');
    } finally {
      setLoadingGroups(false);
    }
  }, [message]);

  const loadLegacy = useCallback(async () => {
    setLoadingLegacy(true);
    try {
      const response = await apiClient.get('/sales-orders', { params: { limit: 100 } });
      setLegacyOrders(response.data?.data ?? []);
    } catch (error: any) {
      setLegacyOrders([]);
      message.error(error.response?.data?.message || 'Không thể tải danh sách đơn bán hàng');
    } finally {
      setLoadingLegacy(false);
    }
  }, [message]);

  useEffect(() => {
    if (activeTab === 'groups') {
      void loadGroups();
    } else {
      void loadLegacy();
    }
  }, [activeTab, loadGroups, loadLegacy]);

  // Bắt đầu chuẩn bị nhóm
  const handleStartGroup = async (group: FulfillmentGroupData) => {
    try {
      await apiClient.post(`/order-processing/groups/${group.id}/start`);
      message.success(`Đã chuyển nhóm ${group.groupNumber} sang trạng thái chuẩn bị`);
      await loadGroups();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Không thể bắt đầu chuẩn bị');
    }
  };

  // Mở modal đóng kiện & đo kích thước
  const handleOpenMeasureModal = (group: FulfillmentGroupData) => {
    setMeasuringGroup(group);
    // Khởi tạo 1 kiện mặc định chứa toàn bộ số lượng yêu cầu của các line
    setPackagesToPack([
      {
        lengthMm: 400,
        widthMm: 300,
        heightMm: 200,
        weightG: 5000,
        items: group.lines.map((line) => ({
          fulfillmentLineId: line.id,
          quantity: line.requestedQuantity,
        })),
      },
    ]);
    setModalOpen(true);
  };

  const handleAddPackage = () => {
    if (!measuringGroup) return;
    setPackagesToPack((prev) => [
      ...prev,
      {
        lengthMm: 300,
        widthMm: 200,
        heightMm: 150,
        weightG: 2000,
        items: measuringGroup.lines.map((line) => ({
          fulfillmentLineId: line.id,
          quantity: 0,
        })),
      },
    ]);
  };

  const handleRemovePackage = (index: number) => {
    if (packagesToPack.length <= 1) {
      message.warning('Cần ít nhất một kiện hàng');
      return;
    }
    setPackagesToPack((prev) => prev.filter((_, i) => i !== index));
  };

  const handlePackageDimChange = (
    pkgIndex: number,
    field: 'lengthMm' | 'widthMm' | 'heightMm' | 'weightG',
    val: number | null,
  ) => {
    setPackagesToPack((prev) => {
      const copy = [...prev];
      copy[pkgIndex] = { ...copy[pkgIndex], [field]: val ?? 0 };
      return copy;
    });
  };

  const handleItemQtyChange = (pkgIndex: number, lineId: string, val: number | null) => {
    setPackagesToPack((prev) => {
      const copy = [...prev];
      const itemsCopy = copy[pkgIndex].items.map((it) =>
        it.fulfillmentLineId === lineId ? { ...it, quantity: val ?? 0 } : it,
      );
      copy[pkgIndex] = { ...copy[pkgIndex], items: itemsCopy };
      return copy;
    });
  };

  // Xác nhận đóng kiện & gửi API
  const handleSubmitMeasurement = async () => {
    if (!measuringGroup) return;

    // Validate kích thước
    for (let i = 0; i < packagesToPack.length; i++) {
      const pkg = packagesToPack[i];
      if (pkg.lengthMm <= 0 || pkg.widthMm <= 0 || pkg.heightMm <= 0 || pkg.weightG <= 0) {
        message.error(`Kiện #${i + 1}: Kích thước mm và trọng lượng g phải lớn hơn 0`);
        return;
      }
    }

    // Validate bảo toàn số lượng (MN09)
    for (const line of measuringGroup.lines) {
      let totalPacked = 0;
      for (const pkg of packagesToPack) {
        const it = pkg.items.find((item) => item.fulfillmentLineId === line.id);
        totalPacked += it ? it.quantity : 0;
      }
      if (totalPacked !== line.requestedQuantity) {
        message.error(
          `Sản phẩm "${line.sku?.name || line.skuId}": Tổng lượng đóng gói (${totalPacked}) phải đúng bằng số lượng yêu cầu (${line.requestedQuantity})`,
        );
        return;
      }
    }

    setSubmittingMeasurement(true);
    try {
      await apiClient.post('/order-processing/groups/pack-and-measure', {
        groupId: measuringGroup.id,
        packages: packagesToPack,
      });
      message.success(`Đã đóng gói và đo kích thước thành công cho nhóm ${measuringGroup.groupNumber}`);
      setModalOpen(false);
      setMeasuringGroup(null);
      await loadGroups();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Không thể đóng gói nhóm hàng');
    } finally {
      setSubmittingMeasurement(false);
    }
  };

  // Legacy actions
  const allocateLegacy = async (order: LegacyProcessingOrder) => {
    setActingId(order.id);
    try {
      await apiClient.post('/allocation/orders', {
        salesOrderId: order.id,
        idempotencyKey: `allocate_${order.id}_${crypto.randomUUID()}`,
      });
      message.success(`Đã chọn nguồn và giữ tồn kho cho ${order.orderNumber}`);
      await loadLegacy();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Không thể chọn nguồn hàng');
    } finally {
      setActingId(undefined);
    }
  };

  const packLegacy = (order: LegacyProcessingOrder) => {
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
          await loadLegacy();
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
            Chuẩn bị hàng & Đóng kiện
          </Title>
          <Text type="secondary">
            Quản lý quy trình chuẩn bị, đóng gói theo từng cửa hàng nguồn và đo đạc kích thước kiện vật lý.
          </Text>
        </Col>
        <Col>
          <Button
            icon={<ReloadOutlined />}
            loading={activeTab === 'groups' ? loadingGroups : loadingLegacy}
            onClick={() => (activeTab === 'groups' ? void loadGroups() : void loadLegacy())}
          >
            Làm mới
          </Button>
        </Col>
      </Row>

      <Card>
        <Tabs
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as 'groups' | 'legacy')}
          items={[
            {
              key: 'groups',
              label: (
                <span>
                  <AppstoreAddOutlined style={{ marginRight: 6 }} />
                  Nhóm chuẩn bị đa nguồn ({groups.length})
                </span>
              ),
              children: (
                <Table
                  rowKey="id"
                  loading={loadingGroups}
                  dataSource={groups}
                  scroll={{ x: 'max-content' }}
                  columns={[
                    {
                      title: 'Mã nhóm',
                      dataIndex: 'groupNumber',
                      width: 170,
                      render: (val: string) => <Text strong>{val}</Text>,
                    },
                    {
                      title: 'Đơn hàng',
                      width: 150,
                      render: (_, grp) => (
                        <div>
                          <Text strong>{grp.order.orderNumber}</Text>
                          {grp.order.customer?.name && (
                            <div style={{ fontSize: 12, color: '#64748b' }}>
                              {grp.order.customer.name}
                            </div>
                          )}
                        </div>
                      ),
                    },
                    {
                      title: 'Cửa hàng xuất',
                      width: 200,
                      render: (_, grp) => (
                        <div>
                          <Text strong>{grp.sourceLocation?.name || '—'}</Text>
                          <div style={{ fontSize: 12, color: '#64748b' }}>
                            {grp.sourceLocation?.address}
                          </div>
                        </div>
                      ),
                    },
                    {
                      title: 'Trạng thái',
                      width: 130,
                      render: (_, grp) => {
                        switch (grp.status) {
                          case 'PENDING':
                            return <Tag color="default">Chờ chuẩn bị</Tag>;
                          case 'PREPARING':
                            return <Tag color="processing">Đang chuẩn bị</Tag>;
                          case 'PACKED':
                            return <Tag color="success">Đã đóng kiện</Tag>;
                          case 'HANDED_OVER':
                            return <Tag color="purple">Đã bàn giao xe</Tag>;
                          case 'CANCELLED':
                            return <Tag color="error">Đã hủy</Tag>;
                          default:
                            return <Tag>{grp.status}</Tag>;
                        }
                      },
                    },
                    {
                      title: 'Dòng hàng',
                      width: 220,
                      render: (_, grp) => (
                        <Space direction="vertical" size={2}>
                          {grp.lines.map((ln) => (
                            <Text key={ln.id} style={{ fontSize: 12 }}>
                              • {ln.sku?.name || ln.sku?.skuCode || ln.skuId}: <b>{ln.requestedQuantity}</b> {ln.sku?.uom || 'đơn vị'}
                            </Text>
                          ))}
                        </Space>
                      ),
                    },
                    {
                      title: 'Kiện hàng thực tế',
                      width: 240,
                      render: (_, grp) => {
                        if (!grp.packages || grp.packages.length === 0) {
                          return <Tag>Chưa đo kiện</Tag>;
                        }
                        return (
                          <Space direction="vertical" size={4}>
                            {grp.packages.map((pkg) => (
                              <Tag color="cyan" key={pkg.id}>
                                {pkg.packageCode} ({pkg.lengthMm}x{pkg.widthMm}x{pkg.heightMm} mm, {(pkg.weightG / 1000).toFixed(1)} kg)
                              </Tag>
                            ))}
                          </Space>
                        );
                      },
                    },
                    {
                      title: 'Thao tác',
                      width: 180,
                      render: (_, grp) => (
                        <Space>
                          {grp.status === 'PENDING' && (
                            <Button
                              type="primary"
                              icon={<PlayCircleOutlined />}
                              onClick={() => void handleStartGroup(grp)}
                            >
                              Bắt đầu
                            </Button>
                          )}
                          {grp.status === 'PREPARING' && (
                            <Button
                              type="primary"
                              style={{ backgroundColor: '#16a34a' }}
                              icon={<InboxOutlined />}
                              onClick={() => handleOpenMeasureModal(grp)}
                            >
                              Đo & Đóng kiện
                            </Button>
                          )}
                          {grp.status === 'PACKED' && (
                            <Tag icon={<CheckCircleOutlined />} color="success">
                              Sẵn sàng điều phối
                            </Tag>
                          )}
                        </Space>
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: 'legacy',
              label: (
                <span>
                  <InboxOutlined style={{ marginRight: 6 }} />
                  Đơn một nguồn / Điểm nhận ({legacyOrders.length})
                </span>
              ),
              children: (
                <Table
                  rowKey="id"
                  loading={loadingLegacy}
                  dataSource={legacyOrders}
                  scroll={{ x: 'max-content' }}
                  columns={[
                    {
                      title: 'Đơn hàng',
                      dataIndex: 'orderNumber',
                      width: 140,
                      render: (value: string) => <Text strong>{value}</Text>,
                    },
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
                      render: (_, order) =>
                        order.allocatedSource?.name ? (
                          <ExpandableText text={order.allocatedSource.name} maxChars={22} maxWidth={170} />
                        ) : (
                          <Tag>Chưa chọn</Tag>
                        ),
                    },
                    {
                      title: 'Điểm nhận',
                      width: 180,
                      render: (_, order) =>
                        order.selectedPickupPoint?.name ? (
                          <ExpandableText text={order.selectedPickupPoint.name} maxChars={22} maxWidth={170} />
                        ) : (
                          '—'
                        ),
                    },
                    { title: 'Số dòng hàng', render: (_, order) => order.items?.length ?? 0 },
                    {
                      title: 'Kiện hàng',
                      render: (_, order) =>
                        order.packages?.length ? (
                          order.packages.map((pkg) => (
                            <Tag color="green" key={pkg.id}>
                              {pkg.packageCode}
                            </Tag>
                          ))
                        ) : (
                          <Tag>Chưa đóng</Tag>
                        ),
                    },
                    {
                      title: 'Thao tác',
                      render: (_, order) => (
                        <Space>
                          {!order.allocatedSource && (
                            <Button
                              loading={actingId === order.id}
                              onClick={() => void allocateLegacy(order)}
                            >
                              Chọn nguồn & giữ hàng
                            </Button>
                          )}
                          {order.allocatedSource && !order.packages?.length && (
                            <Button
                              type="primary"
                              loading={actingId === order.id}
                              onClick={() => packLegacy(order)}
                            >
                              Đóng kiện
                            </Button>
                          )}
                          {!!order.packages?.length && <Tag color="success">Đã chuẩn bị</Tag>}
                        </Space>
                      ),
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </Card>

      {/* Modal Đo Kích Thước & Đóng Kiện Thực Tế (P4 & MN09) */}
      <Modal
        title={
          <div>
            <InboxOutlined style={{ marginRight: 8, color: '#16a34a' }} />
            Đóng kiện & Khai báo số đo thực tế — {measuringGroup?.groupNumber}
          </div>
        }
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleSubmitMeasurement()}
        okText="Xác nhận đóng kiện"
        cancelText="Hủy"
        confirmLoading={submittingMeasurement}
        width={720}
      >
        {measuringGroup && (
          <div>
            <Text type="secondary">
              Đơn hàng: <b>{measuringGroup.order.orderNumber}</b> | Cửa hàng:{' '}
              <b>{measuringGroup.sourceLocation?.name}</b>
            </Text>

            <Divider style={{ margin: '12px 0' }}>Dòng hàng cần đóng gói</Divider>
            <Table
              size="small"
              pagination={false}
              dataSource={measuringGroup.lines}
              rowKey="id"
              columns={[
                { title: 'Mã SKU', render: (_, l) => l.sku?.skuCode || l.skuId },
                { title: 'Tên sản phẩm', render: (_, l) => l.sku?.name || '—' },
                { title: 'Yêu cầu', dataIndex: 'requestedQuantity', width: 90 },
                { title: 'ĐVT', render: (_, l) => l.sku?.uom || 'cái' },
              ]}
            />

            <Divider style={{ margin: '16px 0' }}>
              Danh sách kiện hàng ({packagesToPack.length})
            </Divider>

            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              {packagesToPack.map((pkg, idx) => (
                <Card
                  key={idx}
                  size="small"
                  title={<Text strong>Kiện #{idx + 1}</Text>}
                  extra={
                    packagesToPack.length > 1 && (
                      <Button danger type="link" size="small" onClick={() => handleRemovePackage(idx)}>
                        Xóa kiện
                      </Button>
                    )
                  }
                  style={{ background: '#f8fafc', border: '1px solid #cbd5e1' }}
                >
                  <Row gutter={12}>
                    <Col span={6}>
                      <Form.Item label="Dài (mm)" style={{ marginBottom: 8 }} required>
                        <InputNumber
                          min={1}
                          style={{ width: '100%' }}
                          value={pkg.lengthMm}
                          onChange={(v) => handlePackageDimChange(idx, 'lengthMm', v)}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={6}>
                      <Form.Item label="Rộng (mm)" style={{ marginBottom: 8 }} required>
                        <InputNumber
                          min={1}
                          style={{ width: '100%' }}
                          value={pkg.widthMm}
                          onChange={(v) => handlePackageDimChange(idx, 'widthMm', v)}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={6}>
                      <Form.Item label="Cao (mm)" style={{ marginBottom: 8 }} required>
                        <InputNumber
                          min={1}
                          style={{ width: '100%' }}
                          value={pkg.heightMm}
                          onChange={(v) => handlePackageDimChange(idx, 'heightMm', v)}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={6}>
                      <Form.Item label="Khối lượng (g)" style={{ marginBottom: 8 }} required>
                        <InputNumber
                          min={1}
                          step={100}
                          style={{ width: '100%' }}
                          value={pkg.weightG}
                          onChange={(v) => handlePackageDimChange(idx, 'weightG', v)}
                        />
                      </Form.Item>
                    </Col>
                  </Row>

                  <Text strong style={{ fontSize: 13 }}>
                    Phân bổ sản phẩm vào kiện #{idx + 1}:
                  </Text>
                  <Row gutter={[12, 8]} style={{ marginTop: 6 }}>
                    {measuringGroup.lines.map((line) => {
                      const itemAlloc = pkg.items.find(
                        (it) => it.fulfillmentLineId === line.id,
                      );
                      return (
                        <Col span={12} key={line.id}>
                          <Space>
                            <Text style={{ fontSize: 12 }}>
                              {line.sku?.name || line.sku?.skuCode} (tối đa {line.requestedQuantity}):
                            </Text>
                            <InputNumber
                              size="small"
                              min={0}
                              max={line.requestedQuantity}
                              value={itemAlloc?.quantity ?? 0}
                              onChange={(v) => handleItemQtyChange(idx, line.id, v)}
                            />
                          </Space>
                        </Col>
                      );
                    })}
                  </Row>
                </Card>
              ))}

              <Button
                type="dashed"
                icon={<PlusOutlined />}
                onClick={handleAddPackage}
                style={{ width: '100%' }}
              >
                Thêm kiện hàng khác cho nhóm này
              </Button>
            </Space>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default OrderProcessingPage;
