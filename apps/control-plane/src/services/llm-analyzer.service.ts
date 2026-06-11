import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { Observable } from 'rxjs';
import { RepositoryEntity } from '@mcpvul/common';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '__pycache__', '.venv', 'build', 'dist', '.cache']);
const TEXT_EXTS = new Set([
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
  '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs',
  '.rb', '.php', '.swift', '.kt', '.scala', '.m', '.mm',
  '.make', '.cmake', '.mk', '.txt', '.cfg', '.conf',
  '.yml', '.yaml', '.json', '.xml', '.toml', '.ini',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat',
  '.md', '.rst', '.tex',
]);
const MAX_TURNS = 5;
const MAX_FILE_CHARS = 3000;
const MAX_FILE_SIZE = 50000;

interface FileEntry {
  path: string;
  ext: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
}

type ProgressEvent = 'scanning_files' | 'analyzing_with_llm' | 'reading_file' | 'tool_call' | 'thinking' | 'complete' | 'error';

@Injectable()
export class LlmAnalyzerService {
  private readonly logger = new Logger(LlmAnalyzerService.name);

  // Tool definitions shared across providers
  private readonly tools: ToolDefinition[] = [
    {
      name: 'read_file',
      description: 'Read the contents of a file in the repository. Use this to inspect build configuration files (Makefile, CMakeLists.txt, etc.), source files, or scripts.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path from repository root (e.g. "Makefile", "src/CMakeLists.txt")',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'finalize_analysis',
      description: 'Finalize the analysis with structured results. Call this when you have enough information about the project.',
      input_schema: {
        type: 'object',
        properties: {
          languages: {
            type: 'array',
            items: { type: 'string' },
            description: 'Programming languages detected in the project',
          },
          buildCommand: {
            type: 'string',
            description: 'The complete build command with clang and -fsanitize=leak flags for dynamic analysis',
          },
          lsanSupported: {
            type: 'boolean',
            description: 'Whether LeakSanitizer can be used with this project',
          },
          lsanNote: {
            type: 'string',
            description: 'Explanation of LSan support and any special requirements',
          },
        },
        required: ['languages', 'buildCommand', 'lsanSupported', 'lsanNote'],
      },
    },
  ];

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(RepositoryEntity)
    private readonly repoRepo: Repository<RepositoryEntity>,
  ) {}

  async analyze(
    workspaceId: string,
    repoId: string,
    onProgress?: (event: ProgressEvent, message: string, data?: Record<string, unknown>) => void,
  ) {
    const emit = (event: ProgressEvent, message: string, data?: Record<string, unknown>) => {
      onProgress?.(event, message, data);
    };

    try {
      // 1. Get repo
      const repo = await this.repoRepo.findOneBy({ repoId, workspaceId });
      if (!repo) throw new BadRequestException('Repository not found');

      const repoPath = repo.localClonePath;
      if (!repoPath || !existsSync(repoPath)) {
        throw new BadRequestException('Repository has not been cloned yet. Clone it first.');
      }

      // 2. Walk directory
      emit('scanning_files', 'Scanning repository files...');
      const files = this.walkDirectory(repoPath, repoPath);
      emit('scanning_files', `Found ${files.length} source files.`);

      // 3. Build file overview
      const fileOverview = this.buildFileOverview(repoPath, files);

      // 4. Enter agent loop
      emit('analyzing_with_llm', 'Analyzing project structure with LLM...');
      const result = await this.runAgentLoop(repoPath, fileOverview, emit);
      this.logger.log(`LLM analysis complete: languages=${result.languages.join(',')}, buildCommand=${result.buildCommand}`);
      emit('complete', 'Analysis complete', result as any);
      return result;
    } catch (err: any) {
      this.logger.error(`LLM analysis failed: ${err.message}`);
      const fallback = {
        languages: ['C', 'C++'],
        buildCommand: 'make CC=clang',
        lsanSupported: false,
        lsanNote: err.message || 'Could not determine LSan support automatically.',
        filesExamined: [] as string[],
      };
      emit('complete', 'Analysis complete (fallback)', fallback as any);
      return fallback;
    }
  }

  analyzeWithSSE(workspaceId: string, repoId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      this.analyze(workspaceId, repoId, (event, message, data) => {
        subscriber.next({ data: JSON.stringify({ event, message, data }) } as MessageEvent);
      })
        .then(() => subscriber.complete())
        .catch((err) => {
          subscriber.next({
            data: JSON.stringify({ event: 'error', message: err.message }),
          } as MessageEvent);
          subscriber.error(err);
        });
    });
  }

  // ── Agent Loop ──

  private async runAgentLoop(
    repoPath: string,
    fileOverview: string,
    emit: (event: ProgressEvent, message: string, data?: Record<string, unknown>) => void,
  ): Promise<{ languages: string[]; buildCommand: string; lsanSupported: boolean; lsanNote: string; filesExamined: string[]; thinkingTrace?: string }> {
    const provider = this.config.get<string>('LLM_PROVIDER', 'anthropic');
    const systemPrompt = this.buildSystemPrompt();

    // ── Log full context ──
    this.logger.log(`=== Agent Loop Start ===`);
    this.logger.log(`Provider: ${provider}`);
    this.logger.log(`Max turns: ${MAX_TURNS}`);
    this.logger.log(`Repo path: ${repoPath}`);
    this.logger.log(`=== System Prompt (full) ===\n${systemPrompt}`);
    this.logger.log(`=== File Overview (first 1500 chars) ===\n${fileOverview.slice(0, 1500)}`);

    const messages: any[] = [{ role: 'user', content: fileOverview }];
    const openaiInput: any[] = [{ role: 'user', content: fileOverview }]; // Responses API

    const filesExamined: string[] = [];
    const thinkingChunks: string[] = [];
    let hasUsedTools = false;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      this.logger.log(`Agent turn ${turn + 1}/${MAX_TURNS}`);

      let response: any;
      try {
        response = await this.callLlm(systemPrompt, messages, provider, thinkingChunks, openaiInput);
      } catch (err: any) {
        this.logger.error(`LLM call failed on turn ${turn + 1}: ${err.message}`);
        if (filesExamined.length > 0) {
          return this.buildResult(['C', 'C++'], 'make CC=clang', false,
            `Analysis incomplete: ${err.message}`, filesExamined, thinkingChunks);
        }
        return this.fallbackAnalysis(fileOverview);
      }

      if (response.thinking) emit('thinking', 'Model is analyzing the project...');

      const toolCalls = this.extractToolCalls(response, provider);

      if (toolCalls.length === 0) {
        const text = response.text || '';
        this.logger.log(`Turn ${turn + 1}: no tool calls, text length=${text.length}`);

        if (!hasUsedTools) {
          this.logger.log('No tool calls on turn 1; parsing text as single-shot');
          const parsed = this.parseTextResponse(text);
          if (parsed) {
            return this.buildResult(
              parsed.languages, parsed.buildCommand, parsed.lsanSupported, parsed.lsanNote,
              filesExamined, thinkingChunks,
            );
          }
          return this.fallbackAnalysis(fileOverview, text);
        }

        if (turn < MAX_TURNS - 1) {
          messages.push({ role: 'assistant', content: text });
          messages.push({
            role: 'user',
            content: 'Please continue with your analysis. If you have enough information, call finalize_analysis().',
          });
          if (provider === 'openai') {
            openaiInput.push(...(response.responseOutput || []));
            openaiInput.push({ role: 'user', content: 'Please continue with your analysis. If you have enough information, call finalize_analysis().' });
          }
          continue;
        }
        break;
      }

      hasUsedTools = true;

      const contentParts: any[] = [];
      let foundFinalize = false;

      for (const tc of toolCalls) {
        if (tc.name === 'finalize_analysis') {
          foundFinalize = true;
          const args = tc.arguments as any;
          return this.buildResult(
            Array.isArray(args.languages) ? args.languages : ['C', 'C++'],
            typeof args.buildCommand === 'string' ? args.buildCommand : 'make CC=clang',
            typeof args.lsanSupported === 'boolean' ? args.lsanSupported : false,
            typeof args.lsanNote === 'string' ? args.lsanNote : '',
            filesExamined, thinkingChunks,
          );
        }

        if (tc.name === 'read_file') {
          const filePath = String(tc.arguments.path || '');
          emit('reading_file', `Reading ${filePath}...`, { file: filePath });
          const result = this.executeReadFile(filePath, repoPath);
          filesExamined.push(filePath);

          if (provider === 'anthropic') {
            contentParts.push({ type: 'tool_result', tool_use_id: tc.id || 'tool_' + turn, content: result });
          } else {
            contentParts.push({ role: 'tool', tool_call_id: tc.id || 'tool_' + turn, content: result });
          }
          emit('tool_call', `Analyzed ${filePath}`, { tool: 'read_file', file: filePath });
        }
      }

      // Append tool results to history
      if (provider === 'anthropic') {
        messages.push({
          role: 'assistant',
          content: toolCalls.map(tc => ({
            type: 'tool_use', id: tc.id || 'tool_' + turn, name: tc.name, input: tc.arguments,
          })),
        });
        messages.push({ role: 'user', content: contentParts });
      } else if (provider === 'openai') {
        if (response.responseOutput) openaiInput.push(...response.responseOutput);
        for (const cp of contentParts) {
          openaiInput.push({ type: 'function_call_output', call_id: cp.tool_call_id || 'tool_' + turn, output: cp.content });
        }
        messages.push({ role: 'assistant', content: response.text || '' });
      } else {
        // Local (OpenAI-compatible Chat)
        const assistantMsg: any = { role: 'assistant', content: null };
        assistantMsg.tool_calls = toolCalls.map(tc => ({
          id: tc.id || 'tool_' + turn, type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
        messages.push(assistantMsg);
        messages.push(...contentParts);
      }

      // After processing tool results, push model to finalize if it only read files
      if (!foundFinalize && filesExamined.length >= 2) {
        const pushMsg = turn >= MAX_TURNS - 2
          ? 'You MUST now call finalize_analysis() with your findings. You have read enough files.'
          : 'You have enough information now. Call finalize_analysis() to submit your structured analysis.';
        messages.push({ role: 'user', content: pushMsg });
        if (provider === 'openai') {
          openaiInput.push({ role: 'user', content: pushMsg });
        }
      }
    }

    this.logger.warn('Agent loop hit max turns, falling back');
    if (filesExamined.length > 0) {
      return this.buildResult(['C', 'C++'], 'make CC=clang', false,
        'Could not determine LSan support automatically. Agent did not call finalize_analysis().',
        filesExamined, thinkingChunks);
    }
    return this.fallbackAnalysis(fileOverview);
  }

  /**
   * Parse a free-text LLM response (no tool calls) into structured data.
   * Tries: JSON extraction → key-value heuristics
   */
  private parseTextResponse(text: string): { languages: string[]; buildCommand: string; lsanSupported: boolean; lsanNote: string } | null {
    if (!text) return null;

    // Try 1: Extract JSON object from text (model might output JSON in markdown)
    const jsonMatch = text.match(/\{[\s\S]*"languages"[\s\S]*"buildCommand"[\s\S]*\}/i);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.languages || parsed.buildCommand) {
          return {
            languages: Array.isArray(parsed.languages) ? parsed.languages : ['C', 'C++'],
            buildCommand: typeof parsed.buildCommand === 'string' ? parsed.buildCommand : 'make CC=clang',
            lsanSupported: typeof parsed.lsanSupported === 'boolean' ? parsed.lsanSupported : false,
            lsanNote: typeof parsed.lsanNote === 'string' ? parsed.lsanNote : '',
          };
        }
      } catch { /* not valid JSON */ }
    }

    // Try 2: Look for a JSON block in markdown ```json ... ```
    const mdJsonMatch = text.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\n?\s*```/);
    if (mdJsonMatch) {
      try {
        const parsed = JSON.parse(mdJsonMatch[1]);
        if (parsed.languages || parsed.buildCommand) {
          return {
            languages: Array.isArray(parsed.languages) ? parsed.languages : ['C', 'C++'],
            buildCommand: typeof parsed.buildCommand === 'string' ? parsed.buildCommand : 'make CC=clang',
            lsanSupported: typeof parsed.lsanSupported === 'boolean' ? parsed.lsanSupported : false,
            lsanNote: typeof parsed.lsanNote === 'string' ? parsed.lsanNote : '',
          };
        }
      } catch { /* not valid JSON */ }
    }

    // Try 3: Heuristic extraction from text
    const languages: string[] = [];
    const langKeywords = ['C++', 'C', 'Python', 'Java', 'Rust', 'Go', 'TypeScript', 'JavaScript', 'Ruby', 'PHP'];
    const textLower = text.toLowerCase();

    // Detect languages mentioned
    for (const lang of langKeywords) {
      if (textLower.includes(lang.toLowerCase())) {
        languages.push(lang);
      }
    }
    if (languages.length === 0) languages.push('C', 'C++');

    // Detect build command
    let buildCommand = 'make CC=clang';
    const cmakeMatch = text.match(/cmake[^]*?--build/);
    if (cmakeMatch) {
      // Try to extract the full cmake command
      const fullCmd = text.match(/(?:mkdir[^]*?cmake[^]*?(?:--build[^]*?)?\.)/i);
      if (fullCmd) buildCommand = fullCmd[0].trim();
      else buildCommand = 'mkdir -p build && cd build && cmake -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ .. && cmake --build .';
    } else if (textLower.includes('autotools') || textLower.includes('./configure')) {
      buildCommand = 'CC=clang CFLAGS="-fsanitize=leak -g -O0" ./configure && make';
    }

    // Detect LSan support
    const lsanSupported = !textLower.includes('not support') && !textLower.includes('incompatible')
      && !textLower.includes('doesn\'t support') && !textLower.includes('lsan is not');

    // Build a concise note
    const note = this.extractLsanNote(text);

    return { languages: [...new Set(languages)], buildCommand, lsanSupported, lsanNote: note };
  }

  private extractLsanNote(text: string): string {
    // Look for sentences mentioning LSan, leak sanitizer, or memory sanitizer
    const lines = text.split('\n');
    const relevantLines = lines.filter(l =>
      /leak|sanitizer|lsan|asan|memory|alloc/i.test(l) && l.trim().length > 10
    );
    if (relevantLines.length > 0) {
      return relevantLines.slice(0, 3).join(' ').trim().slice(0, 300);
    }
    // Fallback: first meaningful sentence
    const sentences = text.match(/[A-Z][^.]*\./g);
    if (sentences) {
      const relevant = sentences.filter(s => /build|language|detect|project|makefile|cmake/i.test(s));
      if (relevant.length > 0) return relevant.slice(0, 2).join(' ').slice(0, 300);
    }
    return 'Analysis completed via text response.';
  }

  private buildResult(
    languages: string[], buildCommand: string, lsanSupported: boolean,
    lsanNote: string, filesExamined: string[], thinkingChunks: string[],
  ) {
    return {
      languages,
      buildCommand,
      lsanSupported,
      lsanNote,
      filesExamined: [...new Set(filesExamined)],
      thinkingTrace: thinkingChunks.length > 0 ? thinkingChunks.join('\n\n') : undefined,
    };
  }

  // ── Prompt building ──

  private buildSystemPrompt(): string {
    return `You are a build system analyzer for a C/C++ memory leak detection tool. Your job is to analyze a repository and determine:
