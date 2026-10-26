import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.env.TAURI_ENV_TARGET_TRIPLE || execFileSync('rustc', ['-vV'], {encoding:'utf8'}).match(/^host: (.+)$/m)?.[1];
const arch = target?.startsWith('aarch64-') ? 'arm64' : target?.startsWith('x86_64-') ? 'amd64' : null;
const os = target?.includes('apple-darwin') ? 'darwin' : target?.includes('windows') ? 'windows' : target?.includes('linux') ? 'linux' : null;
if (!arch || !os) throw new Error(`Unsupported D2 helper target: ${target}`);
const destination = path.join(root, 'src-tauri/binaries', `depdoodle-d2-${target}${os === 'windows' ? '.exe' : ''}`);
mkdirSync(path.dirname(destination), {recursive:true});
execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', destination, '.'], {
  cwd: path.join(root, 'src-d2'), stdio:'inherit', env: {...process.env, CGO_ENABLED:'0', GOOS:os, GOARCH:arch},
});
