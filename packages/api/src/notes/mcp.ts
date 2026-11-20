/** Bind execution to the authenticated host conversation, never a model-selected thread. */
export function bindNoteThread<T extends object>(
  server: string,
  tool: string,
  args: T | undefined,
  conversationId?: string | null,
): T | (T & { thread_id: string }) | { thread_id: string } | undefined {
  return server === 'notethreads' && tool === 'execute_r_cell' && conversationId
    ? { ...args, thread_id: conversationId }
    : args;
}

/** The agent's R cells run through OmicsBase rather than the engine's own tool. */
export function isAgentCellTool(server: string, tool: string): boolean {
  return server === 'notethreads' && tool === 'execute_r_cell';
}
