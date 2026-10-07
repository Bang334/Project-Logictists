import React, { useCallback, useState, useEffect } from 'react';
import {
  Table,
  Card,
  Tag,
  Button,
  Space,
  Input,
  Select,
  Row,
  Col,
  Typography,
  Modal,
  Form,
  InputNumber,
  App as AntdApp,
  Divider,
  Image,
  Upload,
  Tooltip,
} from 'antd';
import {
  PlusOutlined,
  SearchOutlined,
  ReloadOutlined,
  BarcodeOutlined,
  AppstoreOutlined,
  UploadOutlined,
  PictureOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { apiClient } from '../api/client';
import { getProductImage } from '../utils/demoAssets';

const { Title, Text } = Typography;
const { Option } = Select;

interface SkuItem {
  id: string;
  skuCode: string;
  name: string;
  uom: string;
  weightGrams?: number;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  storageCondition: 'AMBIENT' | 'COOL' | 'CHILLED';
  isSellable: boolean;
  barcode?: string;
  salePrice?: number | string;
  barcodes?: { barcode: string; isPrimary: boolean }[];
  resolvedPrice?: {
    basePrice: number;
    salePrice: number | null;
    effectivePrice: number;
    vatRate: number;
  };
}

interface ProductItem {
  id: string;
  code: string;
  name: string;
  brand?: string;
  imageUrl?: string;
  status: string;
  category?: { id: string; name: string };
  skus: SkuItem[];
}

const CatalogPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [searchText, setSearchText] = useState<string>('');
  const [storageFilter, setStorageFilter] = useState<string | undefined>(undefined);
  
  // Modal tạo sản phẩm mới
  const [isModalVisible, setIsModalVisible] = useState<boolean>(false);
  const [createUploading, setCreateUploading] = useState<boolean>(false);
  const [form] = Form.useForm();
  const currentImageUrl = Form.useWatch('imageUrl', form);

  // Modal đổi ảnh sản phẩm
  const [isEditImageModalVisible, setIsEditImageModalVisible] = useState<boolean>(false);
  const [editingProduct, setEditingProduct] = useState<ProductItem | null>(null);
  const [editUploading, setEditUploading] = useState<boolean>(false);
  const [editImageUrl, setEditImageUrl] = useState<string>('');

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/catalog/products', {
        params: {
          search: searchText || undefined,
          storageCondition: storageFilter || undefined,
        },
      });
      setProducts(res.data?.data ?? []);
    } catch (e: any) {
      setProducts([]);
      message.error(e.response?.data?.message || 'Không thể tải danh mục sản phẩm');
    } finally {
      setLoading(false);
    }
  }, [message, searchText, storageFilter]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  // Upload file lên Cloudinary thông qua backend API
  const uploadImageToCloudinary = async (file: File): Promise<string> => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await apiClient.post('/files/upload?folder=tms/products', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return res.data.url;
  };

  const handleCreateProduct = async (values: any) => {
    try {
      // 1. Tạo Product trong database
      const productResponse = await apiClient.post('/catalog/products', {
        code: values.code,
        name: values.name,
        brand: values.brand,
        imageUrl: values.imageUrl || undefined,
        status: 'ACTIVE',
      });

      // 2. Tạo SKU liên kết với Product
      await apiClient.post('/catalog/skus', {
        productId: productResponse.data.id,
        skuCode: values.skuCode,
        name: values.name,
        uom: values.uom,
        storageCondition: values.storageCondition,
        basePrice: values.price,
        isSellable: true,
        allowPickup: true,
        status: 'ACTIVE',
      });

      message.success(`Đã thêm sản phẩm "${values.name}" vào database thành công!`);
      setIsModalVisible(false);
      form.resetFields();
      fetchCatalog();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Không thể tạo sản phẩm, vui lòng thử lại.');
    }
  };

  const openEditImageModal = (product: ProductItem) => {
    setEditingProduct(product);
    setEditImageUrl(product.imageUrl || '');
    setIsEditImageModalVisible(true);
  };

  const handleSaveProductImage = async () => {
    if (!editingProduct) return;
    try {
      await apiClient.patch(`/catalog/products/${editingProduct.id}`, {
        imageUrl: editImageUrl,
      });
      message.success(`Đã cập nhật link ảnh cho sản phẩm ${editingProduct.name} vào database!`);
      setIsEditImageModalVisible(false);
      setEditingProduct(null);
      fetchCatalog();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Không thể cập nhật ảnh sản phẩm.');
    }
  };

  const renderStorageTag = (condition: 'AMBIENT' | 'COOL' | 'CHILLED') => {
    switch (condition) {
      case 'COOL':
        return <Tag color="cyan">Mát (10-15°C)</Tag>;
      case 'CHILLED':
        return <Tag color="blue">Lạnh (0-4°C)</Tag>;
      default:
        return <Tag color="green">Thường (Ambient)</Tag>;
    }
  };

  // Flatten SKUs để hiển thị theo từng mặt hàng bán
  const tableData = products.flatMap((product) =>
    product.skus.map((sku) => ({
      key: sku.id,
      productId: product.id,
      productCode: product.code,
      productName: product.name,
      brand: product.brand,
      categoryName: product.category?.name || 'Chung',
      productImage: getProductImage(product.code, product.imageUrl),
      rawImageUrl: product.imageUrl,
      skuCode: sku.skuCode,
      skuName: sku.name,
      uom: sku.uom,
      storageCondition: sku.storageCondition,
      barcode: sku.barcode || sku.barcodes?.[0]?.barcode || 'N/A',
      price: Number(sku.salePrice ?? sku.resolvedPrice?.effectivePrice ?? 0),
      rawProduct: product,
    })),
  );

  const filteredData = tableData.filter((item) => {
    const matchSearch =
      !searchText ||
      item.productName.toLowerCase().includes(searchText.toLowerCase()) ||
      item.skuCode.toLowerCase().includes(searchText.toLowerCase()) ||
      item.barcode.includes(searchText);
    const matchStorage = !storageFilter || item.storageCondition === storageFilter;
    return matchSearch && matchStorage;
  });

  const columns = [
    {
      title: 'Ảnh SP',
      key: 'image',
      width: 90,
      render: (_: any, record: any) => (
        <div style={{ position: 'relative', width: 64, height: 64, margin: '0 auto' }}>
          <Image
            src={record.productImage}
            alt={record.productName}
            width={64}
            height={64}
            fallback="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' rx='8' fill='%23e2e8f0'/%3E%3C/svg%3E"
            style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #e2e8f0' }}
            preview={true}
          />
          <Tooltip title="Đổi ảnh sản phẩm (Upload Cloudinary)">
            <Button
              type="primary"
              shape="circle"
              size="small"
              icon={<EditOutlined style={{ fontSize: 10 }} />}
              onClick={() => openEditImageModal(record.rawProduct)}
              style={{
                position: 'absolute',
                bottom: -4,
                right: -4,
                width: 22,
                height: 22,
                minWidth: 22,
                padding: 0,
                boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
              }}
            />
          </Tooltip>
        </div>
      ),
    },
    {
      title: 'Mã SKU / Barcode',
      key: 'skuCode',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2}>
          <Text strong style={{ color: '#1e40af' }}>{record.skuCode}</Text>
          <Text type="secondary" style={{ fontSize: '12px' }}>
            <BarcodeOutlined style={{ marginRight: 4 }} />
            {record.barcode}
          </Text>
        </Space>
      ),
    },
    {
      title: 'Tên Sản Phẩm & SKU',
      key: 'name',
      render: (_: any, record: any) => (
        <div>
          <Text strong>{record.productName}</Text>
          <br />
          <Text type="secondary" style={{ fontSize: '13px' }}>
            {record.categoryName} {record.brand ? `· Thương hiệu: ${record.brand}` : ''}
          </Text>
        </div>
      ),
    },
    {
      title: 'Đơn Vị Tính',
      key: 'condition',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2}>
          <Tag color="purple">{record.uom}</Tag>
          {renderStorageTag(record.storageCondition)}
        </Space>
      ),
    },
    {
      title: 'Giá Niêm Yết (VND)',
      key: 'price',
      align: 'right' as const,
      render: (_: any, record: any) => (
        <div>
          <Text strong style={{ color: '#047857', fontSize: '15px' }}>
            {new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(record.price)}
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: '11px' }}>Giá lưu trong CSDL</Text>
        </div>
      ),
    },
    {
      title: 'Thao tác',
      key: 'action',
      width: 110,
      align: 'center' as const,
      render: (_: any, record: any) => (
        <Button
          size="small"
          icon={<PictureOutlined />}
          onClick={() => openEditImageModal(record.rawProduct)}
        >
          Đổi ảnh
        </Button>
      ),
    },
  ];

  return (
    <div className="tms-page">
      <Row justify="space-between" align="middle" className="tms-page-header" gutter={[16, 16]}>
        <Col>
          <Text className="tms-page-eyebrow">Master data · Retail</Text>
          <Title level={3} style={{ margin: 0 }}>
            <AppstoreOutlined style={{ marginRight: 8, color: '#2563eb' }} />
            Quản Lý Danh Mục & Giá Bán Lẻ (Catalog & Pricing)
          </Title>
          <Text type="secondary">
            Hình ảnh sản phẩm được lưu trực tiếp dạng liên kết Cloudinary trong CSDL PostgreSQL
          </Text>
        </Col>
        <Col>
          <Space wrap className="tms-page-actions">
            <Button icon={<ReloadOutlined />} onClick={fetchCatalog} loading={loading}>
              Làm mới
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setIsModalVisible(true)}
            >
              Thêm Sản Phẩm Mới
            </Button>
          </Space>
        </Col>
      </Row>

      <Card style={{ marginBottom: 20, borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} md={12}>
            <Input
              placeholder="Tìm kiếm theo mã SKU, tên sản phẩm hoặc mã vạch barcode..."
              prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              allowClear
            />
          </Col>
          <Col xs={24} md={8}>
            <Select
              style={{ width: '100%' }}
              placeholder="Lọc theo điều kiện bảo quản"
              allowClear
              value={storageFilter}
              onChange={(val) => setStorageFilter(val)}
            >
              <Option value="AMBIENT">Nhiệt độ thường (Ambient)</Option>
              <Option value="COOL">Bảo quản mát (Cool 10-15°C)</Option>
              <Option value="CHILLED">Thực phẩm lạnh (Chilled 0-4°C)</Option>
            </Select>
          </Col>
        </Row>
      </Card>

      <Card style={{ borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
        <Table
          columns={columns}
          dataSource={filteredData}
          loading={loading}
          scroll={{ x: 'max-content' }}
          pagination={{ pageSize: 8, showTotal: (total) => `Tổng cộng ${total} SKU` }}
        />
      </Card>

      {/* Modal tạo sản phẩm mới */}
      <Modal
        title="Thêm Mặt Hàng / SKU Mới (Lưu CSDL)"
        open={isModalVisible}
        onCancel={() => setIsModalVisible(false)}
        footer={null}
        width={640}
      >
        <Form form={form} layout="vertical" onFinish={handleCreateProduct}>
          <Form.Item name="name" label="Tên Sản Phẩm" rules={[{ required: true, message: 'Vui lòng nhập tên' }]}>
            <Input placeholder="Ví dụ: Thép cuộn D8 Hòa Phát" />
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="code" label="Mã Sản Phẩm" rules={[{ required: true, message: 'Vui lòng nhập mã' }]}>
                <Input placeholder="THEP-HP-CUON" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="skuCode" label="Mã SKU" rules={[{ required: true, message: 'Vui lòng nhập SKU' }]}>
                <Input placeholder="SKU-THEP-D8" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="brand" label="Thương Hiệu / Nhà Sản Xuất">
                <Input placeholder="Hòa Phát, Đồng Tâm, Austdoor..." />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="price" label="Giá Bán (VND)" rules={[{ required: true, message: 'Nhập giá' }]}>
                <InputNumber style={{ width: '100%' }} min={0} step={1000} placeholder="15000" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="uom" label="Đơn Vị Tính" initialValue="THANH">
                <Input placeholder="THANH, TẤN, M2, BAO, THÙNG..." />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="storageCondition" label="Điều Kiện Bảo Quản" initialValue="AMBIENT">
                <Select>
                  <Option value="AMBIENT">Thường (Ambient)</Option>
                  <Option value="COOL">Mát (Cool 10-15°C)</Option>
                  <Option value="CHILLED">Lạnh (Chilled 0-4°C)</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>

          {/* Upload ảnh Cloudinary và lưu link vào database */}
          <Form.Item
            name="imageUrl"
            label="Hình Ảnh Sản Phẩm (Lưu link Cloudinary vào CSDL)"
            help="Tải ảnh trực tiếp lên Cloudinary hoặc dán đường dẫn ảnh HTTPS"
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space>
                <Upload
                  showUploadList={false}
                  beforeUpload={async (file) => {
                    setCreateUploading(true);
                    try {
                      const url = await uploadImageToCloudinary(file);
                      form.setFieldsValue({ imageUrl: url });
                      message.success('Đã tải ảnh lên Cloudinary và điền link thành công!');
                    } catch (err: any) {
                      message.error(err.response?.data?.message || 'Lỗi tải ảnh lên Cloudinary');
                    } finally {
                      setCreateUploading(false);
                    }
                    return false;
                  }}
                >
                  <Button icon={<UploadOutlined />} loading={createUploading}>
                    {createUploading ? 'Đang tải lên Cloudinary...' : 'Tải ảnh từ máy tính (Cloudinary)'}
                  </Button>
                </Upload>
                {currentImageUrl && (
                  <Button danger type="link" onClick={() => form.setFieldsValue({ imageUrl: '' })}>
                    Xóa ảnh
                  </Button>
                )}
              </Space>

              <Input
                placeholder="https://res.cloudinary.com/.../tms/products/..."
                value={currentImageUrl}
                onChange={(e) => form.setFieldsValue({ imageUrl: e.target.value })}
              />

              {currentImageUrl && (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Image
                    src={currentImageUrl}
                    alt="Preview"
                    width={80}
                    height={80}
                    style={{ objectFit: 'cover', borderRadius: 6, border: '1px solid #cbd5e1' }}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Ảnh xem trước từ Cloudinary. Khi lưu, đường dẫn này sẽ được ghi vào cột <b>imageUrl</b> của bảng <b>products</b> trong PostgreSQL.
                  </Text>
                </div>
              )}
            </Space>
          </Form.Item>

          <Divider style={{ margin: '16px 0' }} />
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setIsModalVisible(false)}>Hủy</Button>
              <Button type="primary" htmlType="submit" style={{ background: '#2563eb' }}>
                Lưu Vào Cơ Sở Dữ Liệu
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* Modal Cập Nhật / Đổi Ảnh Sản Phẩm */}
      <Modal
        title={`Cập Nhật Ảnh Cho: ${editingProduct?.name || ''}`}
        open={isEditImageModalVisible}
        onCancel={() => {
          setIsEditImageModalVisible(false);
          setEditingProduct(null);
        }}
        onOk={handleSaveProductImage}
        okText="Lưu Vào CSDL"
        cancelText="Đóng"
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
          <Text type="secondary">
            Mã sản phẩm: <b>{editingProduct?.code}</b>. Ảnh mới sẽ được tải lên Cloudinary và lưu link trực tiếp vào bảng <b>products</b>.
          </Text>

          <Upload
            showUploadList={false}
            beforeUpload={async (file) => {
              setEditUploading(true);
              try {
                const url = await uploadImageToCloudinary(file);
                setEditImageUrl(url);
                message.success('Đã tải ảnh lên Cloudinary thành công!');
              } catch (err: any) {
                message.error(err.response?.data?.message || 'Lỗi tải ảnh lên Cloudinary');
              } finally {
                setEditUploading(false);
              }
              return false;
            }}
          >
            <Button icon={<UploadOutlined />} loading={editUploading} type="dashed" style={{ width: '100%', height: 45 }}>
              {editUploading ? 'Đang tải lên Cloudinary...' : 'Chọn ảnh mới từ máy tính để tải lên Cloudinary'}
            </Button>
          </Upload>

          <Divider orientation="left" plain style={{ margin: '8px 0', fontSize: 12 }}>
            Hoặc nhập trực tiếp link ảnh HTTPS
          </Divider>

          <Input
            placeholder="https://res.cloudinary.com/..."
            value={editImageUrl}
            onChange={(e) => setEditImageUrl(e.target.value)}
          />

          {editImageUrl && (
            <div style={{ textAlign: 'center', marginTop: 12, padding: 12, background: '#f8fafc', borderRadius: 8 }}>
              <Image
                src={editImageUrl}
                alt="Preview"
                width={120}
                height={120}
                style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #cbd5e1' }}
              />
              <div style={{ marginTop: 6 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>Xem trước ảnh sẽ lưu vào CSDL</Text>
              </div>
            </div>
          )}
        </Space>
      </Modal>
    </div>
  );
};

export default CatalogPage;
