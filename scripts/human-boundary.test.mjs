import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const api = () => import("../packages/core/dist/index.js");

function candidate(id, extra = {}) {
  return {
    id,
    obligation_id: id,
    category: "BUSINESS_DECISION",
    blocker_reason: "A business policy is not confirmed.",
    question: "Which policy applies this period?",
    minimum_answer: "Choose one policy.",
    options: ["A", "B"],
    evidence_paths: ["evidence/source.json"],
    resume_action: "Recompute the obligation after confirmation.",
    scope: "PERIOD",
    requires_human_judgment: true,
    ...extra,
  };
}

test("Human categories include SOURCE_CONFIRMATION and reject technical escalation", async () => {
  const { HUMAN_BOUNDARY_CATEGORIES, compileMinimalHumanRequired } =
    await api();
  assert.deepEqual(HUMAN_BOUNDARY_CATEGORIES, [
    "BUSINESS_DECISION",
    "CREDENTIAL_OR_SECRET",
    "EXTERNAL_AUTHORIZATION",
    "USER_ONLY_INPUT",
    "SOURCE_CONFIRMATION",
    "IRREVERSIBLE_EXTERNAL_ACTION",
  ]);
  assert.equal(
    compileMinimalHumanRequired([
      candidate("technical", { technical: true }),
      candidate("auto", { auto_resolvable: true }),
      candidate("real", { category: "SOURCE_CONFIRMATION" }),
    ]).length,
    1
  );
  assert.throws(
    () =>
      compileMinimalHumanRequired([
        candidate("bad", { category: "TEST_FAILURE" }),
      ]),
    /INVALID_HUMAN_CATEGORY/
  );
});

test("global WAITING_FOR_HUMAN gate is deterministic", async () => {
  const { evaluateHumanBoundary } = await api();
  assert.equal(
    evaluateHumanBoundary(["HUMAN_BLOCKED", "PASS"]).terminal,
    "WAITING_FOR_HUMAN"
  );
  assert.equal(
    evaluateHumanBoundary(["HUMAN_BLOCKED", "TECHNICAL_OPEN"]).terminal,
    "CONTINUE"
  );
  assert.equal(
    evaluateHumanBoundary(["HUMAN_BLOCKED", "RUNNABLE"]).terminal,
    "CONTINUE"
  );
  assert.equal(evaluateHumanBoundary(["PASS", "PASS"]).terminal, "DONE");
});

test("technical worker problem cannot become a human block", async () => {
  const { runAutonomousObligationLoop } = await api();
  let durable = {
    version: 1,
    run_id: "technical-human-test",
    phase: "WORKER",
    status: "running",
    round: 1,
    obligations: [
      { id: "a", status: "RUNNABLE", attempts: 0, failure_signatures: [] },
    ],
    human_backlog: [],
  };
  const result = await runAutonomousObligationLoop({
    projectRoot: "/tmp",
    runId: durable.run_id,
    loadState: async () => structuredClone(durable),
    saveState: async (next) => {
      durable = structuredClone(next);
    },
    handlers: {
      worker: async () => ({
        type: "HUMAN_BLOCK",
        category: "BUSINESS_DECISION",
        message: "TEST_FAILURE: command failed",
        technical: true,
      }),
    },
  });
  assert.equal(result.status, "TECHNICAL_OPEN");
  assert.equal(result.state.obligations[0].status, "TECHNICAL_OPEN");
  assert.equal(result.state.human_backlog.length, 0);
});

test("Chief technical reason marked as HUMAN_BLOCK is rejected into TECHNICAL_OPEN", async () => {
  const { runAutonomousObligationLoop } = await api();
  let durable = {
    version: 1,
    run_id: "chief-technical-human-test",
    phase: "CHIEF_RECOVERY",
    status: "running",
    round: 1,
    obligations: [
      {
        id: "a",
        status: "TECHNICAL_OPEN",
        attempts: 0,
        failure_signatures: ["test:failure"],
      },
    ],
    human_backlog: [],
  };
  const result = await runAutonomousObligationLoop({
    projectRoot: "/tmp",
    runId: durable.run_id,
    loadState: async () => structuredClone(durable),
    saveState: async (next) => {
      durable = structuredClone(next);
    },
    handlers: {
      chiefRecovery: async () => ({
        action: "HUMAN_BLOCK",
        summary: "cannot continue",
        human_question: "Can someone fix this?",
        human_required_reason: "TEST_FAILURE: command failed",
        category: "BUSINESS_DECISION",
      }),
    },
  });
  assert.equal(result.status, "TECHNICAL_OPEN");
  assert.equal(result.state.obligations[0].status, "TECHNICAL_OPEN");
  assert.equal(result.state.human_backlog.length, 0);
});

