import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWorkbookFormulaResults, excelSumExpression } from './workbook-formulas.ts';

test('workbook export rejects formula errors before saving but accepts expected blanks and text', () => {
  for (const value of ['#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#N/A', '#NUM!', '#NULL!', '#SPILL!', '#CALC!', '#ERROR!', '#CIRC!', '#GETTING_DATA', null, undefined, NaN, Infinity]) {
    assert.throws(() => assertWorkbookFormulaResults([{ sheet: 'Plan', cell: 'B19', value }]), /Plan!B19 did not calculate/);
  }
  assert.doesNotThrow(() => assertWorkbookFormulaResults([0, -12.34, '', 'In study', 'Source mentioned #N/A'].map(value => ({ sheet: 'Plan', cell: 'B19', value }))));
});

test('small workbook sums keep direct references without subtotal rows', () => {
  const unexpectedSubtotal = () => { throw new Error('Small sums do not need helper cells.'); };
  assert.equal(excelSumExpression([], unexpectedSubtotal), '0');
  assert.equal(excelSumExpression(["'Transactions'!E6", "-'Transactions'!E7"], unexpectedSubtotal), "SUM('Transactions'!E6,-'Transactions'!E7)");
});

for (const count of [256, 10000, 50000]) {
  test(`${count} signed statement movements retain their total within Excel formula limits`, () => {
    const values = new Map<string, number>();
    const terms = Array.from({ length: count }, (_, index) => {
      const reference = `'Transactions'!E${index + 6}`;
      values.set(reference, index + 1);
      return index % 7 === 0 ? `-${reference}` : reference;
    });
    let subtotalCount = 0;
    const evaluate = (expression: string): number => {
      assert.ok(expression.startsWith('SUM(') && expression.endsWith(')'));
      assert.ok(expression.length + 1 <= 8192, 'Excel formulas cannot exceed 8192 characters.');
      const arguments_ = expression.slice(4, -1).split(',');
      assert.ok(arguments_.length <= 255, 'Excel functions cannot exceed 255 arguments.');
      return arguments_.reduce((total, reference) => {
        const negative = reference.startsWith('-');
        const value = values.get(negative ? reference.slice(1) : reference);
        assert.notEqual(value, undefined, `Missing referenced cell ${reference}`);
        return total + (negative ? -value! : value!);
      }, 0);
    };
    const expression = excelSumExpression(terms, subtotal => {
      const reference = `'Sources'!B${++subtotalCount + 20}`;
      values.set(reference, evaluate(subtotal));
      return reference;
    });
    const expected = Array.from({ length: count }, (_, index) => (index % 7 === 0 ? -1 : 1) * (index + 1)).reduce((total, value) => total + value, 0);
    assert.equal(evaluate(expression), expected);
    assert.ok(subtotalCount > 0);
  });
}

test('sum chunks also respect Excel formula length for longer references', () => {
  const formulas: string[] = [];
  excelSumExpression(Array.from({ length: 300 }, (_, index) => `'${'Source '.repeat(20)}'!A${index + 1}`), expression => {
    formulas.push(expression);
    return `B${formulas.length}`;
  });
  assert.ok(formulas.length > 1);
  assert.ok(formulas.every(expression => expression.length + 1 <= 8192));
});
