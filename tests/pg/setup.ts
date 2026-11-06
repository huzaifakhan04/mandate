import { afterAll } from "vitest";

import { disposePgTestDbs } from "@/server/db/testingPg";

// Every database a test file created is dropped once that file finishes.
afterAll(async () => {
  await disposePgTestDbs();
});
