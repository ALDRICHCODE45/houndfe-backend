/**
 * AuthController - HTTP Adapter (Driver Port).
 *
 * Translates HTTP requests to service calls.
 * Thin layer: validates input (via DTOs + ValidationPipe),
 * delegates to service, returns response.
 */
import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  AuthService,
  type AuthResponse,
  type LoginResponse,
  type AuthTokens,
  type UserPermissionsResponse,
} from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthenticatedUser } from './interfaces/jwt-payload.interface';
import { SelectTenantDto } from './dto/select-tenant.dto';
import { SwitchTenantDto } from './dto/switch-tenant.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto): Promise<AuthResponse> {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<LoginResponse> {
    return this.authService.login(dto);
  }

  @Post('select-tenant')
  @HttpCode(HttpStatus.OK)
  selectTenant(@Body() dto: SelectTenantDto): Promise<AuthResponse> {
    return this.authService.selectTenant(dto);
  }

  @Post('switch-tenant')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  switchTenant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SwitchTenantDto,
  ): Promise<AuthTokens> {
    return this.authService.switchTenant(user, dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthTokens> {
    return this.authService.refreshTokens(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getProfile(user.userId, user.tenantId);
  }

  @Get('me/permissions')
  @UseGuards(JwtAuthGuard)
  getUserPermissions(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserPermissionsResponse> {
    return this.authService.getUserPermissions(user);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@CurrentUser() user: AuthenticatedUser) {
    await this.authService.logout(user.userId);
    return { message: 'Logged out successfully' };
  }
}
