/**
 * PdfGenerationService — instantiation test (WU1 skeleton).
 *
 * In WU1 the service is a stub: no deps, no behavior, just `@Injectable()`
 * so the module can compile + the provider registration test can pass.
 *
 * The real `render()` orchestration, OnModuleInit font registration,
 * error-mapping, etc. land in WU4. This spec is intentionally minimal:
 * it proves the service is constructible and instantiable as a NestJS
 * provider, nothing more. Heavier coverage belongs in WU4's
 * `pdf-generation.service.spec.ts` per the tasks spec.
 */
import { PdfGenerationService } from './pdf-generation.service';

describe('PdfGenerationService (WU1 skeleton)', () => {
  it('is constructible with no constructor arguments', () => {
    const service = new PdfGenerationService();

    expect(service).toBeInstanceOf(PdfGenerationService);
    expect(typeof service).toBe('object');
    expect(service).not.toBeNull();
  });

  it('exposes a service instance with no observable surface in WU1', () => {
    const service = new PdfGenerationService();

    // WU1 ships only the class shell. We assert that nothing accidentally
    // leaked in from a copy-paste of another service: the instance has no
    // own enumerable properties (no injected deps, no public methods).
    const ownProps = Object.keys(service);
    expect(ownProps).toEqual([]);
  });
});
