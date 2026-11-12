import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./test-helpers.mjs";

const request = await load("./request.ts");
const days = await load("./days.ts");
const store = await load("./store.ts");

const TODAY = "2026-11-12";
const params = (query) => new URLSearchParams(query);
const EARLIEST = days.addDays(TODAY, 1 - store.RETAIN_DAYS);

test("a request that names no period gets the last 7 days", () => {
  assert.deepEqual(request.parsePeriod(params(""), TODAY), { ok: true, value: { from: "2026-11-06", to: TODAY, days: 7, preset: "7d" } });
});

test("every preset resolves against today and anything else is refused", () => {
  assert.deepEqual(request.parsePeriod(params("preset=today"), TODAY).value, { from: TODAY, to: TODAY, days: 1, preset: "today" });
  assert.equal(request.parsePeriod(params("preset=30d"), TODAY).value.days, 30);
  assert.equal(request.parsePeriod(params("preset=90d"), TODAY).value.from, days.addDays(TODAY, -89));
  const refused = request.parsePeriod(params("preset=yesterday"), TODAY);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "invalid_preset");
});

test("a custom range is taken as asked and carries no preset", () => {
  assert.deepEqual(request.parsePeriod(params("from=2026-11-03&to=2026-11-05"), TODAY), {
    ok: true,
    value: { from: "2026-11-03", to: "2026-11-05", days: 3, preset: null },
  });
  assert.equal(request.parsePeriod(params("from=2026-11-03&to=2026-11-03"), TODAY).value.days, 1);
  assert.equal(request.parsePeriod(params("preset=7d&from=2026-11-03&to=2026-11-05"), TODAY).value.preset, null, "a range wins over a preset");
});

test("a custom range never reaches past today or before the days the index keeps", () => {
  const future = request.parsePeriod(params("from=2026-11-10&to=2030-01-01"), TODAY);
  assert.deepEqual(future.value, { from: "2026-11-10", to: TODAY, days: 3, preset: null });

  const ancient = request.parsePeriod(params("from=2000-01-01&to=2026-11-12"), TODAY);
  assert.equal(ancient.ok, true);
  assert.equal(ancient.value.from, EARLIEST);
  assert.equal(ancient.value.days, store.RETAIN_DAYS);
});

test("a range wholly outside the kept days is refused, not silently emptied", () => {
  for (const query of ["from=2020-01-01&to=2020-02-01", "from=2030-01-01&to=2030-02-01"]) {
    const result = request.parsePeriod(params(query), TODAY);
    assert.equal(result.ok, false, query);
    assert.equal(result.code, "invalid_range", query);
  }
});

test("a half-given, reversed or unreal range is refused", () => {
  for (const query of ["from=2026-11-03", "to=2026-11-05", "from=2026-11-05&to=2026-11-03", "from=2026-02-30&to=2026-03-01", "from=soon&to=later", "from=&to="]) {
    const result = request.parsePeriod(params(query), TODAY);
    assert.equal(result.ok, false, query);
    assert.equal(result.code, "invalid_range", query);
  }
});

test("a deep dive asks for no period unless the request names one", () => {
  assert.deepEqual(request.parseOptionalPeriod(params("session=abc"), TODAY), { ok: true, value: null });
  assert.equal(request.parseOptionalPeriod(params("session=abc&preset=30d"), TODAY).value.days, 30);
  assert.equal(request.parseOptionalPeriod(params("session=abc&from=2026-11-03&to=2026-11-05"), TODAY).value.days, 3);
  assert.equal(request.parseOptionalPeriod(params("session=abc&from=2026-11-03"), TODAY).ok, false);
});

test("groupBy defaults to provider and accepts only the four orders", () => {
  assert.deepEqual(request.parseGroupBy(params("")), { ok: true, value: "provider" });
  for (const value of ["provider", "project", "model", "worker"]) assert.equal(request.parseGroupBy(params(`groupBy=${value}`)).value, value);
  const refused = request.parseGroupBy(params("groupBy=chat"));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "invalid_group_by");
  assert.equal(request.parseGroupBy(params("groupBy=toString")).ok, false, "inherited object keys are not group orders");
});

test("a deep dive names one chat by a plausible id", () => {
  assert.deepEqual(request.parseSession(params("")), { ok: true, value: null });
  assert.deepEqual(request.parseSession(params("session=0f3a9c1e-1111-2222-3333-444455556666")), { ok: true, value: "0f3a9c1e-1111-2222-3333-444455556666" });
  assert.equal(request.parseSession(params("session=")).code, "invalid_session");
  assert.equal(request.parseSession(params(`session=${"x".repeat(201)}`)).code, "invalid_session");
  assert.equal(request.parseSession(params(`session=${"x".repeat(200)}`)).ok, true);
});
