import { join } from 'node:path';
import { serviceArguments, userHome, type ServiceDefinition } from './launchd.js';

export const SYSTEMD_UNIT = 'blockbase-ui';

export function systemdUnitPath(): string {
  return join(userHome(), '.config', 'systemd', 'user', `${SYSTEMD_UNIT}.service`);
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`;
}

export function renderUnit(definition: ServiceDefinition): string {
  const path = `${definition.nodePath.slice(0, definition.nodePath.lastIndexOf('/')) || '/'}:/usr/bin:/bin`;
  return `[Unit]
Description=Blockbase catalog page

[Service]
ExecStart=${serviceArguments(definition).map(quote).join(' ')}
Environment=${quote(`PATH=${path}`)}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function unitNodePath(content: string): string | undefined {
  const match = content.match(/^ExecStart="((?:[^"\\]|\\.)*)"/m);
  return match ? match[1].replaceAll('\\"', '"').replaceAll('%%', '%').replaceAll('\\\\', '\\') : undefined;
}
