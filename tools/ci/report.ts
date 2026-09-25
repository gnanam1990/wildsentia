/** Fail closed: an empty, stale-shaped, skipped or partially failed report is not proof. */
export function assertRegressionEvidence(result: any): number {
  if (result?.success !== true || result.numFailedTests !== 0 || result.numPendingTests !== 0
    || result.numTodoTests !== 0 || !(result.numPassedTests > 0)
    || result.numFailedTestSuites !== 0 || result.numPendingTestSuites !== 0
    || !Array.isArray(result.testResults) || result.testResults.length === 0) {
    throw new Error('Regression gate requires positive passing tests and zero failed, skipped or todo tests/suites');
  }
  let passed = 0, databaseEvidence = false;
  for (const file of result.testResults) {
    if (typeof file.name !== 'string' || file.status !== 'passed' || !Array.isArray(file.assertionResults)
      || file.assertionResults.length === 0 || file.assertionResults.some((test: any) => test.status !== 'passed')) {
      throw new Error('Incomplete per-file regression evidence');
    }
    passed += file.assertionResults.length;
    if (file.name.replaceAll('\\', '/').endsWith('/packages/server/test/simHost.test.ts')) databaseEvidence = true;
  }
  if (passed !== result.numPassedTests || passed !== result.numTotalTests) throw new Error('Regression totals do not reconcile');
  if (!databaseEvidence) throw new Error('Required PostgreSQL SimHost integration evidence missing');
  return passed;
}
