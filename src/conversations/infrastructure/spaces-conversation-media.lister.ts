/**
 * `ListObjectsV2` over the Spaces bucket the media adapter writes to (S2 orphan
 * sweep). Read-only; the S3 client is the same `SPACES_*` configuration.
 */
import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type {
  ConversationMediaLister,
  ListedObject,
} from '../application/conversation-media-lister';

export class SpacesConversationMediaLister implements ConversationMediaLister {
  constructor(
    private readonly s3Client: S3Client,
    private readonly bucket: string,
  ) {}

  async list(input: {
    prefix: string;
    startAfter: string | null;
    limit: number;
  }): Promise<{ objects: ListedObject[]; truncated: boolean }> {
    const output = await this.s3Client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: input.prefix,
        MaxKeys: input.limit,
        ...(input.startAfter ? { StartAfter: input.startAfter } : {}),
      }),
    );
    const objects: ListedObject[] = [];
    for (const item of output.Contents ?? []) {
      if (!item.Key) continue;
      objects.push({ key: item.Key, lastModified: item.LastModified ?? null });
    }
    return { objects, truncated: output.IsTruncated === true };
  }
}
