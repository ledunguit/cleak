import { Injectable } from '@nestjs/common';

const ALLOCATION_FUNCTIONS = new Set([
  'malloc', 'calloc', 'realloc', 'strdup', 'strndup',
  'xmalloc', 'xcalloc', 'xrealloc', 'xstrdup',
]);

const DEALLOCATION_FUNCTIONS = new Set(['free', 'xfree']);

export interface FunctionInfo {
  functionName: string;
  parameters: { name: string; type: string }[];
  localVariables: { name: string; type: string }[];
  functionCalls: { name: string; line: number }[];
  allocationCalls: { name: string; line: number }[];
  deallocationCalls: { name: string; line: number }[];
  returnStatements: { line: number; text: string }[];
  conditions: { line: number; text: string }[];
  allocationVariables: { variable: string; line: number; callName: string }[];
  freedVariables: { variable: string; line: number }[];
  assignedCalls: { variable: string; line: number; callName: string }[];
  lineNumber: number;
}

export interface ParseResult {
  functions: FunctionInfo[];
  functionNames: string[];
}

@Injectable()
export class CParserService {
  parse(content: string, _filePath?: string): ParseResult {
    // Dynamically import tree-sitter (native module)
    return this.parseWithTreeSitter(content);
  }

  private parseWithTreeSitter(content: string): ParseResult {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Parser = require('tree-sitter');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const C = require('tree-sitter-c');
      const parser = new Parser();
      parser.setLanguage(C);
      const tree = parser.parse(content);
      const root = tree.rootNode;
      const lines = content.split('\n');

      const funcNodes = this.findAllNodes(root, 'function_definition');
      const functions: FunctionInfo[] = [];

      for (const funcNode of funcNodes) {
        const info = this.buildFunctionInfo(funcNode, lines);
        if (info) functions.push(info);
      }

      const functionNames = functions.map((f) => f.functionName);

      return { functions, functionNames };
    } catch {
      return { functions: [], functionNames: [] };
    }
  }

  private findAllNodes(
    node: { children: any[]; type: string },
    targetType: string,
  ): any[] {
    const found: any[] = [];
    if (node.type === targetType) {
      found.push(node);
    }
    for (const child of node.children || []) {
      found.push(...this.findAllNodes(child, targetType));
    }
    return found;
  }

  private findChild(
    node: any,
    targetType: string,
  ): any | undefined {
    return (node.children || []).find((c: any) => c.type === targetType);
  }

  private findChildren(
    node: any,
    targetType: string,
  ): any[] {
    return (node.children || []).filter((c: any) => c.type === targetType);
  }

  private childByField(node: any, fieldName: string): any | undefined {
    return node.children?.[node.childIndexFor?.(fieldName) ?? -1];
  }

  private nodeText(node: any, lines: string[]): string {
    if (!node || node.startIndex == null) return '';
    // Build text from startPosition/endPosition
    let text = '';
    if (node.startPosition?.row === node.endPosition?.row) {
      text = lines[node.startPosition.row]?.substring(
        node.startPosition.column,
        node.endPosition.column,
      ) || '';
    } else {
      // Multi-line: naive approach
      text = lines[node.startPosition.row]?.substring(node.startPosition.column) || '';
      for (let r = node.startPosition.row + 1; r <= node.endPosition.row; r++) {
        if (r < lines.length) {
          text += '\n' + (r === node.endPosition.row
            ? lines[r].substring(0, node.endPosition.column)
            : lines[r]);
        }
      }
    }
    return text.trim();
  }

  private extractFunctionName(node: any, lines: string[]): string {
    const declarator = this.findChild(node, 'function_declarator') ||
                        this.findChild(node, 'pointer_declarator');
    if (!declarator) return 'unknown';

    // Try direct identifier
    const id = this.findChild(declarator, 'identifier');
    if (id) return this.nodeText(id, lines);

    // Try pointer_declarator -> identifier
    const ptrDecl = this.findChild(declarator, 'pointer_declarator');
    if (ptrDecl) {
      const ptrId = this.findChild(ptrDecl, 'identifier');
      if (ptrId) return this.nodeText(ptrId, lines);
    }

    // Fallback: first identifier in declarator
    const allIds = this.findAllNodes(declarator, 'identifier');
    if (allIds.length > 0) return this.nodeText(allIds[0], lines);

    return 'unknown';
  }

  private extractParameters(
    node: any,
    lines: string[],
  ): { name: string; type: string }[] {
    // Find function_declarator -> parameter_list
    const declarator = this.findChild(node, 'function_declarator') ||
                        this.findChild(node, 'pointer_declarator');
    if (!declarator) return [];

    const paramList = this.findChild(declarator, 'parameter_list');
    if (!paramList) return [];

    const params: { name: string; type: string }[] = [];
    const decls = this.findChildren(paramList, 'parameter_declaration');

    for (const decl of decls) {
      const id = this.findChild(decl, 'identifier');
      const typeParts = [
        ...this.findChildren(decl, 'primitive_type'),
        ...this.findChildren(decl, 'type_identifier'),
        ...this.findChildren(decl, 'sized_type_specifier'),
      ];
      const hasPtr = this.findChild(decl, 'pointer_declarator');
      let typeStr = typeParts.map((t) => this.nodeText(t, lines)).join(' ');
      if (hasPtr) typeStr += ' *';
      params.push({
        name: id ? this.nodeText(id, lines) : '',
        type: typeStr || 'unknown',
      });
    }

    return params;
  }

  private extractLocalVariables(
    node: any,
    lines: string[],
  ): { name: string; type: string }[] {
    const body = this.findChild(node, 'compound_statement');
    if (!body) return [];

    const vars: { name: string; type: string }[] = [];
    const decls = this.findAllNodes(body, 'declaration');

    for (const decl of decls) {
      const typeParts = [
        ...this.findChildren(decl, 'primitive_type'),
        ...this.findChildren(decl, 'type_identifier'),
        ...this.findChildren(decl, 'sized_type_specifier'),
      ];
      const baseType = typeParts.map((t) => this.nodeText(t, lines)).join(' ');

      // Get variable names from init_declarator or direct identifier/pointer_declarator
      const initDecls = this.findChildren(decl, 'init_declarator');
      if (initDecls.length > 0) {
        for (const initDecl of initDecls) {
          const name = this.extractDeclaratorName(initDecl, lines);
          if (name) {
            const hasPtr = this.findChild(initDecl, 'pointer_declarator');
            vars.push({ name, type: hasPtr ? `${baseType} *` : baseType });
          }
        }
      } else {
        // Direct declarator (e.g., `int x;` without init)
        const id = this.findChild(decl, 'identifier');
        const ptr = this.findChild(decl, 'pointer_declarator');
        if (id) {
          vars.push({
            name: this.nodeText(id, lines),
            type: ptr ? `${baseType} *` : baseType,
          });
        }
      }
    }

    return vars;
  }

  private extractDeclaratorName(node: any, lines: string[]): string {
    const id = this.findChild(node, 'identifier');
    if (id) return this.nodeText(id, lines);
    // Check pointer_declarator -> identifier
    const ptr = this.findChild(node, 'pointer_declarator');
    if (ptr) {
      const ptrId = this.findChild(ptr, 'identifier');
      if (ptrId) return this.nodeText(ptrId, lines);
    }
    return '';
  }

  private extractFunctionCalls(
    node: any,
    lines: string[],
  ): { name: string; line: number }[] {
    const calls: { name: string; line: number }[] = [];
    const callExprs = this.findAllNodes(node, 'call_expression');

    for (const expr of callExprs) {
      // The function field is typically the first child or "function" field
      const fnNode = this.getCallFunctionNameNode(expr);
      const name = fnNode ? this.nodeText(fnNode, lines) : '<anonymous>';
      const line = (fnNode?.startPosition?.row ?? expr.startPosition?.row ?? 0) + 1;
      calls.push({ name, line });
    }

    return calls;
  }

  private getCallFunctionNameNode(node: any): any | undefined {
    // Try childByFieldName("function") which nest-cli may not expose
    // Fallback: first child is often the function name
    return node.children?.[0];
  }

  private extractAllocationCalls(
    node: any,
    lines: string[],
  ): { name: string; line: number }[] {
    return this.extractFunctionCalls(node, lines).filter(
      (c) => ALLOCATION_FUNCTIONS.has(c.name),
    );
  }

  private extractDeallocationCalls(
    node: any,
    lines: string[],
  ): { name: string; line: number }[] {
    return this.extractFunctionCalls(node, lines).filter(
      (c) => DEALLOCATION_FUNCTIONS.has(c.name),
    );
  }

  private isAllocationCall(node: any, lines: string[]): boolean {
    const callExprs = this.findAllNodes(node, 'call_expression');
    for (const expr of callExprs) {
      const fnNode = this.getCallFunctionNameNode(expr);
      if (fnNode) {
        const name = this.nodeText(fnNode, lines);
        if (ALLOCATION_FUNCTIONS.has(name)) return true;
      }
    }
    return false;
  }

  private extractCallName(node: any, lines: string[]): string {
    const callExprs = this.findAllNodes(node, 'call_expression');
    for (const expr of callExprs) {
      const fnNode = this.getCallFunctionNameNode(expr);
      if (fnNode) {
        const name = this.nodeText(fnNode, lines);
        if (ALLOCATION_FUNCTIONS.has(name)) return name;
      }
    }
    return '';
  }

  private extractAllocationVariables(
    node: any,
    lines: string[],
  ): { variable: string; line: number; callName: string }[] {
    const result: { variable: string; line: number; callName: string }[] = [];
    const body = this.findChild(node, 'compound_statement');
    if (!body) return result;

    // Pass 1: init_declarator (e.g., int *p = malloc(4))
    const initDecls = this.findAllNodes(body, 'init_declarator');
    for (const decl of initDecls) {
      const value = this.childByField(decl, 'value') ||
                    (decl.children || []).find((c: any) => c.type === 'call_expression' || this.findAllNodes(c, 'call_expression').length > 0);
      if (value && (this.isAllocationCall(decl, lines) || this.findAllNodes(decl, 'call_expression').length > 0)) {
        const varName = this.extractDeclaratorName(decl, lines);
        if (varName) {
          const id = this.findChild(decl, 'identifier');
          result.push({
            variable: varName,
            line: (id?.startPosition?.row ?? 0) + 1,
            callName: this.extractCallName(decl, lines),
          });
        }
      }
    }

    // Pass 2: assignment_expression (e.g., p = malloc(4))
    const assignExprs = this.findAllNodes(body, 'assignment_expression');
    for (const expr of assignExprs) {
      const right = this.childByField(expr, 'right') ||
                    (expr.children || [])[expr.children.length - 1];
      if (right && this.isAllocationCall(right, lines)) {
        const left = this.childByField(expr, 'left') || expr.children?.[0];
        const varName = left ? this.nodeText(left, lines) : '';
        if (varName) {
          result.push({
            variable: varName,
            line: (left?.startPosition?.row ?? 0) + 1,
            callName: this.extractCallName(right, lines),
          });
        }
      }
    }

    return result;
  }

  private extractFreedVariables(
    node: any,
    lines: string[],
  ): { variable: string; line: number }[] {
    const result: { variable: string; line: number }[] = [];
    const deallocCalls = this.extractDeallocationCalls(node, lines);

    for (const call of deallocCalls) {
      // Find the call_expression node and extract first argument
      const callExprs = this.findAllNodes(node, 'call_expression');
      for (const expr of callExprs) {
        const fnNode = this.getCallFunctionNameNode(expr);
        if (fnNode && this.nodeText(fnNode, lines) === call.name) {
          const args = expr.children?.find(
            (c: any) => c.type === 'argument_list',
          );
          if (args && args.children?.[0]) {
            const varName = this.nodeText(args.children[0], lines);
            result.push({
              variable: varName,
              line: call.line,
            });
          }
        }
      }
    }

    return result;
  }

  private extractReturnStatements(
    node: any,
    lines: string[],
  ): { line: number; text: string }[] {
    const body = this.findChild(node, 'compound_statement');
    if (!body) return [];

    return this.findAllNodes(body, 'return_statement').map((ret) => ({
      line: (ret.startPosition?.row ?? 0) + 1,
      text: this.nodeText(ret, lines),
    }));
  }

  private extractConditions(node: any, lines: string[]): { line: number; text: string }[] {
    const body = this.findChild(node, 'compound_statement');
    if (!body) return [];

    return this.findAllNodes(body, 'if_statement').map((ifStmt) => ({
      line: (ifStmt.startPosition?.row ?? 0) + 1,
      text: this.nodeText(ifStmt, lines),
    }));
  }

  private extractFreedVariableNames(
    freedVariables: { variable: string; line: number }[],
  ): Set<string> {
    return new Set(freedVariables.map((f) => f.variable));
  }

  private extractAssignedCalls(
    node: any,
    lines: string[],
  ): { variable: string; line: number; callName: string }[] {
    const result: { variable: string; line: number; callName: string }[] = [];
    const body = this.findChild(node, 'compound_statement');
    if (!body) return result;

    // Pass 1: init_declarator with call expression values
    const initDecls = this.findAllNodes(body, 'init_declarator');
    for (const decl of initDecls) {
      const callExprs = this.findAllNodes(decl, 'call_expression');
      if (callExprs.length > 0) {
        const varName = this.extractDeclaratorName(decl, lines);
        if (varName && !this.isAllocationCall(decl, lines)) {
          const fnNode = this.getCallFunctionNameNode(callExprs[0]);
          const callName = fnNode ? this.nodeText(fnNode, lines) : '';
          result.push({
            variable: varName,
            line: (decl.startPosition?.row ?? 0) + 1,
            callName,
          });
        }
      }
    }

    // Pass 2: assignment_expression with call expression on right
    const assignExprs = this.findAllNodes(body, 'assignment_expression');
    for (const expr of assignExprs) {
      const right = this.childByField(expr, 'right') ||
                    (expr.children || [])[expr.children.length - 1];
      if (right) {
        const callExprs = this.findAllNodes(right, 'call_expression');
        if (callExprs.length > 0 && !this.isAllocationCall(right, lines)) {
          const left = expr.children?.[0];
          const varName = left ? this.nodeText(left, lines) : '';
          if (varName) {
            const fnNode = this.getCallFunctionNameNode(callExprs[0]);
            const callName = fnNode ? this.nodeText(fnNode, lines) : '';
            result.push({ variable: varName, line: (left?.startPosition?.row ?? 0) + 1, callName });
          }
        }
      }
    }

    return result;
  }

  private buildFunctionInfo(
    funcNode: any,
    lines: string[],
  ): FunctionInfo | null {
    try {
      const body = this.findChild(funcNode, 'compound_statement');
      if (!body) return null;

      const functionName = this.extractFunctionName(funcNode, lines);
      const parameters = this.extractParameters(funcNode, lines);
      const localVariables = this.extractLocalVariables(funcNode, lines);
      const functionCalls = this.extractFunctionCalls(body, lines);
      const allocationCalls = functionCalls.filter((c) =>
        ALLOCATION_FUNCTIONS.has(c.name),
      );
      const deallocationCalls = functionCalls.filter((c) =>
        DEALLOCATION_FUNCTIONS.has(c.name),
      );
      const returnStatements = this.extractReturnStatements(funcNode, lines);
      const conditions = this.extractConditions(funcNode, lines);
      const allocationVariables = this.extractAllocationVariables(funcNode, lines);
      const freedVariables = this.extractFreedVariables(funcNode, lines);
      const assignedCalls = this.extractAssignedCalls(funcNode, lines);

      return {
        functionName,
        parameters,
        localVariables,
        functionCalls,
        allocationCalls,
        deallocationCalls,
        returnStatements,
        conditions,
        allocationVariables,
        freedVariables,
        assignedCalls,
        lineNumber: (funcNode.startPosition?.row ?? 0) + 1,
      };
    } catch {
      return null;
    }
  }
}
