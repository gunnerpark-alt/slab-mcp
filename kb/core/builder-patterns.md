---
type: guide
section: core
tags: [builder-patterns, formula, action, cell-size, scheduling]
description: "Core mental model for Clay builders: when to escalate from formula columns to action columns, plus canonical patterns for array manipulation, cell size expansion, and scheduled cascades."
created: 2026-04-11
updated: 2026-04-11
verified: 2026-04-11
---

# Clay Builder Patterns

The best Clay builders don't memorize provider names or credit costs. They understand what Clay's primitives are and how to combine them to solve any problem. When you get stuck, ask: **what constraint am I hitting, and what primitive can I use to route around it?**

---

## The Core Mental Model

**Formula columns** — computed instantly, synchronous, max 8KB output. Can't exceed cell size. Can't hold arrays through modification. Can't run on a schedule independently.

**Action columns** — run asynchronously, have their own cell status, max 200KB output. Can run on schedule. Can be gated with run conditions. Are the right container for anything complex.

**Key insight:** Whenever a formula column isn't enough, wrap it in an action column. `Filter List of Objects`, `Use AI`, even a no-op HTTP call can be the container that gives you the extra capabilities you need.

---

## Pattern: Formulas on Arrays (Filter List of Objects as Container)

**Problem:** You want to run a formula on an array — concatenate two arrays, add a new field to every object, filter objects by a condition. Formula columns can't modify arrays without losing the JSON structure.

**Solution:** Use `Filter List of Objects` as a container. Set it to filter on `true` (keep everything) — the filter is irrelevant. The real work happens in the formula you write inside it.

Use this for: removing objects, reordering, restructuring keys, merging multiple arrays together.

---

## Pattern: Cell Size Expansion (Action Column as Buffer)

**Problem:** A formula needs to concatenate two large values, but the result exceeds the 8KB formula column limit.

**Solution:** Use an action column as the container. Action columns allow 200KB output.

```
// Instead of this formula (breaks at 8KB):
{{AI Output}} + "\n\n" + {{Existing Notes}}

// Do this: Filter List of Objects
// Input: [{ "part_a": {{AI Output}}, "part_b": {{Existing Notes}} }]
// Formula (inside): item.part_a + "\n\n" + item.part_b
```

---

## Pattern: Scheduled Delay (moment + run condition)

**Problem:** You want a row to trigger an action N days after it was created.

**Solution:**
1. Formula column: `moment({{Created At}}).add(4, 'days').valueOf()` — computes target timestamp
2. Action column set to run on **daily schedule**
3. Run condition on that action: `moment().valueOf() >= {{Target Timestamp}}`

**Why `moment()` specifically:** The `moment()` call (current time) is the only formula that updates on each recurring run. This is what makes time-based conditions work.

---

## Pattern: Auto-Delete Workaround (Fake Dedupe)

**Solution:** Add a formula column at the end that outputs `"processed"` once all enrichment is done. Enable auto-dedupe on that column. Result: exactly one row with `"processed"` — the dedupe keeps the first and removes all subsequent ones.

Useful for "single-fire" tables where each incoming webhook should process once and then effectively disappear.

---

## Pattern: One-to-Many Deduplication

**Problem:** 5 contacts arrive simultaneously, all from the same company. You want to create the company record exactly once.

**Solution: Self-lookup + occurrence index**

1. Lookup column that looks up the current table itself using any company identifier
2. Formula column that indexes which occurrence this row is:
   ```javascript
   ({{Self Lookup}}?.records || []).findIndex(r => r.fields?.["Row ID"] === {{Row ID}}) + 1
   ```
3. Set the "Create Account" run condition: `{{Occurrence Index}} === 1`

Generalizes to any "do X exactly once per group" problem.

---

## Pattern: Cascading Scheduled Runs

**Problem:** 10 columns need to re-run on a schedule. Setting all 10 to run on a schedule wastes credits.

**Solution:** Set **one** column to run on schedule. Set every other column's run condition to depend on the immediate upstream column's output.

```
Scheduled column (runs daily) → outputs a timestamp

Column 2 run condition: !!{{Scheduled Column}}
Column 3 run condition: !!{{Scheduled Column}} && !!{{Column 2}}
...
```

The entire pipeline re-runs in order every day, triggered by a single scheduled column.

---

## Pattern: Lookup That Returns No Results (Cell Status Workaround)

**Problem:** A Lookup column runs but returns no matching records. Downstream columns with `!!{{Lookup Result}}` won't fire because the lookup returned empty.

**Solution:** Gate on `Clay.getCellStatus()` instead of (or in addition to) the raw value:

```javascript
// Fire downstream even when Lookup returned no results:
!!{{Lookup Result}} || Clay?.getCellStatus?.({{Lookup Result}})?.toLowerCase?.() === "success"

// Fire if the lookup ran at all:
["success", "blank"].includes(Clay?.getCellStatus?.({{Lookup Result}})?.toLowerCase?.())
```

---

## Pattern: Batch Processing (Drip Through Rows)

**Problem:** A table has 10,000 rows. You want to process exactly N rows per day.

**Solution: Filtered view + boolean flag + scheduled run**

1. Formula column: `{{Processing Done}}` — outputs `true` once enrichment is complete
2. Create a **filtered view** that only shows rows where `{{Processing Done}}` is false
3. Set **row limit** on that view to N
4. Set enrichment column to run on **daily schedule**

The view acts as a cursor. As rows get marked done, the next batch becomes visible.

---

## Pattern: Using Tables as Event Queues

A Clay table can act as a queue: rows are pushed in (via webhook or Send Table Data), processed in order, then marked done or deleted.

Key principles for queue tables:
- Dedupe on arrival (auto-dedupe on a key column)
- Add a `received_at` timestamp from the source
- Use filtered views to process subsets
- Use Send Table Data (not Write to Table — WTT is deprecated) to push results downstream

---

## Pattern: Multi-Table Orchestration

When a single table isn't enough — column limits or one-to-many relationships:

```
Table A: receives inbound data, does fast qualification
         → Send Table Data to Table B (only qualified rows)

Table B: runs expensive enrichment
         → Send Table Data to Table C

Table C: finds contacts, sends to CRM
```

Column limit: ~30 computable columns by default (+10 for email/phone waterfalls).

---

## Pattern: Boolean Feature-Flag Column as Circuit Breaker

When a table serves multiple use cases, add a single boolean input column and check `== true` in the run condition of every step in the optional branch. This keeps the table's logic self-documenting — a reader can immediately see which columns are conditional.

---

## Pattern: Wrapping the Obvious in a Run Condition

Clay runs columns left-to-right within a row, but it doesn't wait for Column A to finish before starting Column B — unless Column B's run condition references Column A's output. When you need sequential execution, use run conditions as explicit ordering constraints.

---

## Related

- [[core/data-model|Data Model]] — formula vs action column types and the 8 KB / 200 KB limits
- [[architecture/pipeline-stages|Pipeline Stages]] — applied multi-table orchestration patterns
- [[enrichment/waterfalls|Waterfalls]] — dependent waterfall workarounds using httpstat.us
- [[use-cases/subroutines|Subroutines]] — the canonical multi-table pattern for reusable logic
