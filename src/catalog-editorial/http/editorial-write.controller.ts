import {
  BadRequestException,
  ForbiddenException,
  Res,
  Controller,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  EDITORIAL_DISCARD_WRITER,
  type EditorialDiscardWriter,
} from '../application/editorial-discard-writer';
import {
  EDITORIAL_INITIALIZE_WRITER,
  type EditorialInitializeWriter,
} from '../application/editorial-initialize-writer';
import {
  EDITORIAL_PUBLISH_WRITER,
  type EditorialPublishWriter,
} from '../application/editorial-publish-writer';
import {
  EDITORIAL_UNPUBLISH_WRITER,
  type EditorialUnpublishWriter,
} from '../application/editorial-unpublish-writer';
import { createEditorialWriteRequestV2 } from '../application/editorial-write-request-v2';
import {
  EDITORIAL_SAVE_WRITER,
  type EditorialSaveWriter,
} from '../application/editorial-save-writer';
import { EditorialDocumentShapeError } from '../domain/editorial-document-shape-error';
import { PrismaEditorialAuthority } from '../infrastructure/prisma-editorial-authority';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { EditorialHttpFilter } from './editorial-http.filter';
import { idempotencyKey } from './idempotency-key';
import { EditorialHttpScope } from '../infrastructure/editorial-http-scope';

