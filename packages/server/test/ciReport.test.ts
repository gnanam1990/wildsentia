import { describe, expect, it } from 'vitest';
import { assertRegressionEvidence } from '../../../tools/ci/report.js';

const report = () => ({ success: true, numPassedTests: 1, numTotalTests: 1, numFailedTests: 0,
  numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
  testResults: [{ name: '/repo/packages/server/test/simHost.test.ts', status: 'passed', assertionResults: [{ status: 'passed' }] }] });

describe('CI evidence gate', () => {
  it('accepts complete reconciled database evidence', () => { expect(assertRegressionEvidence(report())).toBe(1); });
  it.each(['numPendingTests', 'numTodoTests', 'numFailedTests', 'numPendingTestSuites', 'numFailedTestSuites'])(
    'rejects %s even if success is incorrectly true', (field) => {
      expect(() => assertRegressionEvidence({ ...report(), [field]: 1 })).toThrow();
    });
  it('rejects mismatched totals, empty reports and absent database coverage', () => {
    for (const value of [null, {}, { ...report(), numTotalTests: 2 }, { ...report(), testResults: [] }]) {
      expect(() => assertRegressionEvidence(value)).toThrow();
    }
    const r = report(); r.testResults[0]!.name = '/repo/packages/client/test/a.test.ts';
    expect(() => assertRegressionEvidence(r)).toThrow('PostgreSQL');
  });
  it('checks actual assertion status rather than only the summary', () => {
    const r = report(); r.testResults[0]!.assertionResults[0]!.status = 'pending';
    expect(() => assertRegressionEvidence(r)).toThrow();
  });
});
