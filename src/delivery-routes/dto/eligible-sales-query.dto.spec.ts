/**
 * DTO SPEC: EligibleSalesQueryDto — delivery-routes / T4.
 *
 * Shape-only validation: pagination defaults/bounds, q length, and the
 * optional `contextRouteId` UUID. Tenant scoping and authorization are
 * NOT the DTO's job.
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { EligibleSalesQueryDto } from './eligible-sales-query.dto';

const CONTEXT_ROUTE_ID = '9f0f4b0a-6b1e-4f5d-9c8a-2d4e6f8a1b3c';

const makeDto = (value: Record<string, unknown>) =>
  plainToInstance(EligibleSalesQueryDto, value);

describe('EligibleSalesQueryDto', () => {
  it('defaults page=1 and limit=20', async () => {
    const dto = makeDto({});

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  it('rejects page < 1', async () => {
    const errors = await validate(makeDto({ page: 0 }));

    expect(errors.map((e) => e.property)).toContain('page');
  });

  it('rejects a non-integer page', async () => {
    const errors = await validate(makeDto({ page: 'abc' }));

    expect(errors.map((e) => e.property)).toContain('page');
  });

  it('rejects limit > 100', async () => {
    const errors = await validate(makeDto({ limit: 101 }));

    expect(errors.map((e) => e.property)).toContain('limit');
  });

  it('accepts q and a UUID v4 contextRouteId', async () => {
    const errors = await validate(
      makeDto({ q: 'Ana', contextRouteId: CONTEXT_ROUTE_ID }),
    );

    expect(errors).toHaveLength(0);
  });

  it('rejects a non-uuid contextRouteId', async () => {
    const errors = await validate(makeDto({ contextRouteId: 'not-a-uuid' }));

    expect(errors.map((e) => e.property)).toContain('contextRouteId');
  });
});