@Controller('products/:productId/editorial/draft')
@UseFilters(EditorialHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class EditorialWriteController {
  constructor(
    @Inject(EDITORIAL_PUBLISH_WRITER)
    private readonly publishWriter: EditorialPublishWriter,
    private readonly scope: EditorialHttpScope,
    @Inject(EDITORIAL_DISCARD_WRITER)
    private readonly discardWriter: EditorialDiscardWriter,
    private readonly authority: PrismaEditorialAuthority,
    @Inject(EDITORIAL_INITIALIZE_WRITER)
    private readonly initializeWriter: EditorialInitializeWriter,
    @Inject(EDITORIAL_SAVE_WRITER)
    private readonly saveWriter: EditorialSaveWriter,
  ) {}

  @Post('initialize')
  @Header('Cache-Control', 'no-store')
  async initialize(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = this.scope.principal(
      request.user as AuthenticatedUser | undefined,
    );
    const context = await this.scope.product(user, productId);
    const access = await this.authority.resolve(context);
    if (
      access?.activeMember !== true ||
      access.canRead !== true ||
      access.canCreate !== true ||
      access.actorId !== context.actorId ||
      access.tenantId !== context.tenantId ||
      access.productId !== context.productId
    )
      throw new ForbiddenException();
    if (Object.keys(request.query).length) throw new BadRequestException();
    const revisions: string[] = [];
    const keys: string[] = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (
        [
          'editorial-care-confirmation',
          'editorial-contract-version',
          'editorial-adoption',
        ].includes(name)
      )
        throw new BadRequestException();
      if (name === 'editorial-vocabulary-revision')
        revisions.push(request.rawHeaders[i + 1]);
      if (name === 'idempotency-key') keys.push(request.rawHeaders[i + 1]);
    }
    if (revisions.length !== 1 || keys.length !== 1 || keys[0].includes(','))
      throw new BadRequestException();
    const key = idempotencyKey(keys[0]);
    let intent: ReturnType<typeof createEditorialWriteRequestV2>;
    try {
      intent = createEditorialWriteRequestV2(
        'initialize',
        {
          vocabularyRevision: revisions[0],
          careConfirmation: null,
        },
        request.body,
      );
    } catch (error) {
      if (
        error instanceof TypeError &&
        error.message === 'Expected an editorial write request V2'
      )
        throw new BadRequestException();
      throw error;
    }
    const result = await this.initializeWriter.initialize(context, key, intent);
    response.status(result.status);
    for (const [name, value] of Object.entries(result.headers))
      response.setHeader(name, value);
    return result.body;
  }

  @Post('publish')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async publish(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = this.scope.principal(
      request.user as AuthenticatedUser | undefined,
    );
    const context = await this.scope.product(user, productId);
    const access = await this.authority.resolve(context);
    if (
      access?.activeMember !== true ||
      access.canRead !== true ||
      access.canPublish !== true ||
      access.actorId !== context.actorId ||
      access.tenantId !== context.tenantId ||
      access.productId !== context.productId
    )
      throw new ForbiddenException();
    if (Object.keys(request.query).length) throw new BadRequestException();
    const revisions: string[] = [];
    const keys: string[] = [];
    const confirmations: string[] = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (['editorial-contract-version', 'editorial-adoption'].includes(name))
        throw new BadRequestException();
      if (name === 'editorial-vocabulary-revision')
        revisions.push(request.rawHeaders[i + 1]);
      if (name === 'idempotency-key') keys.push(request.rawHeaders[i + 1]);
      if (name === 'editorial-care-confirmation')
        confirmations.push(request.rawHeaders[i + 1]);
    }
    if (
      revisions.length !== 1 ||
      keys.length !== 1 ||
      keys[0].includes(',') ||
      confirmations.length > 1
    )
      throw new BadRequestException();
    const key = idempotencyKey(keys[0]);
    let intent: ReturnType<typeof createEditorialWriteRequestV2>;
    try {
      // Exact token only; whether care needs it is decided after the locked CAS.
      intent = createEditorialWriteRequestV2(
        'publish',
        {
          vocabularyRevision: revisions[0],
          careConfirmation: confirmations[0] ?? null,
        },
        request.body,
      );
    } catch (error) {
      if (
        error instanceof TypeError &&
        error.message === 'Expected an editorial write request V2'
      )
        throw new BadRequestException();
      throw error;
    }
    const result = await this.publishWriter.publish(context, key, intent);
    response.status(result.status);
    for (const [name, value] of Object.entries(result.headers))
      response.setHeader(name, value);
    return result.body;
  }

  @Post('discard')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async discard(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = this.scope.principal(
      request.user as AuthenticatedUser | undefined,
    );
    const context = await this.scope.product(user, productId);
    const access = await this.authority.resolve(context);
    if (
      access?.activeMember !== true ||
      access.canRead !== true ||
      access.canDiscard !== true ||
      access.actorId !== context.actorId ||
      access.tenantId !== context.tenantId ||
      access.productId !== context.productId
    )
      throw new ForbiddenException();
    if (Object.keys(request.query).length) throw new BadRequestException();
    const revisions: string[] = [];
    const keys: string[] = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (
        [
          'editorial-care-confirmation',
          'editorial-contract-version',
          'editorial-adoption',
        ].includes(name)
      )
        throw new BadRequestException();
      if (name === 'editorial-vocabulary-revision')
        revisions.push(request.rawHeaders[i + 1]);
      if (name === 'idempotency-key') keys.push(request.rawHeaders[i + 1]);
    }
    if (revisions.length !== 1 || keys.length !== 1 || keys[0].includes(','))
      throw new BadRequestException();
    const key = idempotencyKey(keys[0]);
    let intent: ReturnType<typeof createEditorialWriteRequestV2>;
    try {
      intent = createEditorialWriteRequestV2(
        'discard',
        {
          vocabularyRevision: revisions[0],
          careConfirmation: null,
        },
        request.body,
      );
    } catch (error) {
      if (
        error instanceof TypeError &&
        error.message === 'Expected an editorial write request V2'
      )
        throw new BadRequestException();
      throw error;
    }
    const result = await this.discardWriter.discard(context, key, intent);
    response.status(result.status);
    for (const [name, value] of Object.entries(result.headers))
      response.setHeader(name, value);
    return result.body;
  }

  @Put()
  @Header('Cache-Control', 'no-store')
  async save(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = this.scope.principal(
      request.user as AuthenticatedUser | undefined,
    );
    const context = await this.scope.product(user, productId);
    const access = await this.authority.resolve(context);
    if (
      access?.activeMember !== true ||
      access.canRead !== true ||
      access.canSave !== true ||
      access.actorId !== context.actorId ||
      access.tenantId !== context.tenantId ||
      access.productId !== context.productId
    )
      throw new ForbiddenException();
    if (Object.keys(request.query).length) throw new BadRequestException();
    const revisions: string[] = [];
    const keys: string[] = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (
        [
          'editorial-care-confirmation',
          'editorial-contract-version',
          'editorial-adoption',
        ].includes(name)
      )
        throw new BadRequestException();
      if (name === 'editorial-vocabulary-revision')
        revisions.push(request.rawHeaders[i + 1]);
      if (name === 'idempotency-key') keys.push(request.rawHeaders[i + 1]);
    }
    if (revisions.length !== 1 || keys.length !== 1 || keys[0].includes(','))
      throw new BadRequestException();
    const key = idempotencyKey(keys[0]);
    let intent: ReturnType<typeof createEditorialWriteRequestV2>;
    try {
      intent = createEditorialWriteRequestV2(
        'save',
        { vocabularyRevision: revisions[0], careConfirmation: null },
        request.body,
      );
    } catch (error) {
      if (
        error instanceof EditorialDocumentShapeError ||
        (error instanceof TypeError &&
          error.message === 'Expected an editorial write request V2')
      )
        throw new BadRequestException();
      throw error;
    }
    const result = await this.saveWriter.save(context, key, intent);
    response.status(result.status);
    for (const [name, value] of Object.entries(result.headers))
      response.setHeader(name, value);
    return result.body;
  }
}

