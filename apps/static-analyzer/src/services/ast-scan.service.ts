import { Injectable } from '@nestjs/common';
import { CParserService } from './c-parser.service';

@Injectable()
export class AstScanService {
  constructor(private readonly cParser: CParserService) {}

  parse(filePath: string, content: string) {
    const result = this.cParser.parse(content, filePath);
    const first = result.functions[0];

    return {
      nodes: first
        ? {
            file_path: filePath,
            function_name: first.functionName,
            parameters: first.parameters,
            local_variables: first.localVariables,
            function_calls: first.functionCalls,
            allocation_calls: first.allocationCalls,
            deallocation_calls: first.deallocationCalls,
          }
        : {},
    };
  }
}
