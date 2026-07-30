import { describe, expect, test } from 'bun:test';
import { harnessWorkerUserMessage } from '../../src/domain/subAgentPrompts';
import type { LeakBundle } from '@cleak/common/types';

function bundle(): LeakBundle {
  return {
    bundleId: 'b1',
    candidate: {
      id: '',
      function_name: 'f',
      file_path: '/repo/f.c',
      line_number: 8,
      allocation_site: '',
      allocation_type: 'malloc',
      confidence: 'medium',
      context: '',
    },
    evidence: [],
    status: 'pending' as any,
    createdAt: '',
    updatedAt: '',
  };
}

describe('harnessWorkerUserMessage — suggestedClosureFiles', () => {
  test('renders a candidates-for-closureFiles line when suggestions are given', () => {
    const msg = harnessWorkerUserMessage(bundle(), {}, ['/repo/helper.c', '/repo/util.c']);
    expect(msg).toContain('candidates for closureFiles');
    expect(msg).toContain('/repo/helper.c');
    expect(msg).toContain('/repo/util.c');
  });

  test('omits the line entirely when there are no suggestions', () => {
    const msg = harnessWorkerUserMessage(bundle(), {});
    expect(msg).not.toContain('candidates for closureFiles');
  });
});
