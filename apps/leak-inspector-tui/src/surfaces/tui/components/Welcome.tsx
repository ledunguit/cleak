import { Box, Text } from 'ink';
import ThemedBox from '../theme/ThemedBox';
import ThemedText from '../theme/ThemedText';
import { color, glyph } from '../theme';
import { CLEAK_LOGO } from '../logo';

const BANNER = CLEAK_LOGO;

export interface WelcomeBannerProps {
  provider: string;
  model: string;
  cwd: string;
}

/** Logo banner + provider/model/cwd — rendered in the sticky header. */
export function WelcomeBanner({ provider, model, cwd }: WelcomeBannerProps) {
  return (
    <ThemedBox alignSelf="flex-start" flexDirection="column" borderStyle="round" borderColor="accent" paddingX={1}>
      {BANNER.map((line, i) => (
        <ThemedText key={`b${i}`} color="accent" bold>
          {line}
        </ThemedText>
      ))}
      <Text dimColor>
        {provider} {glyph.bullet} {model || '?'} {glyph.bullet} {shorten(cwd)}
      </Text>
    </ThemedBox>
  );
}

export interface WelcomeSidebarProps {
  recentScans: string[];
}

/** Tips + recent scans — rendered in the sidebar. */
export function WelcomeSidebar({ recentScans }: WelcomeSidebarProps) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={color.accent}>Tips</Text>
      <Text dimColor>
        <Text color={color.accent}>/scan</Text> investigate
      </Text>
      <Text dimColor>
        <Text color={color.accent}>/preflight</Text> check
      </Text>
      <Text dimColor>
        <Text color={color.accent}>/mode</Text> {glyph.bullet}{' '}
        <Text color={color.accent}>/config</Text> {glyph.bullet}{' '}
        <Text color={color.accent}>/tools</Text>
      </Text>
      <Text dimColor>
        <Text color={color.accent}>/quit</Text> exit
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold color={color.accent}>Recent</Text>
        {recentScans.length === 0 ? (
          <Text dimColor>none yet</Text>
        ) : (
          recentScans.map((s) => (
            <Text key={s} dimColor>
              {glyph.bullet} {s}
            </Text>
          ))
        )}
        <Text dimColor>
          <Text color={color.accent}>/scans</Text> {glyph.bullet}{' '}
          <Text color={color.accent}>/report</Text>
        </Text>
      </Box>
    </Box>
  );
}

/** Backward-compat: full Welcome (banner + tips/recent row). */
export interface WelcomeProps {
  provider: string;
  model: string;
  staticUrl: string;
  cwd: string;
  recentScans: string[];
}

export function Welcome({ provider, model, cwd, recentScans }: WelcomeProps) {
  return (
    <Box flexDirection="column">
      <WelcomeBanner provider={provider} model={model} cwd={cwd} />
      <Box marginTop={1}>
        <WelcomeSidebar recentScans={recentScans} />
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
