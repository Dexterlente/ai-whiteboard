import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClickUpTask } from "./clickup";
import type { QueueConfig, QueueItem } from "./queue";

// Mock the side-effecting deps so runQueue can be driven deterministically.
vi.mock("./agent", () => ({
  runAgentToCompletion: vi.fn(),
  runVerify: vi.fn(),
}));
vi.mock("./clickup", () => ({
  setStatus: vi.fn().mockResolvedValue(undefined),
  addComment: vi.fn().mockResolvedValue(undefined),
  fetchTaskDetail: vi.fn().mockResolvedValue(null),
  fetchComments: vi.fn().mockResolvedValue([]),
  fetchListStatuses: vi.fn().mockResolvedValue(["in progress", "done"]),
}));

import { runQueue } from "./queue";
import { runAgentToCompletion, runVerify } from "./agent";
import { setStatus, addComment } from "./clickup";

const task = (id: string): ClickUpTask => ({
  id,
  name: `Task ${id}`,
  status: "open",
  statusColor: null,
  statusType: null,
  statusOrderindex: null,
  dueDate: null,
  startDate: null,
  url: null,
  listId: "list1",
  listName: "List",
  priority: null,
  priorityColor: null,
  assignees: [],
  tags: [],
  markdownDescription: null,
  textDescription: null,
});

const config: QueueConfig = {
  cwd: "/repo",
  permissionMode: "acceptEdits",
  model: "",
  effort: "",
  verifyCommand: "npm test",
  inProgressStatus: "in progress",
  doneStatus: "done",
  basePrompt: "do it",
};

const okRun = { exitCode: 0, sessionId: null, transcript: [{ role: "assistant", text: "did the thing", tools: [] }] };

function driveWith(items: QueueItem[], cfg: QueueConfig = config) {
  const patches: Record<number, Partial<QueueItem>> = {};
  let halt: { index: number; error: string } | null = null;
  let doneCalled = false;
  const promise = runQueue(
    items,
    cfg,
    {
      onItem: (i, p) => {
        patches[i] = { ...patches[i], ...p };
      },
      onHalt: (i, error) => {
        halt = { index: i, error };
      },
      onDone: () => {
        doneCalled = true;
      },
    },
    { stopped: false, currentRunId: null },
  );
  return { promise, patches, getHalt: () => halt, wasDone: () => doneCalled };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runQueue", () => {
  it("succeeds through every item when the agent and verify pass", async () => {
    (runAgentToCompletion as ReturnType<typeof vi.fn>).mockResolvedValue(okRun);
    (runVerify as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, output: "ok" });

    const { promise, patches, wasDone } = driveWith([
      { task: task("a"), state: "pending" },
      { task: task("b"), state: "pending" },
    ]);
    await promise;

    expect(patches[0].state).toBe("succeeded");
    expect(patches[1].state).toBe("succeeded");
    expect(wasDone()).toBe(true);
    expect(runAgentToCompletion).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenCalledWith("a", "done"); // resolved + set the done status
    expect(addComment).toHaveBeenCalledWith("a", expect.stringContaining("✅ Verify"));
  });

  it("halts on a failed verification and leaves later items pending", async () => {
    (runAgentToCompletion as ReturnType<typeof vi.fn>).mockResolvedValue(okRun);
    (runVerify as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 1, output: "FAILED" });

    const { promise, patches, getHalt, wasDone } = driveWith([
      { task: task("a"), state: "pending" },
      { task: task("b"), state: "pending" },
    ]);
    await promise;

    expect(patches[0].state).toBe("failed");
    expect(getHalt()).toMatchObject({ index: 0 });
    expect(wasDone()).toBe(false); // returned early — never finished
    expect(runAgentToCompletion).toHaveBeenCalledTimes(1); // item b never started
    expect(addComment).toHaveBeenCalledWith("a", expect.stringContaining("verification failed"));
  });

  it("halts when the agent exits non-zero, before reaching verify", async () => {
    (runAgentToCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 2, sessionId: null, transcript: [] });

    const { promise, patches, getHalt } = driveWith([
      { task: task("a"), state: "pending" },
      { task: task("b"), state: "pending" },
    ]);
    await promise;

    expect(patches[0].state).toBe("failed");
    expect(getHalt()).toMatchObject({ index: 0 });
    expect(runVerify).not.toHaveBeenCalled();
    expect(runAgentToCompletion).toHaveBeenCalledTimes(1);
  });

  it("skips already-processed items (resume)", async () => {
    (runAgentToCompletion as ReturnType<typeof vi.fn>).mockResolvedValue(okRun);
    (runVerify as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, output: "ok" });

    const { promise, patches } = driveWith([
      { task: task("a"), state: "succeeded" },
      { task: task("b"), state: "pending" },
    ]);
    await promise;

    expect(patches[0]).toBeUndefined(); // 'a' was already done — untouched
    expect(patches[1].state).toBe("succeeded");
    expect(runAgentToCompletion).toHaveBeenCalledTimes(1);
  });

  it("succeeds without a verify gate when verifyCommand is blank", async () => {
    (runAgentToCompletion as ReturnType<typeof vi.fn>).mockResolvedValue(okRun);

    const { promise, patches } = driveWith([{ task: task("a"), state: "pending" }], {
      ...config,
      verifyCommand: "",
    });
    await promise;

    expect(patches[0].state).toBe("succeeded");
    expect(runVerify).not.toHaveBeenCalled();
    expect(addComment).toHaveBeenCalledWith("a", expect.not.stringContaining("✅ Verify"));
  });

  it("skips status writes when the status names are blank", async () => {
    (runAgentToCompletion as ReturnType<typeof vi.fn>).mockResolvedValue(okRun);
    (runVerify as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, output: "ok" });

    const { promise, patches } = driveWith([{ task: task("a"), state: "pending" }], {
      ...config,
      inProgressStatus: "",
      doneStatus: "",
    });
    await promise;

    expect(patches[0].state).toBe("succeeded");
    expect(setStatus).not.toHaveBeenCalled();
    expect(addComment).toHaveBeenCalled(); // comment still posted
  });
});
