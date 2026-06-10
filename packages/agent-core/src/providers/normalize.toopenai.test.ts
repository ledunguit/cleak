import { describe, expect, test } from 'bun:test';
import { toOpenAiMessages } from './normalize';
import type { Message } from '../types';

describe('toOpenAiMessages — assistant content validity', () => {
  test('empty assistant message (no text, no tool_calls) gets non-empty content', () => {
    // Providers reject "assistant must provide content, reasoning_content or tool_calls".
    const messages: Message[] = [{ role: 'assistant', content: '' }];
    const out = toOpenAiMessages('sys', messages) as any[];
    const assistant = out.find((m) => m.role === 'assistant');
    expect(assistant.content).toBeTruthy();
    expect(typeof assistant.content).toBe('string');
    expect(assistant.tool_calls).toBeUndefined();
  });

  test('assistant with tool_calls keeps null content (valid)', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'f', input: {} }] },
    ];
    const out = toOpenAiMessages('sys', messages) as any[];
    const assistant = out.find((m) => m.role === 'assistant');
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toHaveLength(1);
  });

  test('assistant with text keeps the text', () => {
    const messages: Message[] = [{ role: 'assistant', content: 'hello' }];
    const out = toOpenAiMessages('sys', messages) as any[];
    expect(out.find((m) => m.role === 'assistant').content).toBe('hello');
  });
});