1. What programming languages are used
2. The correct build command for dynamic analysis (with -fsanitize flags)
3. Whether LeakSanitizer (LSan) is supported

You have access to these tools:
- **read_file(path)**: Read the contents of a file in the repository
- **finalize_analysis()**: Submit your final structured answer when you have enough information

## Strategy
1. First review the file listing provided in the user message
2. Read build configuration files (Makefile, CMakeLists.txt, configure, meson.build, etc.) to understand the build system
3. Read CI config files (.github/workflows, .gitlab-ci.yml, Jenkinsfile) if build config is unclear
4. Optionally check a few source files to confirm languages
5. Call **finalize_analysis()** with your findings

## Critical Rules
- Build command MUST use clang (not gcc/g++) for LSan compatibility
- Include -fsanitize=leak -g -O0 -fno-omit-frame-pointer flags
- If the project uses CMake: suggest "mkdir -p build && cd build && cmake -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_FLAGS=\"-fsanitize=leak -g\" -DCMAKE_CXX_FLAGS=\"-fsanitize=leak -g\" .. && cmake --build ."
- If the project uses Make: suggest "make CC=clang CFLAGS=\"-fsanitize=leak -g -O0\""
- If the project uses autotools: suggest "CC=clang CFLAGS=\"-fsanitize=leak -g -O0\" ./configure && make"
- Do NOT read binary files or files over 50KB
- Read at most 5-6 files, then finalize

