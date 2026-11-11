/**
 * Staff reads of the chatbot request inbox (contract §3.8, §3.10, §12.3,
 * §12.11; human-intervention unit 4). All routes need `read:ChatbotRequest`
 * (merge candidates also `update:ChatbotRequest`) behind the usual
 * `JWT → tenant → active user → CASL` guards, and answer `Cache-Control:
 * no-store`. Static paths come before `:id`, so `groups`, `counts` and
 * `history` are never read as ids.
 *
 *   GET /chatbot-requests/groups
 *   GET /chatbot-requests?customerKey=
 *   GET /chatbot-requests/counts
 *   GET /chatbot-requests/history
 *   GET /chatbot-requests/:id
 *   GET /chatbot-requests/:id/audit
 *   GET /chatbot-requests/:id/merge-candidates
 *
 * Phones leave only through `toStaffPhone` (R12): the ability comes from the
 * guard-built `req.ability`, never from the client.
 */
import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import {
  ChatbotRequestReadsService,
  type StaffReader,
} from '../application/chatbot-request-reads.service';
import {
  AuditQueryDto,
  CustomerListQueryDto,
  GroupsQueryDto,
  HistoryQueryDto,
  parseAssignee,
} from './chatbot-request-reads.dto';
import { ChatbotRequestHttpFilter } from './chatbot-request-http.filter';

type StaffRequest = Request & {
  user?: AuthenticatedUser;
  ability?: AppAbility;
};

const READ: [AppActions, AppSubjects] = ['read', 'ChatbotRequest'];
const UPDATE: [AppActions, AppSubjects] = ['update', 'ChatbotRequest'];

@Controller('chatbot-requests')
@UseGuards(JwtAuthGuard, TenantContextGuard, ActiveUserGuard, PermissionsGuard)
@UseFilters(ChatbotRequestHttpFilter)
export class ChatbotRequestReadsController {
  constructor(private readonly reads: ChatbotRequestReadsService) {}

  @Get('groups')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(READ)
  groups(@Query() query: GroupsQueryDto, @Req() req: StaffRequest) {
    return this.reads.groups(this.reader(req), {
      tab: query.status ?? 'open',
      filters: {
        subtype: query.subtype,
        assignee: parseAssignee(query.assignee),
        overdue: query.overdue,
        windowClosingSoon: query.windowClosingSoon,
      },
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get('counts')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(READ)
  counts(@Req() req: StaffRequest) {
    return this.reads.counts(this.reader(req));
  }

  @Get('history')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(READ)
  history(@Query() query: HistoryQueryDto, @Req() req: StaffRequest) {
    return this.reads.history(this.reader(req), query);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(READ)
  listByCustomer(
    @Query() query: CustomerListQueryDto,
    @Req() req: StaffRequest,
  ) {
    return this.reads.listByCustomer(this.reader(req), {
      customerKey: query.customerKey,
      tab: query.status ?? 'open',
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(READ)
  detail(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest) {
    return this.reads.detail(this.reader(req), id);
  }

  @Get(':id/audit')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(READ)
  audit(@Param('id', ParseUUIDPipe) id: string, @Query() query: AuditQueryDto) {
    return this.reads.audit(id, query);
  }

  @Get(':id/merge-candidates')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(READ, UPDATE)
  mergeCandidates(@Param('id', ParseUUIDPipe) id: string) {
    return this.reads.mergeCandidates(id);
  }

  /** Fail closed if a guard was bypassed: no ability, no read. */
  private reader(req: StaffRequest): StaffReader {
    if (!req.user || !req.ability) throw new ForbiddenException();
    return { userId: req.user.userId, ability: req.ability };
  }
}