/** P4 S6: removes Published; same family as publish (read + publish). */
@Controller('products/:productId/editorial/published')
@UseFilters(EditorialHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class EditorialPublishedController {
  constructor(
    private readonly scope: EditorialHttpScope,
    private readonly authority: PrismaEditorialAuthority,
    @Inject(EDITORIAL_UNPUBLISH_WRITER)
    private readonly unpublishWriter: EditorialUnpublishWriter,
  ) {}

  @Post('unpublish')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async unpublish(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = this.scope.principal(
      request.user as AuthenticatedUser | undefined,
    );
    const context = await this.scope.product(user, productId);
    const access = await this.authority.resolve(context);
    if (
      access?.activeMember !== true ||
      access.canRead !== true ||
      access.canPublish !== true ||
      access.actorId !== context.actorId ||
      access.tenantId !== context.tenantId ||
      access.productId !== context.productId
    )
      throw new ForbiddenException();
    if (Object.keys(request.query).length) throw new BadRequestException();
    const revisions: string[] = [];
    const keys: string[] = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (
        [
          'editorial-care-confirmation',
          'editorial-contract-version',
          'editorial-adoption',
        ].includes(name)
      )
        throw new BadRequestException();
      if (name === 'editorial-vocabulary-revision')
        revisions.push(request.rawHeaders[i + 1]);
      if (name === 'idempotency-key') keys.push(request.rawHeaders[i + 1]);
    }
    if (revisions.length !== 1 || keys.length !== 1 || keys[0].includes(','))
      throw new BadRequestException();
    const key = idempotencyKey(keys[0]);
    let intent: ReturnType<typeof createEditorialWriteRequestV2>;
    try {
      // expectedRevision names the Published revision being removed.
      intent = createEditorialWriteRequestV2(
        'unpublish',
        { vocabularyRevision: revisions[0], careConfirmation: null },
        request.body,
      );
    } catch (error) {
      if (
        error instanceof TypeError &&
        error.message === 'Expected an editorial write request V2'
      )
        throw new BadRequestException();
      throw error;
    }
    const result = await this.unpublishWriter.unpublish(context, key, intent);
    response.status(result.status);
    for (const [name, value] of Object.entries(result.headers))
      response.setHeader(name, value);
    return result.body;
  }
}
