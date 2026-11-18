// How to run this CLI again (for detached background refreshes): `node <script>` when running from the bundle, or
// the executable alone when running as a standalone single-executable build.
import path from 'node:path';

export function isStandalone(argv = process.argv, execPath = process.execPath): boolean {
  const script = argv[1];
  return !script || !/\.[cm]?js$/i.test(script) || path.resolve(script) === path.resolve(execPath);
}

/** Command and leading arguments that re-run ctx, e.g. ["node", ["…/ctx.mjs"]] or ["…/ctx-linux-x64", []]. */
export function selfCommand(argv = process.argv, execPath = process.execPath): { cmd: string; args: string[] } {
  return isStandalone(argv, execPath) ? { cmd: execPath, args: [] } : { cmd: execPath, args: [argv[1]] };
}

/** "node v24.1.0" or "standalone build (node v24.1.0)". */
export function runtimeLabel(): string {
  return isStandalone() ? `standalone build (node ${process.version}) at ${process.execPath}` : `node ${process.version}`;
}
