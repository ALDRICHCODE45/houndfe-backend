import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { Observable } from 'rxjs';

export const CACHE_CONTROL_KEY = 'cache-control-header';
export const CacheControl = (value: string) =>
  SetMetadata(CACHE_CONTROL_KEY, value);

@Injectable()
export class CacheControlInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const cacheControlValue = this.reflector.get<string | undefined>(
      CACHE_CONTROL_KEY,
      context.getHandler(),
    );

    if (cacheControlValue) {
      const response = context.switchToHttp().getResponse<Response>();
      response.setHeader('Cache-Control', cacheControlValue);
    }

    return next.handle();
  }
}
