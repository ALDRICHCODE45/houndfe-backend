/**
 * AdminPermissionService - Permission listing use case.
 *
 * RESPONSIBILITIES:
 * - List all permissions grouped by subject
 *
 * Read-only service (permissions are seeded, not managed via API).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { IPermissionRepository } from '../auth/authorization/domain/permission.repository';
import { PERMISSION_REPOSITORY } from '../auth/authorization/domain/permission.repository';

@Injectable()
export class AdminPermissionService {
  constructor(
    @Inject(PERMISSION_REPOSITORY)
    private readonly permissionRepo: IPermissionRepository,
  ) {}

  async findAll(): Promise<{
    [subject: string]: Array<{
      id: string;
      action: string;
      description: string | null;
    }>;
  }> {
    const permissions = await this.permissionRepo.findAll();

    // Group by subject
    const grouped: {
      [subject: string]: Array<{
        id: string;
        action: string;
        description: string | null;
      }>;
    } = {};

    for (const p of permissions) {
      if (!grouped[p.subject]) {
        grouped[p.subject] = [];
      }
      grouped[p.subject].push({
        id: p.id,
        action: p.action,
        description: p.description,
      });
    }

    return grouped;
  }
}
