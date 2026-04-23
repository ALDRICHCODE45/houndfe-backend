/**
 * FilesService - Application service for file operations.
 *
 * Orchestrates file upload, deletion, and retrieval.
 * Implements compensation logic (delete from storage if DB save fails).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { STORAGE_PORT, IStoragePort } from './domain/storage.port';
import { FILE_REPOSITORY, IFileRepository } from './domain/file.repository';
import { FileObject } from './domain/file-object.entity';
import {
  FileNotFoundError,
  FileTooLargeError,
  UnsupportedMediaTypeError,
} from './domain/errors';
import { FileUploadedEvent } from './domain/events/file-uploaded.event';

export interface UploadAndRegisterInput {
  buffer: Buffer;
  mimeType: string;
  originalName: string;
  ownerType?: string;
  ownerId?: string;
  uploadedBy?: string;
}

// Allowed MIME types for file uploads
const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly maxUploadSizeMB: number;
  private readonly maxUploadSizeBytes: number;

  constructor(
    @Inject(STORAGE_PORT) private readonly storagePort: IStoragePort,
    @Inject(FILE_REPOSITORY) private readonly fileRepository: IFileRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    this.maxUploadSizeMB = this.configService.get<number>(
      'SPACES_UPLOAD_MAX_MB',
      10,
    );
    this.maxUploadSizeBytes = this.maxUploadSizeMB * 1024 * 1024;
  }

  async uploadAndRegister(input: UploadAndRegisterInput): Promise<FileObject> {
    // Validate file size
    const fileSizeBytes = input.buffer.length;
    if (fileSizeBytes > this.maxUploadSizeBytes) {
      throw new FileTooLargeError(this.maxUploadSizeMB);
    }

    // Validate MIME type
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(input.mimeType)) {
      throw new UnsupportedMediaTypeError(input.mimeType);
    }

    // Generate unique storage key
    const ext = this.extractExtension(input.originalName);
    const uuid = randomUUID();
    const key =
      input.ownerType && input.ownerId
        ? `${input.ownerType}/${input.ownerId}/${uuid}${ext}`
        : `orphan/${uuid}${ext}`;

    // Upload to remote storage
    const uploadResult = await this.storagePort.upload({
      buffer: input.buffer,
      key,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.length,
    });

    // Create FileObject entity
    const fileObject = FileObject.create({
      id: randomUUID(),
      storageKey: uploadResult.key,
      url: uploadResult.url,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.length,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      uploadedBy: input.uploadedBy,
      createdAt: new Date(),
    });

    // Save to database with compensation
    try {
      const savedFile = await this.fileRepository.save(fileObject);

      // Emit domain event
      this.eventEmitter.emit(
        'file.uploaded',
        new FileUploadedEvent(
          savedFile.id,
          savedFile.storageKey,
          savedFile.url,
          savedFile.mimeType,
          savedFile.sizeBytes,
          savedFile.ownerType,
          savedFile.ownerId,
          savedFile.uploadedBy,
        ),
      );

      return savedFile;
    } catch (error) {
      // Compensation: delete from storage if DB save fails
      this.logger.error(
        `Failed to save FileObject to DB, attempting compensating delete from storage: ${uploadResult.key}`,
        error.stack,
      );
      await this.storagePort.delete(uploadResult.key);
      throw error;
    }
  }

  async findById(id: string): Promise<FileObject> {
    const file = await this.fileRepository.findById(id);
    if (!file) {
      throw new FileNotFoundError(id);
    }
    return file;
  }

  async findByIds(ids: string[]): Promise<FileObject[]> {
    return this.fileRepository.findByIds(ids);
  }

  async delete(id: string): Promise<void> {
    // Get file to obtain storage key
    const file = await this.findById(id);

    // Delete from database first
    await this.fileRepository.delete(id);

    // Delete from storage (logged if fails, eventual consistency)
    await this.storagePort.delete(file.storageKey);
  }

  private extractExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    return lastDot !== -1 ? filename.substring(lastDot) : '';
  }
}