test("compiled questions and raw human answers are durable and bound", async () => {
  const {
    compileMinimalHumanRequired,
    persistHumanRequired,
    ingestHumanResponse,
    humanRequiredPath,
    humanResponsesPath,
  } = await api();
  const root = await mkdtemp(join(tmpdir(), "ralph-human-boundary-"));
  try {
    const item = compileMinimalHumanRequired(
      [candidate("af")],
      "2026-09-16T00:00:00.000Z"
    )[0];
    item.confirmed_facts = ["Current Run has no policy confirmation."];
    await persistHumanRequired(root, "run-1", [item]);
    assert.match(
      await readFile(humanRequiredPath(root, "run-1"), "utf8"),
      /"obligation_id": "af"/
    );
    await ingestHumanResponse(root, {
      version: 1,
      id: "response-1",
      run_id: "run-1",
      obligation_id: "af",
      human_required_item_id: "af",
      answer: "30 hours, no exception",
      answered_at: "2026-09-16T01:00:00.000Z",
      confirmation_type: "USER_CONFIRMED",
      scope: "PERIOD",
      effective_from: "2026-08-01",
      effective_to: "2026-08-31",
    });
    const responses = JSON.parse(
      await readFile(humanResponsesPath(root, "run-1"), "utf8")
    );
    assert.equal(responses.length, 1);
    const required = JSON.parse(
      await readFile(humanRequiredPath(root, "run-1"), "utf8")
    );
    assert.equal(required.items[0].status, "RESOLVED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy scope is explicit and prevents run-scoped inheritance", async () => {
  const { humanResponseAppliesTo, filterUnresolvedHumanCandidates } =
    await api();
  assert.equal(
    humanResponseAppliesTo(
      { run_id: "run-1", scope: "RUN" },
      { runId: "run-1" }
    ),
    true
  );
  assert.equal(
    humanResponseAppliesTo(
      { run_id: "run-1", scope: "RUN" },
      { runId: "run-2" }
    ),
    false
  );
  assert.equal(
    humanResponseAppliesTo(
      {
        run_id: "run-1",
        scope: "PERIOD",
        effective_from: "2026-08-01",
        effective_to: "2026-08-31",
      },
      { runId: "run-2", periodStart: "2026-08-03", periodEnd: "2026-08-30" }
    ),
    true
  );
  assert.equal(
    humanResponseAppliesTo(
      {
        run_id: "run-1",
        scope: "PERIOD",
        effective_from: "2026-08-01",
        effective_to: "2026-08-31",
      },
      { runId: "run-2", periodStart: "2026-09-01", periodEnd: "2026-09-30" }
    ),
    false
  );
  assert.equal(
    humanResponseAppliesTo(
      { run_id: "run-1", scope: "PERSISTENT", effective_from: "2026-01-01" },
      { runId: "run-2", periodStart: "2027-01-01", periodEnd: "2027-01-31" }
    ),
    true
  );
  const responses = [
    {
      run_id: "run-1",
      scope: "RUN",
      human_required_item_id: "already",
      version: 1,
      id: "r",
      obligation_id: "already",
      answer: "yes",
      answered_at: "2026-09-16T00:00:00Z",
      confirmation_type: "USER_CONFIRMED",
    },
  ];
  assert.deepEqual(
    filterUnresolvedHumanCandidates(
      [candidate("already"), candidate("new")],
      responses,
      { runId: "run-1" }
    ).map((item) => item.id),
    ["new"]
  );
});

test("anonymized Payroll six-obligation fixture compiles to minimal questions", async () => {
  const { compileMinimalHumanRequired } = await api();
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/payroll-human-boundary-20260916.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  const ids = fixture.obligations.map((item) => item.id);
  const items = compileMinimalHumanRequired(
    fixture.obligations.map((item) =>
      candidate(item.id, {
        category: item.category,
        scope: item.scope,
        confirmed_facts: [
          "Anonymized Fresh Run evidence identifies a real unresolved boundary.",
        ],
      })
    )
  );
  assert.deepEqual(
    items.map((item) => item.id),
    ids
  );
  assert.equal(
    items.some((item) => item.id === "AN"),
    false,
    "UAT-10 must not duplicate AN"
  );
  for (const item of items) {
    assert.ok(item.question);
    assert.ok(item.minimum_answer);
    assert.deepEqual(item.affected_obligations, [item.obligation_id]);
  }
});
