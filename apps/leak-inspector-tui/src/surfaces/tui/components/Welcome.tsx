import { Box, Text } from 'ink';
import { color, glyph } from '../theme';
import { renderBanner } from '../logo';

const BANNER = renderBanner('LEAK INVESTIGATOR');

export interface WelcomeProps {
  provider: string;
  model: string;
  staticUrl: string;
  cwd: string;
  recentScans: string[];
}

export function Welcome({ provider, model, staticUrl, cwd, recentScans }: WelcomeProps) {
  return (
    <Box flexDirection="column">
      {/* Compact retro wordmark, framed for a CRT vibe */}
      <Box alignSelf="flex-start" flexDirection="column" borderStyle="round" borderColor={color.accent} paddingX={1}>
        {BANNER.map((line, i) => (
          <Text key={`b${i}`} color={color.accent} bold>
            {line}
          </Text>
        ))}
        <Text dimColor>
          {provider} {glyph.bullet} {model || '?'} {glyph.bullet} {shorten(cwd)}
        </Text>
      </Box>

      {/* Tips + recent activity */}
      <Box flexDirection="row" marginTop={1}>
        <Box flexDirection="column">
          <Text bold>Tips for getting started</Text>
          <Text dimColor>
            Run <Text color={color.accent}>/scan &lt;repo&gt;</Text> to investigate a C/C++ project
          </Text>
          <Text dimColor>
            <Text color={color.accent}>/preflight</Text> check analyzers {glyph.bullet}{' '}
            <Text color={color.accent}>/mode</Text> {glyph.bullet} <Text color={color.accent}>/config</Text> {glyph.bullet}{' '}
            <Text color={color.accent}>/tools</Text> {glyph.bullet} <Text color={color.accent}>/quit</Text>
          </Text>
        </Box>
        <Box marginLeft={4} flexDirection="column">
          <Text bold>Recent scans</Text>
          {recentScans.length === 0 ? (
            <Text dimColor>No recent scans</Text>
          ) : (
            recentScans.map((s) => (
              <Text key={s} dimColor>
                {glyph.bullet} {s}
              </Text>
            ))
          )}
          <Text dimColor>
            review: <Text color={color.accent}>/scans</Text> {glyph.bullet}{' '}
            <Text color={color.accent}>/report &lt;scanId&gt;</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

function shorten(p: string): string {
  const home = process.env.HOME;
  const withHome = home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  const parts = withHome.split('/');
  return parts.length <= 3 ? withHome : `…/${parts.slice(-2).join('/')}`;
}
