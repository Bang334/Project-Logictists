import { describe, expect, it } from 'vitest';
import { CLOUDINARY_ASSETS, DEFAULT_PRODUCT_IMAGE, getProductImage, getVehicleImage } from '../utils/demoAssets';

describe('demo asset mapping', () => {
  it('uses a persisted database product imageUrl before the fallback', () => {
    expect(getProductImage('THEP-HP-D16', 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943201/tms/products/custom-steel.jpg')).toBe(
      'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943201/tms/products/custom-steel.jpg',
    );
    // Khi sản phẩm không có ảnh trong database (null hoặc undefined)
    expect(getProductImage('THEP-HP-D16', null)).toBe(DEFAULT_PRODUCT_IMAGE);
    expect(getProductImage('PROD-CUSTOM', undefined)).toBe(DEFAULT_PRODUCT_IMAGE);
  });

  it('selects the refrigerated vehicle image from Vietnamese vehicle data', () => {
    expect(getVehicleImage('Xe tải lạnh 1.5 tấn', 'Demo')).toBe(
      CLOUDINARY_ASSETS.TRUCK_REFRIGERATED,
    );
    expect(getVehicleImage('Xe tải 5 tấn', 'Thùng kín')).toBe(
      CLOUDINARY_ASSETS.TRUCK_BOX,
    );
  });
});
