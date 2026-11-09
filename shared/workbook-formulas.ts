export function assertWorkbookFormulaResults(cells: { sheet: string; cell: string; value: unknown }[]): void {
  for (const { sheet, cell, value } of cells) {
    if (value == null || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!|ERROR!|CIRC!|GETTING_DATA)$/.test(value))) {
      throw new Error(`Workbook formula ${sheet}!${cell} did not calculate: ${String(value)}`);
    }
  }
}

export function excelSumExpression(terms: string[], addSubtotal: (expression: string) => string): string {
  if (!terms.length) return '0';
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let length = 5;
  for (const term of terms) {
    if (term.length + 5 > 7000) throw new Error('A workbook sum term exceeds Excel formula limits.');
    if (chunk.length === 200 || length + term.length + 1 > 7000) {
      chunks.push(chunk);
      chunk = [];
      length = 5;
    }
    length += term.length + (chunk.length ? 1 : 0);
    chunk.push(term);
  }
  if (chunk.length) chunks.push(chunk);
  if (chunks.length === 1) return `SUM(${chunks[0].join(',')})`;
  return excelSumExpression(chunks.map(group => addSubtotal(`SUM(${group.join(',')})`)), addSubtotal);
}
