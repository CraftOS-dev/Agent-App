import { startReferenceApp } from "../conformance/harness/dist/reference-app.js";
const app = await startReferenceApp();
const cases = [
  {card: "does_not_exist"},
  {card: 12345},
  {card: {a:1}},
  {card: ["x"]},
  {card: true},
  {card: ""},
  {card: null},
  {},
  {card: "card_seed", bogus: 1},
  {card: "card_seed"},
];
for (const body of cases) {
  const r = await fetch(app.url + "/api/ops/finish-card", {
    method: "POST",
    headers: { "content-type": "application/json", "x-a2app-token": app.fullToken },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  console.log(JSON.stringify(body), "->", r.status, JSON.stringify(j));
}
await app.close();
