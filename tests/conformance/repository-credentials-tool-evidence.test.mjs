import assert from "node:assert/strict";
import test from "node:test";
import { completedToolResult } from "../helpers/normal-agent-tools.mjs";

const call = { id: "push", seq: 44, name: "exec" };
const failure = { toolCallId: "push", seq: 45, isError: true };
const success = {
  toolCallId: "push",
  seq: 47,
  isError: false,
  status: "completed",
  exitCode: 0,
};

test("installed tool evidence retains a later completion of the same call", () => {
  // Observed installed trace: an interim push error, followed by the actual
  // successful completion. Independent GitHub readback confirmed the commit.
  assert.equal(completedToolResult({ calls: [call], results: [failure, success] }, call), success);
});

test("missing, failed, stale and unrelated tool results do not prove completion", () => {
  for (const results of [
    [],
    [failure],
    [{ ...success, toolCallId: "other" }],
    [{ ...success, seq: 43 }],
    [{ ...success, exitCode: 1 }],
    [success, { ...failure, seq: 48 }],
    [{ ...success, status: "running" }],
  ]) {
    assert.equal(completedToolResult({ calls: [call], results }, call), undefined);
  }
});

test("running execution requires a later successful poll of its exact process session", () => {
  const running = { ...success, status: "running", exitCode: null, processSessionId: "session-a" };
  const poll = {
    id: "poll",
    seq: 48,
    name: "process",
    processAction: "poll",
    processSessionId: "session-a",
  };
  const completed = { ...success, seq: 49, toolCallId: "poll", processSessionId: "session-a" };
  const evidence = (p, result) => ({ calls: [call, p], results: [running, result] });
  assert.equal(completedToolResult(evidence(poll, completed), call), completed);
  for (const [p, result] of [
    [{ ...poll, processSessionId: "session-b" }, completed],
    [poll, { ...completed, processSessionId: "session-b" }],
    [{ ...poll, processAction: "kill" }, completed],
    [{ ...poll, seq: 46 }, completed],
    [poll, { ...completed, seq: 47 }],
    [poll, { ...completed, exitCode: 1 }],
    [poll, { ...completed, isError: true }],
  ]) {
    assert.equal(completedToolResult(evidence(p, result), call), undefined);
  }
  assert.equal(
    completedToolResult(
      {
        calls: [call, poll],
        results: [running, completed, { ...completed, seq: 50, isError: true }],
      },
      call,
    ),
    undefined,
  );
});
