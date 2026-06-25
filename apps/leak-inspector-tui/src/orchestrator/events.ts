/**
 * Scan event emission. Events use the shared ScanEventName/ScanPhase contract so
 * the timeline, the events.jsonl experiment log, and (later) any other consumer
 * all speak the same vocabulary as the rest of the system.
 */

import { ScanEventName, type ScanPhase, phaseForEvent } from '@cleak/common/flow/scan-flow-contract';
import { appendFileSync } from 'node:fs';

export interface ScanEvent {
  seq: number;
  ts: number;
  name: ScanEventName;
  phase?: ScanPhase;
  data?: Record<string, unknown>;
}

export interface EventSink {
  emit(event: ScanEvent): void;
}

/** Stamps + routes events to a sink. */
export class ScanEmitter {
  private seq = 0;
  constructor(
    private readonly sink: EventSink,
    private readonly now: () => number = () => Date.now(),
  ) {}

  emit(name: ScanEventName, data?: Record<string, unknown>): void {
    this.sink.emit({ seq: this.seq++, ts: this.now(), name, phase: phaseForEvent(name), data });
  }
}

/** Append every event as one JSON line to a file (the experiment log). */
export class JsonlFileSink implements EventSink {
  constructor(
    private readonly filePath: string,
    private readonly alsoStdout = false,
  ) {}

  emit(event: ScanEvent): void {
    const line = JSON.stringify(event);
    appendFileSync(this.filePath, line + '\n');
    if (this.alsoStdout) process.stdout.write(`[${event.name}] ${event.data ? JSON.stringify(event.data) : ''}\n`);
  }
}

/** Forward events to a callback (used by the TUI to push into its store). */
export class CallbackSink implements EventSink {
  constructor(private readonly cb: (event: ScanEvent) => void) {}
  emit(event: ScanEvent): void {
    this.cb(event);
  }
}

/** Fan out to several sinks. */
export class MultiSink implements EventSink {
  constructor(private readonly sinks: EventSink[]) {}
  emit(event: ScanEvent): void {
    for (const s of this.sinks) s.emit(event);
  }
}

export { ScanEventName };
