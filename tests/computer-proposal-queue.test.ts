import assert from "node:assert/strict";
import test from "node:test";
import type { ComputerActionProposal, ComputerActionResult } from "../src/common/types";
import { ComputerProposalQueue } from "../src/renderer/computer-proposal-queue";

test("多步骤审批只在当前步骤成功后依次推进", () => {
  const queue = new ComputerProposalQueue();
  const first = queue.acceptResponse([proposal("a", 1, 3), proposal("b", 2, 3), proposal("c", 3, 3)]);
  assert.equal(first.kind, "replaced");
  assert.equal(first.active?.id, "a");
  assert.ok(first.ticket);
  assert.equal(queue.beginExecution(first.ticket), true);
  assert.equal(queue.beginExecution(first.ticket), false);

  const second = queue.settle(first.ticket, "completed");
  assert.equal(second.kind, "next");
  assert.equal(second.active?.id, "b");
  assert.deepEqual(second.cancel, []);
  assert.ok(second.ticket);
  assert.equal(queue.beginExecution(second.ticket), true);

  const third = queue.settle(second.ticket, "completed");
  assert.equal(third.kind, "next");
  assert.equal(third.active?.id, "c");
  assert.ok(third.ticket);
  assert.equal(queue.beginExecution(third.ticket), true);
  const done = queue.settle(third.ticket, "completed");
  assert.equal(done.kind, "finished");
  assert.equal(queue.hasPending(), false);
});

test("拒绝、取消和失败都会停止并返回全部后续待取消步骤", () => {
  const terminalStatuses: ComputerActionResult["status"][] = ["denied", "cancelled", "failed"];
  for (const status of terminalStatuses) {
    const queue = new ComputerProposalQueue();
    const current = queue.acceptResponse([proposal(`${status}-1`), proposal(`${status}-2`), proposal(`${status}-3`)]);
    assert.ok(current.ticket);
    assert.equal(queue.beginExecution(current.ticket), true);
    const stopped = queue.settle(current.ticket, status);
    assert.equal(stopped.kind, "stopped");
    assert.deepEqual(stopped.cancel.map((item) => item.id), [`${status}-2`, `${status}-3`]);
    assert.equal(queue.hasPending(), false);
  }
});

test("执行异常或过期会清空当前队列并请求清理所有未决预览", () => {
  const queue = new ComputerProposalQueue();
  const current = queue.acceptResponse([proposal("expired-1"), proposal("expired-2")]);
  assert.ok(current.ticket);
  assert.equal(queue.beginExecution(current.ticket), true);
  const stopped = queue.fail(current.ticket);
  assert.equal(stopped.kind, "stopped");
  assert.deepEqual(stopped.cancel.map((item) => item.id), ["expired-1", "expired-2"]);
  assert.equal(queue.hasPending(), false);
});

test("pending 时普通聊天回复不会丢失或重建当前审批", () => {
  const queue = new ComputerProposalQueue();
  const current = queue.acceptResponse([proposal("keep-1"), proposal("keep-2")]);
  assert.ok(current.ticket);
  const preserved = queue.acceptResponse([]);
  assert.equal(preserved.kind, "preserved");
  assert.deepEqual(preserved.ticket, current.ticket);
  assert.equal(preserved.active?.id, "keep-1");
  assert.deepEqual(preserved.cancel, []);

  assert.equal(queue.beginExecution(current.ticket), true);
  const preservedWhileExecuting = queue.acceptResponse([]);
  assert.equal(preservedWhileExecuting.kind, "preserved");
  assert.equal(queue.settle(current.ticket, "completed").active?.id, "keep-2");
});

test("新响应覆盖旧队列后，旧异步结果不会推进或清空新计划", () => {
  const queue = new ComputerProposalQueue();
  const old = queue.acceptResponse([proposal("old-1"), proposal("old-2")]);
  assert.ok(old.ticket);
  assert.equal(queue.beginExecution(old.ticket), true);

  const replacement = queue.acceptResponse([proposal("new-1"), proposal("new-2")]);
  assert.equal(replacement.kind, "replaced");
  assert.equal(replacement.active?.id, "new-1");
  assert.deepEqual(replacement.cancel.map((item) => item.id), ["old-2"]);
  assert.equal(queue.settle(old.ticket, "completed").kind, "stale");

  const preserved = queue.acceptResponse([]);
  assert.equal(preserved.active?.id, "new-1");
  assert.ok(replacement.ticket);
  assert.equal(queue.beginExecution(replacement.ticket), true);
  const next = queue.settle(replacement.ticket, "completed");
  assert.equal(next.kind, "next");
  assert.equal(next.active?.id, "new-2");
});

test("尚未执行的旧计划被替换时会清理旧队列全部步骤", () => {
  const queue = new ComputerProposalQueue();
  queue.acceptResponse([proposal("old-a"), proposal("old-b")]);
  const replacement = queue.acceptResponse([proposal("new-a")]);
  assert.deepEqual(replacement.cancel.map((item) => item.id), ["old-a", "old-b"]);
  assert.equal(replacement.active?.id, "new-a");
});

function proposal(id: string, step = 1, total = 2): ComputerActionProposal {
  return {
    id,
    tool: "copy-text",
    title: `操作 ${id}`,
    description: "写入剪贴板",
    preview: id,
    severity: "info",
    requiresApproval: true,
    allowedDecisions: ["allow-once", "deny"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    plan: { id: "plan", title: "测试计划", step, total },
  };
}
