import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';

export type TextValue = string | { value?: string | null } | null | undefined;

export interface RCellToolPayload {
  code: string;
  cellId?: string;
  title?: string;
}

export interface QuartoExportOptions {
  title?: string;
  includeOptions?: boolean;
  pruneSuperseded?: boolean;
  theme?: string;
  toc?: boolean;
}

export const getTextValue = (value: TextValue): string => {
  if (typeof value === 'string') {
    return value;
  }
  return value?.value ?? '';
};

/**
 * Build standard Quarto document YAML frontmatter.
 */
export function buildQuartoFrontmatter(
  title?: string,
  options?: { toc?: boolean; theme?: string; date?: string },
): string {
  const docTitle = (title || 'Analysis').replace(/"/g, '\\"');
  const dateStr = options?.date ?? new Date().toISOString().split('T')[0];
  const toc = options?.toc !== false;
  const theme = options?.theme || 'cosmo';

  return `---
title: "${docTitle}"
date: "${dateStr}"
format:
  html:
    toc: ${toc}
    code-fold: show
    code-tools: true
    theme: ${theme}
execute:
  warning: false
  message: false
---
`;
}

/**
 * Extract R code, cellId, and title from a tool_call content part.
 */
export function parseRCellToolCall(part: TMessageContentParts): RCellToolPayload | null {
  if (part.type !== ContentTypes.TOOL_CALL) {
    return null;
  }

  const toolCall = (part as { tool_call?: Record<string, unknown> }).tool_call;
  if (!toolCall) {
    return null;
  }

  // Determine tool / function name
  const name = String(
    toolCall.name ||
      (toolCall.function as { name?: string } | undefined)?.name ||
      toolCall.function_name ||
      '',
  );

  const isRCell = name === 'execute_r_cell' || name.includes('execute_r_cell');
  if (!isRCell) {
    return null;
  }

  // Parse arguments
  let args = toolCall.args || (toolCall.function as { arguments?: unknown } | undefined)?.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      // Streamed or unparsed args
      const codeMatch = /"code"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(args);
      if (codeMatch && codeMatch[1]) {
        try {
          args = { code: JSON.parse(`"${codeMatch[1]}"`) };
        } catch {
          args = { code: codeMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') };
        }
      } else if (!args.trim().startsWith('{')) {
        args = { code: args.trim() };
      }
    }
  }

  const argsObj = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  let code = String(argsObj.code || '').trim();
  let cellId = argsObj.cell_id ? String(argsObj.cell_id).trim() : undefined;
  const title = argsObj.title ? String(argsObj.title).trim() : undefined;

  // If cellId wasn't in arguments, inspect output for metadata tags
  const output = typeof toolCall.output === 'string' ? toolCall.output : '';
  if (!cellId && output) {
    const metaMatch = /<!--\s*noteCell\s+cellId=([^\s]+)/.exec(output);
    if (metaMatch && metaMatch[1]) {
      cellId = metaMatch[1].trim();
    } else {
      const tagMatch = /\[cell_id:\s*"([^"]+)"\]/.exec(output);
      if (tagMatch && tagMatch[1]) {
        cellId = tagMatch[1].trim();
      }
    }
  }

  if (!code) {
    return null;
  }

  return { code, cellId, title };
}

/**
 * Format an R code block into a Quarto chunk (```{r} ... ```).
 */
export function formatQuartoChunk(cell: RCellToolPayload, index: number): string {
  const label = cell.cellId ? cell.cellId.replace(/[^a-zA-Z0-9-]/g, '-') : `cell-${index + 1}`;
  const lines = ['```{r}', `#| label: ${label}`];

  if (cell.title) {
    lines.push(`#| fig-cap: "${cell.title.replace(/"/g, '\\"')}"`);
  }

  lines.push('#| echo: true', '', cell.code, '```');
  return lines.join('\n');
}

/**
 * Synthesize conversation messages and NoteCells into a single .qmd document.
 */
export function synthesizeThreadToQuarto({
  messages,
  title,
  includeOptions = true,
  pruneSuperseded = true,
  theme,
  toc,
}: {
  messages: (Partial<TMessage> | undefined | null)[];
  title?: string;
  includeOptions?: boolean;
  pruneSuperseded?: boolean;
  theme?: string;
  toc?: boolean;
}): string {
  const validMessages = messages.filter(
    (m): m is Partial<TMessage> => m != null && typeof m === 'object',
  );

  // 1. Identify superseded cells if pruneSuperseded is true
  const latestCellOccurrences = new Map<string, { msgIndex: number; partIndex: number }>();
  if (pruneSuperseded) {
    validMessages.forEach((msg, mIdx) => {
      if (!Array.isArray(msg.content)) return;
      msg.content.forEach((part, pIdx) => {
        if (!part) return;
        const cell = parseRCellToolCall(part as TMessageContentParts);
        if (cell && cell.cellId) {
          latestCellOccurrences.set(cell.cellId, { msgIndex: mIdx, partIndex: pIdx });
        }
      });
    });
  }

  const sections: string[] = [];

  // Frontmatter
  if (includeOptions) {
    sections.push(buildQuartoFrontmatter(title, { theme, toc }).trimEnd());
  }

  let chunkCounter = 0;

  // Process messages sequentially
  validMessages.forEach((msg, mIdx) => {
    const isUser = msg.isCreatedByUser || msg.sender === 'User';

    if (isUser) {
      const userText = (msg.text || '').trim();
      if (userText) {
        // Clean multi-line user queries into neat markdown sections
        const lines = userText.split('\n').map((l) => l.trim()).filter(Boolean);
        const header = lines[0].replace(/^[#\s*->]+/, '');
        if (lines.length === 1) {
          sections.push(`## ${header}`);
        } else {
          sections.push(`## ${header}\n\n${lines.slice(1).join('\n\n')}`);
        }
      }
      return;
    }

    // Assistant message processing
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      msg.content.forEach((part, pIdx) => {
        if (!part) return;

        // 1. Narrative text
        if (part.type === ContentTypes.TEXT || part.type === ContentTypes.TEXT_DELTA) {
          const textPart = part as { text?: TextValue; text_delta?: TextValue };
          const text = getTextValue(textPart.text_delta ?? textPart.text).trim();
          if (text) {
            // Strip out raw internal noteCell HTML comments if present
            const cleanText = text
              .replace(/<!--\s*noteCell[\s\S]*?-->/g, '')
              .replace(/\[cell_id:\s*"[^"]*"\]/g, '')
              .trim();
            if (cleanText) {
              sections.push(cleanText);
            }
          }
          return;
        }

        // 2. NoteCell R execution
        if (part.type === ContentTypes.TOOL_CALL) {
          const cell = parseRCellToolCall(part as TMessageContentParts);
          if (cell) {
            // Check if superseded
            if (pruneSuperseded && cell.cellId) {
              const latest = latestCellOccurrences.get(cell.cellId);
              if (latest && (latest.msgIndex !== mIdx || latest.partIndex !== pIdx)) {
                // Superseded by a later revision of this cellId
                return;
              }
            }

            sections.push(formatQuartoChunk(cell, chunkCounter++));
          }
          // Non-R tool calls (e.g. search_bioc_books) are skipped for clean document output
          return;
        }

        // Ignore THINK, ACTIVITY_LABEL, etc.
      });
    } else if (msg.text) {
      const text = msg.text
        .replace(/<!--\s*noteCell[\s\S]*?-->/g, '')
        .replace(/\[cell_id:\s*"[^"]*"\]/g, '')
        .trim();
      if (text) {
        sections.push(text);
      }
    }
  });

  return sections.join('\n\n') + '\n';
}
