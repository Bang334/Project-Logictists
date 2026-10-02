import { PrismaClient, ProductStatus, SkuStatus } from '@prisma/client';

export async function seedRetailCatalog(prisma: PrismaClient) {
  console.log('🧹 Đang vô hiệu hóa và ẩn hoàn toàn các sản phẩm tiêu dùng cũ (Gạo, Sữa, Mì gói)...');
  
  // Vô hiệu hóa và lưu trữ (ARCHIVE) các SKU thực phẩm cũ để không xuất hiện trong catalog
  await prisma.sku.updateMany({
    where: { skuCode: { in: ['RICE-ST25-5KG', 'MILK-1L', 'NOODLE-PACK'] } },
    data: {
      status: SkuStatus.INACTIVE,
      isSellable: false,
    },
  });

  // Chuyển trạng thái sản phẩm sang DISCONTINUED
  await prisma.product.updateMany({
    where: { code: { in: ['RICE-ST25', 'MILK-FRESH', 'NOODLE'] } },
    data: {
      status: ProductStatus.DISCONTINUED,
    },
  });

  // Tắt danh mục GROCERY
  await prisma.category.updateMany({
    where: { code: 'GROCERY' },
    data: {
      active: false,
    },
  });

  console.log('✅ Đã ẩn hoàn toàn các sản phẩm thực phẩm cũ khỏi Catalog và Cổng mua hàng.');
}
