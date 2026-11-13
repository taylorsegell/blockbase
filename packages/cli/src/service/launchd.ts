import { homedir } from 'node:os';
import { join } from 'node:path';

export const LAUNCHD_LABEL = 'com.blockbase.ui';

export type ServiceDefinition = {
  nodePath: string;
  entry: string;
  port: number;
  catalogRoot: string;
  allowedHosts: string[];
};

export function userHome(): string {
  return process.env.HOME || homedir();
}

export function launchdPlistPath(): string {
  return join(userHome(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function launchdLogPaths(): { out: string; err: string } {
  const logs = join(userHome(), 'Library', 'Logs');
  return { out: join(logs, 'blockbase-ui.log'), err: join(logs, 'blockbase-ui.err.log') };
}

export function serviceArguments(definition: ServiceDefinition): string[] {
  return [
    definition.nodePath,
    definition.entry,
    'ui',
    '--port',
    String(definition.port),
    '--catalog',
    definition.catalogRoot,
    ...definition.allowedHosts.flatMap((host) => ['--allowed-host', host]),
  ];
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderPlist(definition: ServiceDefinition): string {
  const logs = launchdLogPaths();
  const args = serviceArguments(definition).map((value) => `    <string>${xml(value)}</string>`).join('\n');
  const path = `${definition.nodePath.slice(0, definition.nodePath.lastIndexOf('/')) || '/'}:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(logs.out)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logs.err)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
</dict>
</plist>
`;
}

/** The program path recorded in an installed plist, or undefined when the file is not one of ours. */
export function plistNodePath(content: string): string | undefined {
  const match = content.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/);
  return match ? match[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&') : undefined;
}
