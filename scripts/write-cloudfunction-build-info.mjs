import { writeFileSync } from "node:fs";

writeFileSync(
  new URL("../cloudfunctions/api/dist/build-info.json", import.meta.url),
  `${JSON.stringify({ builtAt: new Date().toISOString() }, null, 2)}\n`,
);
