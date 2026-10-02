// Asset Cloudinary URLs for Logistics Vehicles & Facilities
const CLOUDINARY_BASE = 'https://res.cloudinary.com/dwrg5ars1/image/upload';

export const CLOUDINARY_ASSETS = {
  // Địa điểm & phương tiện vận tải
  SHOWROOM_STORE: `${CLOUDINARY_BASE}/v1790943199/tms/products/showroom-store.jpg`,
  WAREHOUSE_CENTRAL: `${CLOUDINARY_BASE}/v1790943209/tms/products/warehouse-central.jpg`,
  TRUCK_FLATBED: `${CLOUDINARY_BASE}/v1790943207/tms/products/truck-flatbed.jpg`,
  TRUCK_HEAVY: `${CLOUDINARY_BASE}/v1790943208/tms/products/truck-heavy.jpg`,
  TRUCK_BOX: `${CLOUDINARY_BASE}/v1790943212/tms/vehicles/box-truck.webp`,
  TRUCK_REFRIGERATED: `${CLOUDINARY_BASE}/v1790943213/tms/vehicles/refrigerated-truck.webp`,
};

// Ảnh mặc định cho sản phẩm khi chưa có link ảnh trong cơ sở dữ liệu
export const DEFAULT_PRODUCT_IMAGE = `${CLOUDINARY_BASE}/v1790943201/tms/products/steel-rebar-d16.jpg`;

/**
 * Lấy link ảnh của sản phẩm:
 * - Link ảnh được đọc trực tiếp từ Database (cột imageUrl của bảng products / API trả về).
 * - Tuyệt đối không hardcode mapping mã sản phẩm trong mã nguồn frontend.
 * - Chỉ fallback về DEFAULT_PRODUCT_IMAGE khi sản phẩm chưa được gán ảnh trong Database.
 */
export const getProductImage = (codeOrImage?: string | null, maybeImageUrl?: string | null): string => {
  // Trường hợp truyền 2 tham số: (code, imageUrl)
  if (maybeImageUrl && maybeImageUrl.trim().length > 0 && !maybeImageUrl.endsWith('.svg')) {
    return maybeImageUrl;
  }
  // Trường hợp tham số thứ nhất chính là imageUrl (bắt đầu bằng http hoặc /)
  if (codeOrImage && (codeOrImage.startsWith('http://') || codeOrImage.startsWith('https://') || codeOrImage.startsWith('/'))) {
    if (!codeOrImage.endsWith('.svg')) {
      return codeOrImage;
    }
  }
  return DEFAULT_PRODUCT_IMAGE;
};

export const getVehicleImage = (vehicleType: string, model: string) => {
  const description = `${vehicleType} ${model}`.toLocaleLowerCase('vi-VN');
  const isRefrigerated =
    description.includes('lạnh') ||
    description.includes('đông') ||
    description.includes('refrigerated');

  if (isRefrigerated) {
    return CLOUDINARY_ASSETS.TRUCK_REFRIGERATED;
  }
  if (
    description.includes('cẩu') ||
    description.includes('bán tải') ||
    description.includes('thép') ||
    description.includes('thùng hở') ||
    description.includes('flatbed')
  ) {
    return CLOUDINARY_ASSETS.TRUCK_FLATBED;
  }
  if (
    description.includes('nặng') ||
    description.includes('đầu kéo') ||
    description.includes('15') ||
    description.includes('8')
  ) {
    return CLOUDINARY_ASSETS.TRUCK_HEAVY;
  }

  return CLOUDINARY_ASSETS.TRUCK_BOX;
};

export const getLocationImage = (type: string) => {
  if (type === 'SHOWROOM' || type === 'STORE') {
    return CLOUDINARY_ASSETS.SHOWROOM_STORE;
  }
  return CLOUDINARY_ASSETS.WAREHOUSE_CENTRAL;
};
