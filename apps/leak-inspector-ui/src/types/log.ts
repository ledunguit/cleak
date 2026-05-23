// Log types

export interface LogEntry {
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  logger: string;
  message: string;
}

export type LogLevel = 'ALL' | 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
