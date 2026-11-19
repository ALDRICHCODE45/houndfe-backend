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
import { slaLevel, type SlaAnchors } from '../domain/chatbot-sla';
import { loadSlaPolicy, type RawDb } from './chatbot-sla-policy';

@Injectable()
export class PrismaSlaPauseReader implements SlaPauseReader {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private loadPolicy() {
    // SAFETY: `loadSlaPolicy` runs raw SQL with an explicit tenantId, which the
    // tenant-extended client supports like any Prisma client.
    const db = this.tenantPrisma.getClient() as unknown as RawDb;
    return loadSlaPolicy(db, this.tenantPrisma.getTenantId());
  }

  async pauseAt(now: Date) {
    const policy = await this.loadPolicy();
    return slaPauseAt(policy.calendar, now);
  }

  /**
   * S8: the same single settings lookup serves the pause and the traffic light
   * (`slaLevel`): business time from the active clock with the tenant's
   * calendar, the instants the sweep records milestones from.
   */
  async viewAt(now: Date) {
    const policy = await this.loadPolicy();
    return {
      pause: slaPauseAt(policy.calendar, now),
      level: (anchors: SlaAnchors) => slaLevel(policy, anchors, now),
    };
  }
}
