import { noteConversationId } from '../conversation';

describe('noteConversationId', () => {
  it("uses the message's conversation id outside a share", () => {
    expect(noteConversationId('c1', {})).toBe('c1');
  });

  it("uses the share's own id in a shared view, not the anonymised conversation id", () => {
    expect(noteConversationId('convo_abc', { isSharedConvo: true, shareId: 'TUJB6' })).toBe(
      'TUJB6',
    );
  });
});
