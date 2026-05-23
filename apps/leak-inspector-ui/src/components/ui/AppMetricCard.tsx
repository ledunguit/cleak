import type { ReactNode, CSSProperties } from 'react';
import type { StatisticProps } from 'antd';
import { Statistic } from 'antd';

import { AppCard } from './AppCard';
import type { AppCardProps } from './AppCard';

export interface AppMetricCardProps extends Omit<AppCardProps, 'children'> {
  metric: ReactNode;
  value?: string | number;
  statisticProps?: StatisticProps;
  valueStyle?: CSSProperties;
  children?: ReactNode;
}

export function AppMetricCard({
  metric,
  value,
  statisticProps,
  valueStyle,
  children,
  ...cardProps
}: AppMetricCardProps) {
  return (
    <AppCard size="small" bodyGap={children ? 12 : 0} {...cardProps}>
      <Statistic title={metric} value={value} valueStyle={valueStyle} {...statisticProps} />
      {children}
    </AppCard>
  );
}
