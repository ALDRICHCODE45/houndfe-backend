import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { SpacesReceiptStorageAdapter } from './spaces-receipt-storage.adapter';

describe('SpacesReceiptStorageAdapter', () => {
  const send = jest.fn<Promise<unknown>, [unknown]>();
  const adapter = new SpacesReceiptStorageAdapter(
    { send } as unknown as S3Client,
    'bucket-1',
  );

  beforeEach(() => send.mockReset());

  it('uploads with a private ACL, never public-read', async () => {
    send.mockResolvedValue({});
    const bytes = Buffer.from('%PDF-1.4');

    await adapter.putPrivate({
      key: 'receipts/t/s/k.pdf',
      bytes,
      mimeType: 'application/pdf',
    });

    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'bucket-1',
      Key: 'receipts/t/s/k.pdf',
      Body: bytes,
      ContentType: 'application/pdf',
      ContentLength: bytes.length,
      ACL: 'private',
    });
  });

  it('propagates upload failures', async () => {
    send.mockRejectedValue(new Error('network'));
    await expect(
      adapter.putPrivate({
        key: 'k',
        bytes: Buffer.from('x'),
        mimeType: 'image/png',
      }),
    ).rejects.toThrow('network');
  });

  it('deletes best effort without throwing', async () => {
    send.mockRejectedValue(new Error('gone'));
    await expect(adapter.delete('k')).resolves.toBeUndefined();
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it('reads a private object as a stream', async () => {
    const body = Readable.from([Buffer.from('bytes')]);
    send.mockResolvedValue({ Body: body, ContentLength: 5 });

    const object = await adapter.getPrivate('receipts/t/s/k.png');

    const command = send.mock.calls[0][0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'bucket-1',
      Key: 'receipts/t/s/k.png',
    });
    expect(object).toEqual({ body, contentLength: 5 });
  });

  it('answers null when the object does not exist', async () => {
    send.mockRejectedValue(
      new NoSuchKey({ message: 'missing', $metadata: {} }),
    );
    await expect(adapter.getPrivate('k')).resolves.toBeNull();
  });

  it('propagates other read failures', async () => {
    send.mockRejectedValue(new Error('network'));
    await expect(adapter.getPrivate('k')).rejects.toThrow('network');
  });

  it('removes strictly: a delete failure is thrown', async () => {
    send.mockRejectedValue(new Error('denied'));
    await expect(adapter.remove('k')).rejects.toThrow('denied');
    const command = send.mock.calls[0][0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({ Bucket: 'bucket-1', Key: 'k' });
  });
});
