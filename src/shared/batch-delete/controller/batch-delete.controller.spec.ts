/**
 * BatchDeleteController — strict TDD unit spec.
 *
 * Verifies the mixin factory output:
 *  - exposes `POST /<path>/batch-delete`
 *  - declares `@RequirePermissions(['batch_delete', subject])`
 *  - delegates body parsing + orchestrator call
 *  - returns 200 with `{ deleted: number }`
 *
 * Spec: batch-delete/spec.md R3, R6.
 */
import 'reflect-metadata';
import { POST } from './batch-delete.controller';
import { PERMISSIONS_KEY } from '../../../auth/authorization/decorators/require-permissions.decorator';
import type { BatchDeleteOrchestrator } from '../orchestrator/batch-delete.orchestrator';
import type { BatchDeletableService } from '../batch-delete.types';

describe('BatchDeleteController (extendController)', () => {
  function makeOrchestrator(): jest.Mocked<
    Pick<BatchDeleteOrchestrator, 'execute'>
  > {
    return {
      execute: jest.fn().mockResolvedValue({ deleted: 7 }),
    };
  }

  function makeService(): jest.Mocked<
    Pick<BatchDeletableService, 'executeInTransaction'>
  > {
    return {
      executeInTransaction: jest.fn().mockResolvedValue(0),
    };
  }

  it('exposes the controller class via the factory', () => {
    const ControllerClass = POST({ subject: 'Promotion', path: 'promotions' });
    expect(typeof ControllerClass).toBe('function');
    // The factory returns a class decorated with @Controller('promotions').
    const pathMeta = Reflect.getMetadata('path', ControllerClass);
    expect(pathMeta).toBe('promotions');
  });

  it('declares @RequirePermissions([batch_delete, subject]) on the handler', () => {
    const ControllerClass = POST({ subject: 'Promotion', path: 'promotions' });
    const handler = ControllerClass.prototype.batchDelete;
    expect(typeof handler).toBe('function');
    const meta = Reflect.getMetadata(PERMISSIONS_KEY, handler);
    expect(meta).toEqual([['batch_delete', 'Promotion']]);
  });

  it('handles a valid batch and returns { deleted: N }', async () => {
    const orchestrator = makeOrchestrator();
    const service = makeService();
    const ControllerClass = POST({
      subject: 'Promotion',
      path: 'promotions',
    });
    const instance = new ControllerClass(orchestrator, service);

    const dto = {
      ids: [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
      ],
    };

    const result = await instance.batchDelete(dto);
    expect(result).toEqual({ deleted: 7 });
    expect(orchestrator.execute).toHaveBeenCalledWith(dto.ids);
  });

  it('uses the provided subject and path verbatim', () => {
    const ControllerClass = POST({
      subject: 'Customer',
      path: 'customers',
    });
    expect(Reflect.getMetadata('path', ControllerClass)).toBe('customers');
    const handler = ControllerClass.prototype.batchDelete;
    const meta = Reflect.getMetadata(PERMISSIONS_KEY, handler);
    expect(meta).toEqual([['batch_delete', 'Customer']]);
  });

  it('accepts a generic service that implements BatchDeletableService', () => {
    // The controller factory is generic over the service; the only
    // method it ever invokes on the service is whatever the
    // BatchDeleteOrchestrator needs (orchestrator owns the lifecycle).
    // The factory should compile / accept a service without complaining.
    const ControllerClass = POST({
      subject: 'Promotion',
      path: 'promotions',
    });
    const orchestrator = makeOrchestrator();
    const service: Pick<BatchDeletableService, 'executeInTransaction'> = {
      executeInTransaction: jest.fn(),
    };
    const instance = new ControllerClass(orchestrator, service);
    expect(instance).toBeInstanceOf(ControllerClass);
  });
});