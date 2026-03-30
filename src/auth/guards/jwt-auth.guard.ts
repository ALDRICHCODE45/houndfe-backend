/**
 * JWT Auth Guard - Protects routes requiring authentication.
 *
 * Simple wrapper around Passport's AuthGuard('jwt').
 * Apply with @UseGuards(JwtAuthGuard) on routes or controllers.
 */
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