## If you cannot use tools
If this environment does not support tool calling, output your analysis as a JSON object at the end of your response in this exact format:
\`\`\`json
{
  "languages": ["C", "C++"],
  "buildCommand": "make CC=clang CFLAGS=\"-fsanitize=leak -g -O0\"",
  "lsanSupported": true,
  "lsanNote": "Explanation here"
}
\`\`\``;
  }

  private buildFileOverview(root: string, files: FileEntry[]): string {
    // Count by extension
    const extCounts = new Map<string, number>();
    for (const f of files) {
      extCounts.set(f.ext, (extCounts.get(f.ext) || 0) + 1);
    }

    const extSummary = Array.from(extCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => `${ext}: ${count} files`)
      .join('\n');

    // Check for build system files
    const hasMakefile = files.some(f => f.path === 'Makefile' || f.path === 'makefile');
    const hasCMake = files.some(f => f.path === 'CMakeLists.txt');
    const hasMeson = files.some(f => f.path.includes('meson.build'));
    const hasConfigure = files.some(f => f.path === 'configure' || f.path === 'configure.ac');
    const hasCargo = files.some(f => f.path === 'Cargo.toml');

    let buildHints = '';
    if (hasMakefile) buildHints += '- Makefile detected (root level)\n';
    if (hasCMake) buildHints += '- CMakeLists.txt detected (root level)\n';
    if (hasMeson) buildHints += '- Meson build detected\n';
    if (hasConfigure) buildHints += '- Autotools configure script detected\n';
    if (hasCargo) buildHints += '- Cargo.toml detected (Rust project)\n';

    // Show first 80 file paths
    const sampleFiles = files.slice(0, 80).map(f => f.path).join('\n');

    // Find build-system-like files for quick reference
    const interestingFiles = files.filter(f =>
      /(makefile|cmakelists|configure|\.github|docker|\.gitlab|jenkinsfile|meson\.build|\.bazel|cargo\.toml)/i.test(f.path)
    ).slice(0, 5);

    let interestingSection = '';
    if (interestingFiles.length > 0) {
      interestingSection = `\n\n## Notable Build/CI Files (use read_file to inspect these)\n${interestingFiles.map(f => f.path).join('\n')}`;
    }

    return `Here is the repository structure I need you to analyze:

## File Extension Summary
${extSummary}

## Build System Indicators
${buildHints || '(none detected at top level)'}
${interestingSection}

## File Listing (first ${Math.min(80, files.length)} of ${files.length} files)
${sampleFiles}

Please analyze this project. Use read_file() to inspect build configuration files, then call finalize_analysis() with your findings.`;
  }

  // ── Tool execution ──

  private executeReadFile(relativePath: string, repoRoot: string): string {
    // Security: prevent directory traversal
    const normalizedPath = join(repoRoot, relativePath);
    if (!normalizedPath.startsWith(repoRoot)) {
      return 'Error: path traversal denied. Use relative paths within the repository.';
    }

    if (!existsSync(normalizedPath)) {
      return `Error: file not found at "${relativePath}". Try listing available files from the file listing.`;
    }

    const stat = statSync(normalizedPath);
    if (stat.isDirectory()) {
      return `Error: "${relativePath}" is a directory. Use a file path instead.`;
    }

    if (stat.size > MAX_FILE_SIZE) {
      return `Error: file too large (${stat.size} bytes, max ${MAX_FILE_SIZE}). Try a smaller configuration file.`;
    }

    const content = readFileSync(normalizedPath, 'utf-8').slice(0, MAX_FILE_CHARS);
    return content;
  }

  // ── LLM calls ──

  private async callLlm(
    systemPrompt: string,
    messages: any[],
    provider: string,
    thinkingChunks: string[],
    openaiInput?: any[],
  ): Promise<{ text?: string; thinking?: string; toolCalls?: ToolCall[]; responseOutput?: any[] }> {
    if (provider === 'local') {
      return this.callLocal(systemPrompt, messages);
    } else if (provider === 'openai') {
      return this.callOpenAI(systemPrompt, openaiInput || messages);
    }
    return this.callAnthropic(systemPrompt, messages, thinkingChunks);
  }

  private async callAnthropic(
    system: string,
    messages: any[],
    thinkingChunks: string[],
  ): Promise<{ text?: string; thinking?: string }> {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

    const baseUrl = this.config.get<string>('ANTHROPIC_BASE_URL', 'https://api.anthropic.com');
    const thinkingBudget = this.config.get<number>('ANTHROPIC_THINKING_BUDGET', 0);

    // ── Log request ──
    this.logger.log(`=== Anthropic Request ===`);
    this.logger.log(`Model: ${this.config.get<string>('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514')}`);
    this.logger.log(`Thinking budget: ${thinkingBudget}`);
    this.logger.log(`System prompt (first 500): ${system.slice(0, 500)}...`);
    this.logger.log(`Messages (${messages.length}): ${JSON.stringify(messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 200) : `${m.content.length} blocks` })))}`);
    this.logger.log(`Tools: ${this.tools.map(t => t.name).join(', ')}`);

    const body: any = {
      model: this.config.get<string>('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514'),
      max_tokens: 4096,
      temperature: Number(this.config.get('LLM_TEMPERATURE', '0')) || 0,
      system,
      messages: messages.map(m => {
        if (m.role === 'system') return { role: 'user', content: m.content };
        return { role: m.role, content: m.content };
      }),
      tools: this.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
    };

    if (thinkingBudget > 0) {
      body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
    }

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      this.logger.error(`Anthropic API error (${response.status}): ${errBody}`);
      throw new Error(`Anthropic API error (${response.status}): ${errBody}`);
    }

    const data = await response.json();

    // ── Log response ──
    this.logger.log(`=== Anthropic Response ===`);
    this.logger.log(`Stop reason: ${data.stop_reason}`);
    const blockTypes = (data.content || []).map((b: any) => b.type).join(', ');
    this.logger.log(`Content blocks: ${blockTypes}`);
    for (const block of data.content || []) {
      if (block.type === 'text') this.logger.log(`Text (first 300): ${block.text.slice(0, 300)}`);
      if (block.type === 'tool_use') this.logger.log(`Tool call: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
    }

    const result: any = {};

    // Extract thinking if present
    for (const block of data.content || []) {
      if (block.type === 'thinking') {
        result.thinking = block.thinking;
        thinkingChunks.push(block.thinking);
      }
    }

    // Extract text content
    const textBlock = (data.content || []).find((b: any) => b.type === 'text');
    if (textBlock) result.text = textBlock.text;

    // Extract tool_use blocks
    const toolUseBlocks = (data.content || []).filter((b: any) => b.type === 'tool_use');
    if (toolUseBlocks.length > 0) {
      result.toolCalls = toolUseBlocks.map((b: any) => ({
        name: b.name,
        arguments: b.input,
        id: b.id,
      }));
    }

    return result;
  }

  private async callOpenAI(
    instructions: string,
    input: any[],
  ): Promise<{ text?: string; toolCalls?: ToolCall[]; responseOutput?: any[] }> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

    const baseUrl = this.config.get<string>('OPENAI_BASE_URL', 'https://api.openai.com');
    const model = this.config.get<string>('OPENAI_MODEL', 'gpt-4o');

    // ── Log request ──
    this.logger.log(`=== OpenAI Request ===`);
    this.logger.log(`Endpoint: ${baseUrl}/v1/responses`);
    this.logger.log(`Model: ${model}`);
    this.logger.log(`Instructions (first 500): ${instructions.slice(0, 500)}...`);
    this.logger.log(`Input items (${input.length}): ${JSON.stringify(input.map((i: any) => {
      if (i.type === 'function_call_output') return { type: 'function_call_output', call_id: i.call_id, output: i.output.slice(0, 100) };
      return { role: i.role, content: typeof i.content === 'string' ? i.content.slice(0, 200) : '(non-string)' };
    }))}`);

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_output_tokens: 4096,
        temperature: Number(this.config.get('LLM_TEMPERATURE', '0')) || 0,
        instructions,
        input,
        tools: this.tools.map(t => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      this.logger.error(`OpenAI Responses API error (${response.status}): ${errBody}`);
      throw new Error(`OpenAI Responses API error (${response.status}): ${errBody}`);
    }

    const data = await response.json().catch(async () => {
      const text = await response.text().catch(() => '');
      this.logger.warn(`Raw OpenAI response (first 500): ${text.slice(0, 500)}`);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      throw new Error(`OpenAI returned non-JSON response: ${text.slice(0, 200)}`);
    });

    // ── Log response ──
    this.logger.log(`=== OpenAI Response ===`);
    if (data.output_text) this.logger.log(`Output text (first 300): ${data.output_text.slice(0, 300)}`);
    for (const item of data.output || []) {
      if (item.type === 'function_call') {
        this.logger.log(`Function call: ${item.name}(${item.arguments?.slice(0, 200) || '...'})`);
      }
      if (item.type === 'message') {
        for (const c of item.content || []) {
          if (c.type === 'output_text') this.logger.log(`Message text (first 300): ${c.text?.slice(0, 300)}`);
        }
      }
    }

    const result: any = {};

    // output_text is concatenated text from all message output items
    if (data.output_text) result.text = data.output_text;

    // Save raw output items so the agent loop can feed them back as input
    result.responseOutput = data.output || [];

    // Extract function calls from output
    const functionCalls = (data.output || []).filter((item: any) => item.type === 'function_call');
    if (functionCalls.length > 0) {
      result.toolCalls = functionCalls.map((fc: any) => ({
        name: fc.name,
        arguments: JSON.parse(fc.arguments),
        id: fc.call_id,
      }));
    }

    return result;
  }

  private async callLocal(
    system: string,
    messages: any[],
  ): Promise<{ text?: string; toolCalls?: ToolCall[] }> {
    const baseUrl = this.config.get<string>('LOCAL_LLM_BASE_URL', 'http://localhost:20128/v1');
    const model = this.config.get<string>('LOCAL_LLM_MODEL', 'local-model');

    const localMessages = [
      { role: 'system', content: system },
      ...messages,
    ];

    // ── Log request ──
    this.logger.log(`=== Local LLM Request ===`);
    this.logger.log(`Endpoint: ${baseUrl}/chat/completions`);
    this.logger.log(`Model: ${model}`);
    this.logger.log(`System prompt (first 500): ${system.slice(0, 500)}...`);
    this.logger.log(`Messages (${messages.length}): ${JSON.stringify(messages.map((m: any) => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 200) : `${m.content?.length || 0} items` })))}`);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: Number(this.config.get('LLM_TEMPERATURE', '0')) || 0,
        messages: localMessages,
        tools: this.tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        })),
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      this.logger.error(`Local LLM error (${response.status}): ${errBody}`);
      throw new Error(`Local LLM error (${response.status}): ${errBody}`);
    }

    let rawBody = await response.text();

    // ── Log raw response body ──
    this.logger.log(`=== Local LLM Raw Response (first 1000 chars) ===`);
    this.logger.log(rawBody.slice(0, 1000));

    // Strip trailing SSE data after the JSON object (e.g. "\ndata: [DONE]\n")
    const jsonEnd = rawBody.lastIndexOf('}');
    if (jsonEnd > 0 && jsonEnd < rawBody.length - 1) {
      const trailer = rawBody.slice(jsonEnd + 1).trim();
      if (trailer.startsWith('data:') || trailer.startsWith(':')) {
        this.logger.log(`Stripped SSE trailer: "${trailer.slice(0, 100)}"`);
        rawBody = rawBody.slice(0, jsonEnd + 1);
      }
    }

    let data: any;
    try {
      data = JSON.parse(rawBody);
    } catch (e: any) {
      this.logger.error(`Invalid JSON from local LLM: ${e.message}`);
      this.logger.error(`Raw body (after strip): ${rawBody.slice(0, 1500)}`);
      // Try to extract JSON object from response (some servers append extra content)
      const jsonMatch = rawBody.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          data = JSON.parse(jsonMatch[0]);
          this.logger.log(`Recovered JSON via regex extraction from raw body`);
        } catch {
          throw new Error(`Local LLM returned invalid JSON: ${rawBody.slice(0, 200)}`);
        }
      } else {
        throw new Error(`Local LLM returned non-JSON response: ${rawBody.slice(0, 200)}`);
      }
    }

    const choice = data.choices?.[0]?.message;
    if (!choice) throw new Error('Empty local LLM response');

    // ── Log response ──
    this.logger.log(`=== Local LLM Response ===`);
    this.logger.log(`Finish reason: ${data.choices?.[0]?.finish_reason}`);
    this.logger.log(`Content (first 500): ${(choice.content || '').slice(0, 500)}`);
    if (choice.tool_calls) {
      for (const tc of choice.tool_calls) {
        this.logger.log(`Raw tool call: ${tc.function.name} | raw arguments: "${(tc.function.arguments || '')}"`);
      }
    }

    const result: any = {};
    if (choice.content) result.text = choice.content;

    // Check if model supports tool calls
    if (choice.tool_calls) {
      result.toolCalls = choice.tool_calls.map((tc: any) => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments);
        } catch (e: any) {
          this.logger.warn(`Failed to parse tool call arguments for "${tc.function.name}": ${e.message}`);
          this.logger.warn(`Raw arguments string: "${tc.function.arguments}"`);
          // Try to extract JSON object from the string
          const jsonMatch = String(tc.function.arguments).match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              parsedArgs = JSON.parse(jsonMatch[0]);
              this.logger.log(`Recovered arguments via regex extraction`);
            } catch { /* give up */ }
          }
        }
        return {
          name: tc.function.name,
          arguments: parsedArgs,
          id: tc.id,
        };
      });
    }

    return result;
  }

  // ── Response parsing ──

  private extractToolCalls(response: any, provider: string): ToolCall[] {
    if (response.toolCalls && Array.isArray(response.toolCalls)) {
      return response.toolCalls;
    }
    return [];
  }

  private fallbackAnalysis(fileOverview: string, modelText?: string): { languages: string[]; buildCommand: string; lsanSupported: boolean; lsanNote: string; filesExamined: string[] } {
    // If we have model text, try to extract something useful
    if (modelText) {
      const parsed = this.parseTextResponse(modelText);
      if (parsed) {
        return {
          ...parsed,
          filesExamined: [],
        };
      }
    }

    // Simple heuristic fallback if the agent loop fails
    return {
      languages: ['C', 'C++'],
      buildCommand: 'make CC=clang',
      lsanSupported: false,
      lsanNote: 'Could not determine LSan support automatically. Agent analysis failed.',
      filesExamined: [],
    };
  }

  // ── Directory walking (unchanged) ──

  private walkDirectory(root: string, dir: string): FileEntry[] {
    const results: FileEntry[] = [];
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            if (!SKIP_DIRS.has(entry)) {
              results.push(...this.walkDirectory(root, fullPath));
            }
          } else if (stat.isFile()) {
            const ext = entry.includes('.') ? '.' + entry.split('.').pop()!.toLowerCase() : '';
            if (TEXT_EXTS.has(ext)) {
              const relPath = relative(root, fullPath);
              results.push({ path: relPath, ext });
            }
          }
        } catch { /* skip unreadable entries */ }
      }
    } catch { /* skip unreadable dirs */ }

    if (results.length > 5000) return results.slice(0, 5000);
    return results;
  }
}
