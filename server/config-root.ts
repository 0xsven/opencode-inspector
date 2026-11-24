import os from 'node:os';
import path from 'node:path';

export function globalConfigRoot(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
}
