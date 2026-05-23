import { Settings } from 'lucide-react';
import { FolderGit2, History, LayoutDashboard } from 'lucide-react';
import { Flex, Menu } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';

import type { MenuProps } from 'antd';

export interface WorkflowTab {
  to: string;
  label: string;
  icon: React.ReactNode;
}

export const WORKFLOW_TABS: WorkflowTab[] = [
  {
    to: '/workspaces',
    label: 'Workspaces',
    icon: <LayoutDashboard size={16} strokeWidth={2.1} />,
  },
  {
    to: '/investigations',
    label: 'Investigations',
    icon: <History size={16} strokeWidth={2.1} />,
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: <Settings size={16} strokeWidth={2.1} />,
  },
];

function extractScanId(pathname: string): string | null {
  const match = pathname.match(/^\/(?:activity|report)\/([^/]+)$/);
  return match ? match[1] : null;
}

function resolveTabPath(tab: WorkflowTab | undefined, scanId: string | null): string {
  if (!tab) {
    return '/setup';
  }
  if (!scanId) {
    return tab.to;
  }
  if (tab.to === '/activity' || tab.to === '/report') {
    return `${tab.to}/${scanId}`;
  }
  return tab.to;
}

function buildMenuLabel(tab: WorkflowTab, compact: boolean, collapsed: boolean): string | React.ReactNode | null {
  if (compact) {
    return tab.label;
  }

  if (collapsed) {
    return null;
  }

  return (
    <Flex align="center" style={{ minHeight: 22 }}>
      <span>{tab.label}</span>
    </Flex>
  );
}

export interface WorkflowTabsProps {
  compact?: boolean;
  collapsed?: boolean;
  activeScanId?: string | null;
}

export function WorkflowTabs({ compact = false, collapsed = false, activeScanId = null }: WorkflowTabsProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const scanId = activeScanId || extractScanId(location.pathname);
  const selectedKey =
    WORKFLOW_TABS.find((tab) => location.pathname.startsWith(tab.to))?.to ||
    '/setup';

  const handleClick: MenuProps['onClick'] = ({ key }) => {
    navigate(resolveTabPath(WORKFLOW_TABS.find((tab) => tab.to === key), scanId));
  };

  return (
    <Menu
      mode={compact ? 'horizontal' : 'inline'}
      selectedKeys={[selectedKey]}
      {...(!compact && { inlineCollapsed: collapsed })}
      onClick={handleClick}
      items={WORKFLOW_TABS.map((tab) => ({
        key: tab.to,
        icon: <span className="app-shell-menu-icon">{tab.icon}</span>,
        label: buildMenuLabel(tab, compact, collapsed),
        title: tab.label,
      }))}
      style={{
        borderInlineEnd: 0,
        background: 'transparent',
      }}
      className="app-shell-menu"
    />
  );
}
