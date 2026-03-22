/**
 * DatabaseModule - Global module that provides PrismaService.
 *
 * Marked as @Global() so any module can inject PrismaService
 * without explicitly importing this module.
 */
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
