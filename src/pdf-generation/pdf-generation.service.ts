/**
 * PdfGenerationService — WU1 skeleton.
 *
 * In WU4 this becomes the render orchestrator:
 *   - `render(sale, tenant, format)` validates sale.status, looks up the
 *     template in `TEMPLATE_REGISTRY`, calls `renderToStream`, pipes to
 *     the HTTP response.
 *   - `OnModuleInit` registers Roboto Regular via `Font.register()` and
 *     Spanish hyphenation callback (fiscal receipt convention).
 *   - Maps renderer errors to NestJS exception classes (BadRequest /
 *     NotFound / InternalServerError) per the design's threat matrix.
 *
 * For WU1 we ship the empty class so the module's provider graph
 * compiles. No constructor parameters yet — when WU4 lands we'll add
 * `SalesService` + `TenantsService` + `Reflector` here.
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class PdfGenerationService {}
