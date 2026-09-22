import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import {
  buildQuartoFrontmatter,
  parseRCellToolCall,
  formatQuartoChunk,
  synthesizeThreadToQuarto,
} from '../formatQuarto';

describe('formatQuarto', () => {
  describe('buildQuartoFrontmatter', () => {
    it('generates valid YAML frontmatter with default settings', () => {
      const fm = buildQuartoFrontmatter('Microbiome Analysis', { date: '2026-09-22' });
      expect(fm).toContain('title: "Microbiome Analysis"');
      expect(fm).toContain('date: "2026-09-22"');
      expect(fm).toContain('format:\n  html:\n    toc: true');
      expect(fm).toContain('theme: cosmo');
      expect(fm).toContain('execute:\n  warning: false\n  message: false');
    });

    it('escapes quotes in the title', () => {
      const fm = buildQuartoFrontmatter('Title "with" quotes', { date: '2026-09-22' });
      expect(fm).toContain('title: "Title \\"with\\" quotes"');
    });
  });

  describe('parseRCellToolCall', () => {
    it('extracts code and cellId from JSON string arguments', () => {
      const part = {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          name: 'execute_r_cell',
          args: JSON.stringify({ code: 'library(mia)\ndata(GlobalPatterns)', cell_id: 'cell_01' }),
        },
      } as unknown as TMessageContentParts;

      const result = parseRCellToolCall(part);
      expect(result).not.toBeNull();
      expect(result?.code).toBe('library(mia)\ndata(GlobalPatterns)');
      expect(result?.cellId).toBe('cell_01');
    });

    it('extracts code and title from object arguments', () => {
      const part = {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          name: 'OmicsBaseNoteThreads_execute_r_cell',
          args: {
            code: 'plotAbundance(tse)',
            title: 'Taxonomic Abundance',
            cell_id: 'abundance_fig',
          },
        },
      } as unknown as TMessageContentParts;

      const result = parseRCellToolCall(part);
      expect(result).not.toBeNull();
      expect(result?.code).toBe('plotAbundance(tse)');
      expect(result?.title).toBe('Taxonomic Abundance');
      expect(result?.cellId).toBe('abundance_fig');
    });

    it('extracts cellId from output comment if absent in args', () => {
      const part = {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          name: 'execute_r_cell',
          args: { code: 'tse <- GlobalPatterns' },
          output: 'Done <!-- noteCell cellId=cell_auto1 executionId=exec_01 -->',
        },
      } as unknown as TMessageContentParts;

      const result = parseRCellToolCall(part);
      expect(result?.cellId).toBe('cell_auto1');
    });

    it('ignores non-R tool calls', () => {
      const part = {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          name: 'search_bioc_books',
          args: { query: 'plotAbundance' },
        },
      } as unknown as TMessageContentParts;

      expect(parseRCellToolCall(part)).toBeNull();
    });
  });

  describe('formatQuartoChunk', () => {
    it('formats a code block into a Quarto R chunk', () => {
      const chunk = formatQuartoChunk(
        { code: 'library(mia)\ntse', cellId: 'load_data', title: 'Data Summary' },
        0,
      );
      expect(chunk).toContain('```{r}');
      expect(chunk).toContain('#| label: load-data');
      expect(chunk).toContain('#| fig-cap: "Data Summary"');
      expect(chunk).toContain('#| echo: true');
      expect(chunk).toContain('library(mia)\ntse');
      expect(chunk).toContain('```');
    });
  });

  describe('synthesizeThreadToQuarto', () => {
    it('synthesizes a multi-step conversation into a clean .qmd document', () => {
      const messages: Partial<TMessage>[] = [
        {
          sender: 'User',
          isCreatedByUser: true,
          text: 'Inspect dataset',
        },
        {
          sender: 'Assistant',
          isCreatedByUser: false,
          content: [
            {
              type: ContentTypes.TEXT,
              text: 'We load the dataset first.',
            } as unknown as TMessageContentParts,
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: {
                name: 'execute_r_cell',
                args: { code: 'library(mia)\ndata(GlobalPatterns)', cell_id: 'step1' },
              },
            } as unknown as TMessageContentParts,
            {
              type: ContentTypes.TEXT,
              text: 'The dataset has 26 samples.',
            } as unknown as TMessageContentParts,
          ],
        },
      ];

      const qmd = synthesizeThreadToQuarto({
        messages,
        title: 'Microbiome Pipeline',
      });

      expect(qmd).toContain('title: "Microbiome Pipeline"');
      expect(qmd).toContain('## Inspect dataset');
      expect(qmd).toContain('We load the dataset first.');
      expect(qmd).toContain('```{r}');
      expect(qmd).toContain('#| label: step1');
      expect(qmd).toContain('library(mia)\ndata(GlobalPatterns)');
      expect(qmd).toContain('The dataset has 26 samples.');
    });

    it('prunes superseded cell attempts when pruneSuperseded is true', () => {
      const messages: Partial<TMessage>[] = [
        {
          sender: 'Assistant',
          content: [
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: {
                name: 'execute_r_cell',
                args: { code: 'broken_code()', cell_id: 'cell_target' },
              },
            } as unknown as TMessageContentParts,
          ],
        },
        {
          sender: 'Assistant',
          content: [
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: {
                name: 'execute_r_cell',
                args: { code: 'working_code()', cell_id: 'cell_target' },
              },
            } as unknown as TMessageContentParts,
          ],
        },
      ];

      const qmd = synthesizeThreadToQuarto({
        messages,
        title: 'Test',
        includeOptions: false,
        pruneSuperseded: true,
      });

      expect(qmd).not.toContain('broken_code()');
      expect(qmd).toContain('working_code()');
    });
  });
});
