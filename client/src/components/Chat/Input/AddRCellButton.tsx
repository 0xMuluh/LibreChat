import { useCallback } from 'react';
import { TerminalSquare } from 'lucide-react';
import { IconButton } from '@librechat/client';
import type { UseFormReturn } from 'react-hook-form';
import type { TConversation } from 'librechat-data-provider';
import type { ChatFormValues } from '~/common';
import { noteCellsApi } from '~/data-provider/Notes/notesCellsApi';

const R_CELL = '```r\n# R NoteKernel cell\n\n```';

interface AddRCellButtonProps {
  methods: Pick<UseFormReturn<ChatFormValues>, 'getValues' | 'setValue'>;
  conversation: TConversation | null;
  disabled: boolean;
}

/** Inserts an executable R cell block into the composer. */
export default function AddRCellButton({ methods, conversation, disabled }: AddRCellButtonProps) {
  const conversationId = conversation?.conversationId;

  const insertCell = useCallback(() => {
    const currentText = (methods.getValues('text') || '').trim();
    const newText = currentText ? `${currentText}\n\n${R_CELL}` : R_CELL;
    methods.setValue('text', newText, { shouldValidate: true, shouldDirty: true });

    if (conversationId && conversationId !== 'new') {
      void noteCellsApi
        .createOrFindCell(conversationId, {
          content: '# R NoteKernel cell\n',
          blockKey: `composer-${Date.now()}`,
          messageId: null,
        })
        .catch(() => {
          /* non-blocking; the cell binds when it renders */
        });
    }

    const textarea = document.querySelector('textarea[name="text"]') as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.focus();
      const cellStart = newText.lastIndexOf('```r\n') + '```r\n'.length;
      const caret = newText.indexOf('\n', cellStart) + 1 || newText.length;
      textarea.setSelectionRange(caret, caret);
    }
  }, [methods, conversationId]);

  return (
    <IconButton
      label="Add R cell"
      size="md"
      shape="composer"
      variant="ghost"
      onClick={insertCell}
      disabled={disabled}
    >
      {/* IconButton owns its text colour; the inner span lets the icon start
          muted and brighten on hover without restyling the primitive. */}
      <span className="text-text-secondary hover:text-text-primary flex h-full w-full items-center justify-center transition-colors">
        <TerminalSquare className="size-4" aria-hidden="true" />
      </span>
    </IconButton>
  );
}
