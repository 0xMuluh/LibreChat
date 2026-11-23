import { cellRefsFilter, collectCellRefs } from './shareScope';

const cellA = '6560a1b2c3d4e5f6a7b8c9d0';
const cellB = '6560a1b2c3d4e5f6a7b8c9d1';
const cellC = '6560a1b2c3d4e5f6a7b8c9d2';

test('collects cell ids from tool output, arguments and text, and tool call keys', () => {
  const refs = collectCellRefs([
    { text: `see <!-- noteCell cellId=${cellC} executionId=e1 status=completed -->` },
    {
      content: [
        { type: 'text', text: { value: 'no cell here' } },
        {
          type: 'tool_call',
          tool_call: {
            id: 'call_1',
            args: '{"code":"x"}',
            output: `<!-- noteCell cellId=${cellA} executionId=e2 status=completed -->\n[cell_id: "${cellA}"]`,
          },
        },
        { type: 'tool_call', tool_call: { id: 'call_2', args: { cell_id: cellB, code: 'y' } } },
        { type: 'tool_call', tool_call: { id: 'call_3', output: '[cell_id: "not-an-id"]' } },
      ],
    },
  ]);

  expect(refs.cellIds.sort()).toEqual([cellA, cellB, cellC].sort());
  expect(refs.blockKeys).toEqual(['tool-call_1', 'tool-call_2', 'tool-call_3']);
});

test('a query for no references is null, so nothing is matched', () => {
  expect(cellRefsFilter(collectCellRefs([{ text: 'plain' }]))).toBeNull();
  expect(cellRefsFilter({ cellIds: [cellA], blockKeys: [] })).toEqual({
    $or: [{ _id: { $in: [cellA] } }],
  });
});
