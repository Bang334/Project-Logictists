import { Principal, branchFilter } from '../auth/access';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  async findAll(user: Principal) {
    const scope = branchFilter(user, 'customers.read');
    return this.prisma.customer.findMany({
      where: Object.keys(scope).length ? { orders: { some: { branchId: scope } } } : {},
      include: {
        _count: {
          select: { orders: { where: { branchId: scope } } },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string, user: Principal) {
    const scope = branchFilter(user, 'customers.read');
    const result = await this.prisma.customer.findFirst({
      where: { id, ...(Object.keys(scope).length ? { orders: { some: { branchId: scope } } } : {}) },
      include: {
        orders: {
          where: { branchId: scope },
          take: 10,
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!result) throw new NotFoundException('Tài nguyên không tồn tại hoặc ngoài phạm vi được cấp');
    return result;
  }
}
