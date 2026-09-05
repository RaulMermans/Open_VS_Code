import { test, run } from "node:test";
import { resolve } from "node:path";
run({ files: [resolve("packages/agent-core/tests/context/skill-safety.test.ts")] }).on("test:fail", (d) => console.log(d.details.error));
