# Feedback cases — every 🐛 becomes a test

Owner, 2026-10-13: "each caterpillar (🐛) should become a new test."

Each file here is one 🐛 report, as an **anonymized** case (people are stand-ins — Aspen,
Birch, Cedar…; the reporter is "Viewer"; no phones, emails, ids or links). Get it from
`/admin/feedback` → **Copy test fixture**, save it as `<feedback id>.json`, and fill in
`expect` with what should have been true. `tests/integration/feedback-cases.test.js`
rebuilds the plan from the case (dates shifted to today) and checks every expectation.

`expect` keys are dotted paths into the rebuilt plan object (`plan.js` `planFor`, from the
reporter's side): `"stage": "proposed"`, `"dates.days.length": 2`. A key ending in `~`
means "contains": `"dates.label~": "proposed"`. `"waiting_on": []` compares exactly.

If the bug was the agent's behavior rather than the plan's state, write a test in
`tests/integration/` instead and put its name in the report's "Test that covers it".
Either way, a report can't be marked Fixed without one.
