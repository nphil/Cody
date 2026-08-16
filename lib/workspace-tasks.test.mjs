import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { TASKS_CONFIG_RELATIVE_PATH, TASKS_CONFIG_VERSION, TASK_ID_PATTERN, groupTasks, parseTasksConfig } =
  await jiti.import("./workspace-tasks.ts");

/** Serialize a config object the way the file on disk would hold it. */
function config(value) {
  return JSON.stringify(value);
}

function expectError(raw, error) {
  const result = parseTasksConfig(raw);
  assert.equal(result.ok, false, `expected failure for ${raw}`);
  assert.equal(result.error, error);
}

test("the config path stays under .cody and the version gate is the number 1", () => {
  assert.equal(TASKS_CONFIG_RELATIVE_PATH, ".cody/tasks.json");
  assert.equal(TASKS_CONFIG_VERSION, 1);
  assert.equal(TASK_ID_PATTERN.source, "^[a-z][a-z0-9.-]*$");
});

test("a full valid config parses with every field carried through", () => {
  const result = parseTasksConfig(config({
    version: 1,
    tasks: [
      { id: "build", title: "Build", command: "npm run build", description: "Compile", group: "Dev", confirm: true },
      { id: "test.unit-2", title: "Unit tests", command: "npm test" },
    ],
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.tasks, [
    { id: "build", title: "Build", command: "npm run build", description: "Compile", group: "Dev", confirm: true },
    { id: "test.unit-2", title: "Unit tests", command: "npm test", confirm: false },
  ]);
});

test("an empty task list is valid", () => {
  const result = parseTasksConfig(config({ version: 1, tasks: [] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.tasks, []);
});

test("unknown top-level and task-level keys are ignored, not rejected", () => {
  const result = parseTasksConfig(config({
    version: 1,
    extra: "ignored",
    tasks: [{ id: "a", title: "A", command: "ls", cwd: "/nope" }],
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.tasks, [{ id: "a", title: "A", command: "ls", confirm: false }]);
});

test("confirm defaults to false and is never left undefined", () => {
  const result = parseTasksConfig(config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls" }] }));
  assert.equal(result.ok, true);
  assert.equal(result.tasks[0].confirm, false);
  assert.ok(Object.hasOwn(result.tasks[0], "confirm"));
  assert.equal(Object.hasOwn(result.tasks[0], "description"), false);
  assert.equal(Object.hasOwn(result.tasks[0], "group"), false);
});

test("confirm:false stays false", () => {
  const result = parseTasksConfig(config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls", confirm: false }] }));
  assert.equal(result.ok, true);
  assert.equal(result.tasks[0].confirm, false);
});

test("malformed JSON reports the parser message behind an Invalid JSON prefix", () => {
  const result = parseTasksConfig("{ nope");
  assert.equal(result.ok, false);
  assert.match(result.error, /^Invalid JSON: /);
});

test("empty text is invalid JSON rather than a crash", () => {
  const result = parseTasksConfig("");
  assert.equal(result.ok, false);
  assert.match(result.error, /^Invalid JSON: /);
});

test("non-object JSON roots are rejected with the object message", () => {
  for (const raw of ["[]", "null", '"tasks"', "42", "true"]) {
    expectError(raw, "Config must be an object");
  }
});

test("a non-string argument is rejected instead of throwing", () => {
  for (const value of [undefined, null, 7, {}, []]) {
    const result = parseTasksConfig(value);
    assert.equal(result.ok, false);
    assert.equal(result.error, "Config must be an object");
  }
});

test("the version must be the exact number 1", () => {
  expectError(config({ tasks: [] }), "Config version must be 1");
  expectError(config({ version: 2, tasks: [] }), "Config version must be 1");
  expectError(config({ version: "1", tasks: [] }), "Config version must be 1");
  expectError(config({ version: null, tasks: [] }), "Config version must be 1");
  expectError(config({ version: 1.5, tasks: [] }), "Config version must be 1");
});

test("tasks must be an array", () => {
  expectError(config({ version: 1 }), "Config tasks must be an array");
  expectError(config({ version: 1, tasks: {} }), "Config tasks must be an array");
  expectError(config({ version: 1, tasks: "build" }), "Config tasks must be an array");
  expectError(config({ version: 1, tasks: null }), "Config tasks must be an array");
});

test("each task entry must be an object, reported with a 1-based index", () => {
  expectError(config({ version: 1, tasks: ["build"] }), "Task 1 must be an object");
  expectError(
    config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls" }, null] }),
    "Task 2 must be an object",
  );
  expectError(
    config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls" }, { id: "b", title: "B", command: "ls" }, []] }),
    "Task 3 must be an object",
  );
});

test("id must be present and a non-empty string", () => {
  expectError(config({ version: 1, tasks: [{ title: "A", command: "ls" }] }), "Task 1 id must be a non-empty string");
  expectError(config({ version: 1, tasks: [{ id: "", title: "A", command: "ls" }] }), "Task 1 id must be a non-empty string");
  expectError(config({ version: 1, tasks: [{ id: "   ", title: "A", command: "ls" }] }), "Task 1 id must be a non-empty string");
  expectError(config({ version: 1, tasks: [{ id: 5, title: "A", command: "ls" }] }), "Task 1 id must be a non-empty string");
});

test("id charset is enforced and the message quotes the pattern", () => {
  const message = "Task 1 id must match ^[a-z][a-z0-9.-]*$";
  for (const id of ["Build", "1build", "-build", ".build", "build_task", "build task", "build!", "büild", "BUILD"]) {
    expectError(config({ version: 1, tasks: [{ id, title: "A", command: "ls" }] }), message);
  }
});

test("ids that hug the pattern boundaries are accepted", () => {
  for (const id of ["a", "a1", "a.b", "a-b", "build.step-2", "z9.-."]) {
    const result = parseTasksConfig(config({ version: 1, tasks: [{ id, title: "A", command: "ls" }] }));
    assert.equal(result.ok, true, `expected ${id} to be valid`);
    assert.equal(result.tasks[0].id, id);
  }
});

test("the charset check is not fooled by newlines", () => {
  expectError(
    config({ version: 1, tasks: [{ id: "build\nrm -rf /", title: "A", command: "ls" }] }),
    "Task 1 id must match ^[a-z][a-z0-9.-]*$",
  );
});

test("duplicate ids are rejected and name the offending id", () => {
  expectError(
    config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls" }, { id: "a", title: "B", command: "pwd" }] }),
    "Duplicate task id: a",
  );
});

test("a duplicate is only reported after the later task itself validates", () => {
  expectError(
    config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls" }, { id: "a", title: "B" }] }),
    "Task 2 command must be a non-empty string",
  );
});

test("title must be present and a non-empty string", () => {
  expectError(config({ version: 1, tasks: [{ id: "a", command: "ls" }] }), "Task 1 title must be a non-empty string");
  expectError(config({ version: 1, tasks: [{ id: "a", title: "  ", command: "ls" }] }), "Task 1 title must be a non-empty string");
  expectError(config({ version: 1, tasks: [{ id: "a", title: 0, command: "ls" }] }), "Task 1 title must be a non-empty string");
});

test("command must be present and a non-empty string", () => {
  expectError(config({ version: 1, tasks: [{ id: "a", title: "A" }] }), "Task 1 command must be a non-empty string");
  expectError(config({ version: 1, tasks: [{ id: "a", title: "A", command: "" }] }), "Task 1 command must be a non-empty string");
  expectError(config({ version: 1, tasks: [{ id: "a", title: "A", command: ["ls"] }] }), "Task 1 command must be a non-empty string");
  expectError(config({ version: 1, tasks: [{ id: "a", title: "A", command: 12 }] }), "Task 1 command must be a non-empty string");
  expectError(config({ version: 1, tasks: [{ id: "a", title: "A", command: null }] }), "Task 1 command must be a non-empty string");
});

test("optional description and group reject non-strings and blanks but allow absence", () => {
  expectError(
    config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls", description: 3 }] }),
    "Task 1 description must be a non-empty string when provided",
  );
  expectError(
    config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls", description: " " }] }),
    "Task 1 description must be a non-empty string when provided",
  );
  expectError(
    config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls", description: null }] }),
    "Task 1 description must be a non-empty string when provided",
  );
  expectError(
    config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls", group: false }] }),
    "Task 1 group must be a non-empty string when provided",
  );
  expectError(
    config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls", group: "" }] }),
    "Task 1 group must be a non-empty string when provided",
  );
});

test("confirm must be a boolean when provided", () => {
  expectError(
    config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls", confirm: "yes" }] }),
    "Task 1 confirm must be a boolean",
  );
  expectError(
    config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls", confirm: 1 }] }),
    "Task 1 confirm must be a boolean",
  );
  expectError(
    config({ version: 1, tasks: [{ id: "a", title: "A", command: "ls", confirm: null }] }),
    "Task 1 confirm must be a boolean",
  );
});

test("validation stops at the first failing task", () => {
  expectError(
    config({
      version: 1,
      tasks: [
        { id: "a", title: "A", command: "ls" },
        { id: "B", title: "B", command: "ls" },
        { id: "c", title: 0, command: "ls" },
      ],
    }),
    "Task 2 id must match ^[a-z][a-z0-9.-]*$",
  );
});

test("groupTasks preserves first-seen group order and interleaves back into one bucket", () => {
  const tasks = [
    { id: "a", title: "A", command: "ls", group: "Build", confirm: false },
    { id: "b", title: "B", command: "ls", group: "Test", confirm: false },
    { id: "c", title: "C", command: "ls", group: "Build", confirm: false },
  ];
  assert.deepEqual(groupTasks(tasks), [
    { group: "Build", tasks: [tasks[0], tasks[2]] },
    { group: "Test", tasks: [tasks[1]] },
  ]);
});

test("the undefined-group bucket keeps the position of its first task", () => {
  const tasks = [
    { id: "a", title: "A", command: "ls", group: "Build", confirm: false },
    { id: "b", title: "B", command: "ls", confirm: false },
    { id: "c", title: "C", command: "ls", group: "Build", confirm: false },
    { id: "d", title: "D", command: "ls", confirm: false },
  ];
  assert.deepEqual(groupTasks(tasks), [
    { group: "Build", tasks: [tasks[0], tasks[2]] },
    { group: undefined, tasks: [tasks[1], tasks[3]] },
  ]);
});

test("an ungrouped-first list puts the undefined bucket first", () => {
  const tasks = [
    { id: "a", title: "A", command: "ls", confirm: false },
    { id: "b", title: "B", command: "ls", group: "Test", confirm: false },
  ];
  assert.deepEqual(groupTasks(tasks), [
    { group: undefined, tasks: [tasks[0]] },
    { group: "Test", tasks: [tasks[1]] },
  ]);
});

test("groupTasks on an empty list yields no groups", () => {
  assert.deepEqual(groupTasks([]), []);
});

test("group ordering survives a round trip through parseTasksConfig", () => {
  const result = parseTasksConfig(config({
    version: 1,
    tasks: [
      { id: "lint", title: "Lint", command: "npm run lint", group: "Quality" },
      { id: "start", title: "Start", command: "npm run dev" },
      { id: "test", title: "Test", command: "npm test", group: "Quality" },
    ],
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(groupTasks(result.tasks).map((entry) => [entry.group, entry.tasks.map((task) => task.id)]), [
    ["Quality", ["lint", "test"]],
    [undefined, ["start"]],
  ]);
});
