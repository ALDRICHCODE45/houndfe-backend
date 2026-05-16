import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { AssignableUserDto } from './dto/assignable-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findAssignable(): Promise<AssignableUserDto[]> {
    const tenantId = this.tenantPrisma.getTenantId();

    return this.tenantPrisma.getClient().user.findMany({
      where: {
        isActive: true,
        tenantMemberships: {
          some: { tenantId },
        },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }
}
