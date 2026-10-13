// Entry for the published npm package: runs the CLI under plain Node or Bun.
import { run } from '../src/index';

const result = await run(process.argv.slice(2));
if (result.code === 0) console.log(result.output);
else console.error(result.output);
process.exit(result.code);
