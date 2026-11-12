import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { parseSessionAck } from './live-conversation.controller';

describe('parseSessionAck (bot contract: session-ack)', () => {
  it('accepts exactly {epoch, state} and the optional wamid', () => {
    expect(parseSessionAck({ epoch: 3, state: 'STARTED' })).toEqual({
      epoch: 3,
      state: 'STARTED',
    });
    expect(
      parseSessionAck({
        epoch: 1,
        state: 'ENDED',
        providerMessageId: 'wamid.1',
      }),
    ).toEqual({ epoch: 1, state: 'ENDED' });
  });

  it.each([
    [undefined],
    [null],
    [[]],
    [{}],
    [{ epoch: 0, state: 'STARTED' }],
    [{ epoch: 1.5, state: 'STARTED' }],
    [{ epoch: '3', state: 'STARTED' }],
    [{ epoch: 3, state: 'ACTIVE' }],
    [{ epoch: 3 }],
    [{ epoch: 3, state: 'STARTED', tenantId: 't' }],
    [{ epoch: 3, state: 'STARTED', providerMessageId: '' }],
    [{ epoch: 3, state: 'STARTED', providerMessageId: ' x ' }],
    [{ epoch: 3, state: 'STARTED', providerMessageId: 'x'.repeat(513) }],
  ])('rejects %j', (body) => {
    expect(() => parseSessionAck(body)).toThrow(InvalidArgumentError);
  });
});
