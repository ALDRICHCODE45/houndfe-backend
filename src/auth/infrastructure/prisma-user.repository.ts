/**
 * ADAPTER: PrismaUserRepository
 *
 * Concrete implementation of IUserRepository using Prisma.
 *
 * Translates between domain entities and database records.
 * Contains mappers that convert DB rows ↔ domain objects.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { User } from '../domain/user.entity';
import { Email } from '../domain/value-objects/email.value-object';
import type { IUserRepository, UserWithRoles } from '../domain/user.repository';

@Injectable()
export class PrismaUserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(user: User): Promise<User> {
    const data = user.toPersistence();
    const saved = await this.prisma.user.upsert({
      where: { id: data.id },
      update: {
        name: data.name,
        email: data.email,
        hashedRefreshToken: data.hashedRefreshToken,
        isActive: data.isActive,
        updatedAt: data.updatedAt,
      },
      create: data,
    });
    return this.toDomain(saved);
  }

  async findById(id: string): Promise<User | null> {
    const data = await this.prisma.user.findUnique({ where: { id } });
    return data ? this.toDomain(data) : null;
  }

  async findByEmail(email: Email): Promise<User | null> {
    const data = await this.prisma.user.findUnique({
      where: { email: email.value },
    });
    return data ? this.toDomain(data) : null;
  }

  async existsByEmail(email: Email): Promise<boolean> {
    const count = await this.prisma.user.count({
      where: { email: email.value },
    });
    return count > 0;
  }

  async findAll(
    page: number,
    limit: number,
  ): Promise<{ users: User[]; total: number }> {
    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({ skip, take: limit }),
      this.prisma.user.count(),
    ]);
    return { users: users.map((u) => this.toDomain(u)), total };
  }

  async findByIdWithRoles(id: string): Promise<UserWithRoles | null> {
    const data = await this.prisma.user.findUnique({
      where: { id },
      include: {
        tenantMemberships: {
          include: { role: { select: { id: true, name: true } } },
        },
      },
    });
    if (!data) return null;
    return {
      user: this.toDomain(data),
      roles: data.tenantMemberships.map((ur) => ({
        id: ur.role.id,
        name: ur.role.name,
      })),
    };
  }

  async assignRoles(userId: string, roleIds: string[]): Promise<void> {
    void userId;
    void roleIds;
    throw new Error(
      'assignRoles is deprecated. Use tenant membership assignment flow instead.',
    );
  }

  async update(user: User): Promise<User> {
    return this.save(user);
  }

  private toDomain(data: {
    id: string;
    email: string;
    hashedPassword: string;
    name: string;
    isActive: boolean;
    hashedRefreshToken: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): User {
    return User.fromPersistence(data);
  }
}
