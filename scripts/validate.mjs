import { spawnSync } from 'node:child_process';
const bin = process.env.CTX_CLAUDE_BIN ?? process.env.CLAUDE_CODE_EXECPATH ?? 'claude';
const r = spawnSync(bin, ['plugin', 'validate', './ctx'], { stdio: 'inherit', shell: false });
process.exit(r.status ?? 1);
