/**
 * The id the note routes open a cell's note by. A share's messages carry an anonymised
 * conversation id, so a shared view uses the share's own id instead.
 */
export function noteConversationId(
  messageConversationId: string | null | undefined,
  share: { isSharedConvo?: boolean; shareId?: string },
): string | null | undefined {
  return share.isSharedConvo ? share.shareId : messageConversationId;
}
