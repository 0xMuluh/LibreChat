/** The cells a set of messages points at: by cell id, or by the tool call that ran them. */
export interface NoteCellRefs {
  cellIds: string[];
  blockKeys: string[];
}

interface MessageLike {
  text?: string | null;
  content?: unknown;
}

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const CELL_MARKER = /<!--\s*noteCell\s+cellId=([^\s]+)/g;
const CELL_LABEL = /\[cell_id:\s*"([^"\\]+)"\]/g;
const CELL_ARG = /"cell_id"\s*:\s*"([^"\\]+)"/g;

function addMatches(text: unknown, pattern: RegExp, into: Set<string>) {
  if (typeof text !== 'string' || !text) {
    return;
  }
  for (const match of text.matchAll(pattern)) {
    into.add(match[1].trim());
  }
}

function partText(part: Record<string, unknown>): unknown {
  const text = part.text;
  if (text && typeof text === 'object') {
    return (text as { value?: unknown }).value;
  }
  return text;
}

/**
 * Collects the note cells that messages reference: the cell ids in tool output markers
 * and `cell_id` arguments, and `tool-<toolCallId>`, the key the page shows a cell under.
 */
export function collectCellRefs(messages: readonly MessageLike[] | null | undefined): NoteCellRefs {
  const cellIds = new Set<string>();
  const blockKeys = new Set<string>();
  for (const message of messages ?? []) {
    addMatches(message?.text, CELL_MARKER, cellIds);
    if (!Array.isArray(message?.content)) {
      continue;
    }
    for (const part of message.content as Array<Record<string, unknown> | null>) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      addMatches(partText(part), CELL_MARKER, cellIds);
      const toolCall = part.tool_call as
        | { id?: unknown; args?: unknown; output?: unknown }
        | undefined;
      if (!toolCall || typeof toolCall !== 'object') {
        continue;
      }
      if (typeof toolCall.id === 'string' && toolCall.id) {
        blockKeys.add(`tool-${toolCall.id}`);
      }
      addMatches(toolCall.output, CELL_MARKER, cellIds);
      addMatches(toolCall.output, CELL_LABEL, cellIds);
      const args =
        typeof toolCall.args === 'string' ? toolCall.args : JSON.stringify(toolCall.args ?? {});
      addMatches(args, CELL_ARG, cellIds);
    }
  }
  return {
    cellIds: [...cellIds].filter((id) => OBJECT_ID.test(id)),
    blockKeys: [...blockKeys],
  };
}

/** A NoteCell query for the referenced cells; null when nothing is referenced. */
export function cellRefsFilter(refs: NoteCellRefs): Record<string, unknown> | null {
  const or: Record<string, unknown>[] = [];
  if (refs.cellIds.length > 0) {
    or.push({ _id: { $in: refs.cellIds } });
  }
  if (refs.blockKeys.length > 0) {
    or.push({ blockKey: { $in: refs.blockKeys } });
  }
  return or.length > 0 ? { $or: or } : null;
}
