import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareBenchmarkMetrics,
  compareRegression,
  scoreDetailedResults,
  scoreResults,
  summarizeBenchmarkMetrics,
} from '../../src/evaluation/index.js';

test('summarizeBenchmarkMetrics extracts all 11 metrics across legacy 2.2.2 baseline and rich 2.2.3 candidate shapes', () => {
  // 2.2.2 legacy baseline: 8/10 implementation & tests ok (failed manifest), 2 STEP_BUDGET_EXHAUSTED
  const baseline = {
    results: [
      ...Array.from({ length: 8 }, (_, idx) => ({
        taskId: idx === 0 ? 'real-api-compat-01' : `real-task-0${idx + 1}`,
        status: 'failed',
        passed: false,
        attempts: 1,
        durationMs: 30_000,
        judge: {
          passed: false,
          deterministic: true,
          reason: 'engineering_acceptance_incomplete',
          evidence: {
            actualTestExitCode: 0,
            checks: {
              changedFiles: true,
              reportedChangedFiles: false,
              tests: false,
              testCommand: false,
              independentVerdict: false,
              implementation: true,
            },
          },
        },
      })),
      {
        taskId: 'real-security-audit-01',
        status: 'failed',
        passed: false,
        attempts: 1,
        durationMs: 80_000,
        judge: null,
        error: 'STEP_BUDGET_EXHAUSTED: 达到最大步数上限仍未完成最终交付',
      },
      {
        taskId: 'real-recovery-01',
        status: 'failed',
        passed: false,
        attempts: 1,
        durationMs: 60_000,
        judge: null,
        error: 'STEP_BUDGET_EXHAUSTED: reached maxSteps',
      },
    ],
  };

  const baseSum = summarizeBenchmarkMetrics(baseline);
  assert.equal(baseSum.fullPassRate, 0);
  assert.equal(baseSum.implementationPassRate, 0.8);
  assert.equal(baseSum.testPassRate, 0.8);
  assert.equal(baseSum.evidenceComplianceRate, 0);
  assert.equal(baseSum.stepBudgetExhaustedCount, 2);
  assert.equal(baseSum.stepBudgetExhaustedRate, 0.2);
  assert.equal(baseSum.recoverySuccessRate, 0);
  assert.equal(baseSum.retryRate, 0);
  assert.equal(baseSum.failureTaxonomy.step_budget_exhausted, 2);
  assert.equal(baseSum.failureTaxonomy.independent_verdict_failed, 8);

  const candidate = {
    results: [
      ...Array.from({ length: 8 }, (_, idx) => ({
        taskId: idx === 0 ? 'real-api-compat-01' : `real-task-0${idx + 1}`,
        status: 'passed',
        passed: true,
        attempts: idx === 1 ? 2 : 1,
        durationMs: 20_000,
        telemetry: {
          stepUsage: { steps: 9 },
          tokenUsage: { inputTokens: 1500, outputTokens: 500 },
          retries: idx === 1 ? 1 : 0,
          reviewerVerdict: { status: 'pass' },
        },
        judge: {
          passed: true,
          deterministic: true,
          evidence: {
            implementationPassed: true,
            testsPassed: true,
            evidenceCompliant: true,
            failureCategory: 'none',
          },
        },
      })),
      {
        taskId: 'real-security-audit-01',
        status: 'passed',
        passed: true,
        attempts: 1,
        durationMs: 25_000,
        telemetry: {
          stepUsage: { steps: 18 },
          tokenUsage: { inputTokens: 3000, outputTokens: 1000 },
          retries: 0,
          reviewerVerdict: { status: 'pass' },
        },
        judge: {
          passed: true,
          deterministic: true,
          evidence: {
            implementationPassed: true,
            testsPassed: true,
            evidenceCompliant: true,
            failureCategory: 'none',
          },
        },
      },
      {
        taskId: 'real-recovery-01',
        status: 'passed',
        passed: true,
        attempts: 2,
        durationMs: 25_000,
        telemetry: {
          stepUsage: { steps: 15 },
          tokenUsage: { inputTokens: 2500, outputTokens: 900 },
          retries: 1,
        },
        judge: {
          passed: true,
          deterministic: true,
          evidence: {
            implementationPassed: true,
            testsPassed: true,
            evidenceCompliant: true,
            failureCategory: 'none',
          },
        },
      },
    ],
  };

  const diff = compareBenchmarkMetrics(baseline, candidate);
  assert.equal(diff.candidate.fullPassRate, 1);
  assert.equal(diff.candidate.reviewerValidityRate, 1);
  assert.equal(diff.candidate.stepBudgetExhaustedCount, 0);
  assert.equal(diff.candidate.averageSteps, 10.5);
  assert.equal(diff.candidate.averageTokens, 2340);
  assert.equal(diff.candidate.recoverySuccessRate, 1);
  assert.equal(diff.candidate.retryRate, 0.2);
  assert.equal(diff.deltas.fullPassRateDelta, 1);
  assert.equal(diff.deltas.stepBudgetExhaustedDelta, -2);
  assert.equal(diff.improvedTasks.length, 10);
  assert.equal(diff.regressedTasks.length, 0);

  const scored = scoreResults(candidate.results);
  const detailed = scoreDetailedResults(candidate.results);
  assert.equal(scored.passRate, 1);
  assert.equal(detailed.evidenceComplianceRate, 1);
  assert.equal(compareRegression({ score: scoreResults(baseline.results) }, { score: scored }).passed, true);
});
