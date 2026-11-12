import {
  toMessageView,
  type MediaRecord,
  type MessageRecord,
} from './message-view';

const row = (over: Partial<MessageRecord> = {}): MessageRecord => ({
  id: 'm-1',
  seq: 17,
  direction: 'IN',
  author: 'CUSTOMER',
  staffUserId: null,
  type: 'TEXT',
  text: 'Hola',
  mediaId: null,
  clientMessageId: null,
  providerTimestamp: new Date('2026-11-09T16:02:11.000Z'),
  receivedAt: new Date('2026-11-09T16:02:11.420Z'),
  deliveryStatus: null,
  ...over,
});
const media = (over: Partial<MediaRecord> = {}): MediaRecord => ({
  id: 'media-1',
  mimeType: 'image/jpeg',
  sizeBytes: 182344,
  purgedAt: null,
  ...over,
});

describe('toMessageView (§12.5)', () => {
  it('a customer text', () => {
    expect(toMessageView(row())).toEqual({
      id: 'm-1',
      seq: 17,
      direction: 'IN',
      author: 'CUSTOMER',
      staff: null,
      type: 'TEXT',
      text: 'Hola',
      media: null,
      deliveryStatus: null,
      clientMessageId: null,
      providerTimestamp: '2026-11-09T16:02:11.000Z',
      createdAt: '2026-11-09T16:02:11.420Z',
    });
  });

  it('a staff image with media, staff name and delivery status', () => {
    const view = toMessageView(
      row({
        direction: 'OUT',
        author: 'STAFF',
        staffUserId: 'u-1',
        type: 'IMAGE',
        mediaId: 'media-1',
        clientMessageId: 'c-1',
        deliveryStatus: 'DELIVERED',
      }),
      { media: media(), staff: { id: 'u-1', displayName: 'Ana' } },
    );
    expect(view).toMatchObject({
      author: 'STAFF',
      staff: { id: 'u-1', displayName: 'Ana' },
      media: {
        id: 'media-1',
        mimeType: 'image/jpeg',
        sizeBytes: 182344,
        durationSec: null,
        hasThumb: false,
        purged: false,
      },
      deliveryStatus: 'DELIVERED',
      clientMessageId: 'c-1',
    });
  });

  it('a purged file keeps the descriptor and says so', () => {
    const view = toMessageView(row({ type: 'AUDIO', mediaId: 'media-1' }), {
      media: media({ mimeType: 'audio/ogg', purgedAt: new Date() }),
    });
    expect(view.media).toMatchObject({ mimeType: 'audio/ogg', purged: true });
  });

  it('media whose row is gone is a purged descriptor-less file, never a crash', () => {
    const view = toMessageView(row({ type: 'IMAGE', mediaId: 'media-1' }));
    expect(view.media).toEqual({
      id: 'media-1',
      mimeType: null,
      sizeBytes: null,
      durationSec: null,
      hasThumb: false,
      purged: true,
    });
  });

  it('shows no staff block for a non-staff author, even if a name is supplied', () => {
    expect(
      toMessageView(row(), { staff: { id: 'u', displayName: 'Ana' } }).staff,
    ).toBeNull();
  });

  it('a staff message whose user is gone has a null name block', () => {
    expect(
      toMessageView(
        row({ author: 'STAFF', direction: 'OUT', staffUserId: 'u-9' }),
      ).staff,
    ).toEqual({ id: 'u-9', displayName: null });
  });

  it('has no conversationRef, phone or storage key anywhere in the view', () => {
    const json = JSON.stringify(
      toMessageView(row({ type: 'IMAGE', mediaId: 'media-1' }), {
        media: media(),
      }),
    );
    expect(json).not.toMatch(/wa:|storageKey|conversation-media|customerKey/);
  });
});
