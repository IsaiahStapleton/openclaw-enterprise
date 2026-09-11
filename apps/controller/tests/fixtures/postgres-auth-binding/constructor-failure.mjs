import assert from "node:assert/strict";
import { createPostgresAuthBinding } from "@openclaw-enterprise/occ/auth-persistence/postgres-auth-binding";

const expected = new Error("caller pool inspection failed");
let connects = 0;
let ends = 0;
// Refusing an unsupported object must not invoke its constructor accessor.
const pool = {
  get constructor() {
    throw expected;
  },
  async connect() {
    connects++;
    throw new Error("unexpected connect");
  },
  async end() {
    ends++;
  },
};
await assert.rejects(createPostgresAuthBinding(pool), /requires a node-postgres Pool/);
assert.equal(connects, 0);
assert.equal(ends, 0);
