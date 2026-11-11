/**
 * `SlaPauseReader` over the tenant's settings (unit 7c; contract §5.4):
 * `slaPaused` = the calendar says "closed now" (outside hours or a closed
 * date), `slaResumesAt` = the next opening. One primary-key lookup of the
 * settings row per read call (no lock; the defaults when the tenant has none).
 */
import { Injectable } from '@nestjs/common';
import { SlaPauseReader } from '../application/chatbot-request-reads.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { slaPauseAt } from '../domain/chatbot-sla-sweep';
import { loadSlaPolicy, type RawDb } from './chatbot-sla-policy';

@Injectable()
export class PrismaSlaPauseReader implements SlaPauseReader {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async pauseAt(now: Date) {
    // SAFETY: `loadSlaPolicy` runs raw SQL with an explicit tenantId, which the
    // tenant-extended client supports like any Prisma client.
    const db = this.tenantPrisma.getClient() as unknown as RawDb;
    const policy = await loadSlaPolicy(db, this.tenantPrisma.getTenantId());
    return slaPauseAt(policy.calendar, now);
  }
}
