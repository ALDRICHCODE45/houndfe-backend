/**
 * FileUploadedEvent - Domain event emitted when a file is uploaded.
 *
 * Plain class (no NestJS decorators) dispatched via EventEmitter.
 */

export class FileUploadedEvent {
  constructor(
    public readonly fileId: string,
    public readonly storageKey: string,
    public readonly url: string,
    public readonly mimeType: string,
    public readonly sizeBytes: number,
    public readonly ownerType?: string,
    public readonly ownerId?: string,
    public readonly uploadedBy?: string,
  ) {}
}
