/**
 * FileObject - Domain entity representing a file stored in remote object storage.
 *
 * This is the aggregate root for the files bounded context.
 */

export interface FileObjectProps {
  id: string;
  storageKey: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  ownerType?: string;
  ownerId?: string;
  uploadedBy?: string;
  createdAt: Date;
}

export class FileObject {
  readonly id: string;
  readonly storageKey: string;
  readonly url: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly ownerType?: string;
  readonly ownerId?: string;
  readonly uploadedBy?: string;
  readonly createdAt: Date;

  private constructor(props: FileObjectProps) {
    this.id = props.id;
    this.storageKey = props.storageKey;
    this.url = props.url;
    this.mimeType = props.mimeType;
    this.sizeBytes = props.sizeBytes;
    this.ownerType = props.ownerType;
    this.ownerId = props.ownerId;
    this.uploadedBy = props.uploadedBy;
    this.createdAt = props.createdAt;
  }

  static create(props: FileObjectProps): FileObject {
    return new FileObject(props);
  }
}
