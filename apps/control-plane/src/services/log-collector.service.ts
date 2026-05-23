import { Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class LogCollectorService {
  async getLogs(scanId: string, format: string) {
    return { content: '', contentType: 'text/plain' };
  }

  streamLogs(scanId: string): Observable<{ line: string; timestamp: string }> {
    return new Observable((subscriber) => {
      subscriber.complete();
    });
  }
}
