# @a2app/rules

The **pure rules** layer of the A2App adapter.

This package contains the validation logic — type checks, date and day-key
rules, enum checks, the read-back divergence check, and the canonical violation
messages — with **no backend, runtime, or I/O dependency**. It is what
guarantees that two different backends reject an identical payload identically.

An adapter never forks these rules. It only:

1. maps its backend's native field types onto the protocol type vocabulary
 (`string`, `number`, `boolean`, `datetime`, `enum`, `ref`, `list<enum>`,
 `list<ref>`, `json`, `binary`);
2. calls `validate` (on the **raw** body, before backend coercion) and
 `divergences` (after the write, for the read-back backstop);
3. renders the returned `Violation[]` as its transport's error envelope.

```ts
import { validate, divergences, type NormalizedField } from "@a2app/rules";

const fields: NormalizedField[] = [
 { name: "title", type: "string", required: true, max: 255 },
 { name: "due", type: "string", max: 10, dayKey: true },
];

const violations = validate(fields, { title: "Buy milk", due: "tomorrow" });
// -> [{ code: "invalid_daykey", field: "due",... }]
```

The PocketBase blueprint ships a goja-compatible `.js` twin of this file
(`_a2app_rules.js`) because it runs inside PocketBase's embedded JS VM rather
than Node; the two are kept semantically identical and both are exercised by the
conformance suite.
