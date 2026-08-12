import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CParserService } from '../../src/services/c-parser.service';
import { CallGraphService } from '../../src/services/call-graph.service';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleak-callgraph-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('CallGraphService — ownership correlation (Juliet flow-variant ≥21 shapes)', () => {
  test('freedCrossFile: caller allocation freed via a callee defined in a DIFFERENT file', async () => {
    const a = write(
      'case_22a.c',
      `
#include <stdlib.h>
void goodB2G1Sink(char *data);
void badSink(char *data);

void goodB2G1(void) {
    char *data = malloc(64);
    goodB2G1Sink(data);
}

void bad(void) {
    char *data = malloc(64);
    badSink(data);
}
`,
    );
    const b = write(
      'case_22b.c',
      `
#include <stdlib.h>
void goodB2G1Sink(char *data) {
    free(data);
}
void badSink(char *data) {
    ;
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a, b]);

    expect(result.ownershipCorrelations.freedCrossFile).toEqual([
      expect.objectContaining({
        callerFunction: 'goodB2G1',
        callerVariable: 'data',
        calleeFunction: 'goodB2G1Sink',
        calleeFile: b,
        calleeParam: 'data',
      }),
    ]);
  });

  test('unfreedSinkParams: caller allocation passed to a callee that never frees it on any path', async () => {
    const a = write(
      'case_41.c',
      `
#include <stdlib.h>
void badSink(char *data) {
    ;
}
void bad(void) {
    char *data = malloc(64);
    badSink(data);
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a]);

    expect(result.ownershipCorrelations.unfreedSinkParams).toEqual([
      expect.objectContaining({
        calleeFunction: 'badSink',
        calleeFile: a,
        calleeParam: 'data',
        callerFunction: 'bad',
        callerVariable: 'data',
      }),
    ]);
  });

  test('unfreedSinkParams dedupes to one entry per (file, function, param) across multiple callers', async () => {
    const a = write(
      'multi_caller.c',
      `
#include <stdlib.h>
void sink(char *data) {
    ;
}
void bad1(void) {
    char *data = malloc(64);
    sink(data);
}
void bad2(void) {
    char *other = malloc(64);
    sink(other);
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a]);

    expect(result.ownershipCorrelations.unfreedSinkParams).toHaveLength(1);
  });

  test('a borrow-only function (parameter not backed by a caller heap allocation) produces no correlation at all', async () => {
    // Precision guard: a function that receives a pointer and does nothing with it
    // is the overwhelmingly common case in real code (getters, print helpers). It
    // must NOT become a leak candidate just because the parameter is never freed —
    // only a call site that demonstrably passes a REAL heap allocation counts.
    const a = write(
      'borrow_only.c',
      `
void printer(char *msg) {
    ;
}
void caller(char *stackBuf) {
    printer(stackBuf);
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a]);

    expect(result.ownershipCorrelations.freedCrossFile).toEqual([]);
    expect(result.ownershipCorrelations.unfreedSinkParams).toEqual([]);
  });

  test('a heap allocation passed to a non-pointer/non-existent parameter position is ignored', async () => {
    const a = write(
      'no_match.c',
      `
#include <stdlib.h>
void takesInt(int n) {
    ;
}
void caller(void) {
    char *data = malloc(64);
    takesInt(1);
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a]);

    expect(result.ownershipCorrelations.freedCrossFile).toEqual([]);
    expect(result.ownershipCorrelations.unfreedSinkParams).toEqual([]);
  });
});

describe('CallGraphService — return-value ownership (Juliet flow-variant 42-45/61-68 shapes)', () => {
  test('freedViaCaller: same-file dispatcher that frees the returned allocation exonerates the Source', async () => {
    const a = write(
      'case_42.c',
      `
#include <stdlib.h>
static char * badSource(void) {
    char *data = malloc(100);
    return data;
}
void bad(void) {
    char *data;
    data = badSource();
    ;
}
static char * goodB2GSource(void) {
    char *data = malloc(100);
    return data;
}
static void goodB2G(void) {
    char *data;
    data = goodB2GSource();
    free(data);
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a]);

    expect(result.ownershipCorrelations.freedViaCaller).toEqual([
      expect.objectContaining({ calleeFunction: 'goodB2GSource', callerFunction: 'goodB2G', variable: 'data' }),
    ]);
    expect(result.ownershipCorrelations.unfreedReturnOwnership).toEqual([
      expect.objectContaining({ callerFunction: 'bad', calleeFunction: 'badSource', callerVariable: 'data' }),
    ]);
  });

  test('cross-file: dispatcher and Source in different files still correlate', async () => {
    const a = write(
      'case_61a.c',
      `
char * badSource(void);
char * goodB2GSource(void);
void bad(void) {
    char *data;
    data = badSource();
    ;
}
void goodB2G(void) {
    char *data;
    data = goodB2GSource();
    free(data);
}
`,
    );
    const b = write(
      'case_61b.c',
      `
#include <stdlib.h>
char * badSource(void) {
    char *data = malloc(100);
    return data;
}
char * goodB2GSource(void) {
    char *data = malloc(100);
    return data;
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a, b]);

    expect(result.ownershipCorrelations.freedViaCaller).toEqual([
      expect.objectContaining({ calleeFunction: 'goodB2GSource', calleeFile: b, callerFunction: 'goodB2G' }),
    ]);
    expect(result.ownershipCorrelations.unfreedReturnOwnership).toEqual([
      expect.objectContaining({ callerFunction: 'bad', calleeFunction: 'badSource', calleeFile: b }),
    ]);
  });

  test('a function that returns a value it did NOT allocate is not a return-ownership carrier', async () => {
    const a = write(
      'passthrough_return.c',
      `
char * identity(char *p) {
    return p;
}
void caller(char *stackBuf) {
    char *x;
    x = identity(stackBuf);
    ;
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a]);

    expect(result.ownershipCorrelations.freedViaCaller).toEqual([]);
    expect(result.ownershipCorrelations.unfreedReturnOwnership).toEqual([]);
  });
});

describe('CallGraphService — multi-hop parameter chains (Juliet flow-variant 51-54 shapes)', () => {
  test('a 2-hop pass-through: the TERMINAL sink gets the candidate, not the pass-through hop', async () => {
    const a = write(
      'case_52a.c',
      `
#include <stdlib.h>
void badSinkB(char *data);
void bad(void) {
    char *data = malloc(100);
    badSinkB(data);
}
`,
    );
    const b = write(
      'case_52b.c',
      `
void badSinkC(char *data);
void badSinkB(char *data) {
    badSinkC(data);
}
`,
    );
    const c = write(
      'case_52c.c',
      `
void badSinkC(char *data) {
    ;
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a, b, c]);

    expect(result.ownershipCorrelations.unfreedSinkParams).toEqual([
      expect.objectContaining({ calleeFunction: 'badSinkC', calleeFile: c, callerFunction: 'bad' }),
    ]);
  });

  test('a 2-hop pass-through where the terminal hop frees: exonerates via freedCrossFile, not a false sink at the pass-through', async () => {
    const a = write(
      'case_goodhop_a.c',
      `
#include <stdlib.h>
void goodSinkB(char *data);
void good(void) {
    char *data = malloc(100);
    goodSinkB(data);
}
`,
    );
    const b = write(
      'case_goodhop_b.c',
      `
void goodSinkC(char *data);
void goodSinkB(char *data) {
    goodSinkC(data);
}
`,
    );
    const c = write(
      'case_goodhop_c.c',
      `
#include <stdlib.h>
void goodSinkC(char *data) {
    free(data);
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a, b, c]);

    expect(result.ownershipCorrelations.freedCrossFile).toEqual([
      expect.objectContaining({ calleeFunction: 'goodSinkC', calleeFile: c, callerFunction: 'good' }),
    ]);
    expect(result.ownershipCorrelations.unfreedSinkParams).toEqual([]);
  });

  test('a chain deeper than MAX_HOPS degrades to no correlation, not a false claim', async () => {
    // 10 hops of pure pass-through, well past the 8-hop cap.
    const files = [
      write(
        'deep_0.c',
        `
#include <stdlib.h>
void hop1(char *data);
void bad(void) {
    char *data = malloc(100);
    hop1(data);
}
`,
      ),
    ];
    for (let i = 1; i <= 10; i++) {
      const next = i < 10 ? `hop${i + 1}` : null;
      files.push(
        write(
          `deep_${i}.c`,
          next
            ? `void ${next}(char *data);\nvoid hop${i}(char *data) { ${next}(data); }\n`
            : `void hop${i}(char *data) { ; }\n`,
        ),
      );
    }

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, files);

    expect(result.ownershipCorrelations.freedCrossFile).toEqual([]);
    expect(result.ownershipCorrelations.unfreedSinkParams).toEqual([]);
  });
});

describe('CallGraphService — container transport (Juliet flow-variant 72-74 shapes)', () => {
  test('vector: caller inserts an allocation, callee extracts via operator[] and never frees', async () => {
    const a = write(
      'case_72a.cpp',
      `
#include <vector>
#include <cstdlib>
void badSink(std::vector<char*> dataVector);
void bad(void) {
    char *data = (char*)malloc(100);
    std::vector<char*> dataVector;
    dataVector.insert(dataVector.end(), 1, data);
    badSink(dataVector);
}
`,
    );
    const b = write(
      'case_72b.cpp',
      `
#include <vector>
void badSink(std::vector<char*> dataVector) {
    char *data = dataVector[2];
    ;
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a, b]);

    expect(result.ownershipCorrelations.unfreedSinkParams).toEqual([
      expect.objectContaining({
        calleeFunction: 'badSink',
        calleeFile: b,
        calleeParam: 'data',
        callerFunction: 'bad',
        callerVariable: 'data',
        kind: 'container',
      }),
    ]);
  });

  test('list: callee extracts via .front() and frees — exonerated via freedCrossFile with kind container', async () => {
    const a = write(
      'case_73a.cpp',
      `
#include <list>
#include <cstdlib>
void goodSink(std::list<char*> dataList);
void good(void) {
    char *data = (char*)malloc(100);
    std::list<char*> dataList;
    dataList.push_back(data);
    goodSink(dataList);
}
`,
    );
    const b = write(
      'case_73b.cpp',
      `
#include <list>
#include <cstdlib>
void goodSink(std::list<char*> dataList) {
    char *data = dataList.front();
    free(data);
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a, b]);

    expect(result.ownershipCorrelations.freedCrossFile).toEqual([
      expect.objectContaining({
        calleeFunction: 'goodSink',
        calleeFile: b,
        calleeParam: 'data',
        callerVariable: 'data',
        kind: 'container',
      }),
    ]);
  });

  test('a container carrying no tracked allocation produces no correlation', async () => {
    const a = write(
      'container_no_alloc.cpp',
      `
#include <vector>
void sink(std::vector<char*> v);
void caller(char *stackBuf) {
    std::vector<char*> v;
    v.insert(v.end(), 1, stackBuf);
    sink(v);
}
`,
    );
    const b = write(
      'container_no_alloc_sink.cpp',
      `
#include <vector>
void sink(std::vector<char*> v) {
    char *data = v[0];
    ;
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a, b]);

    expect(result.ownershipCorrelations.freedCrossFile).toEqual([]);
    expect(result.ownershipCorrelations.unfreedSinkParams).toEqual([]);
  });
});

describe('CallGraphService — reference-output-param ownership (Juliet flow-variant 43/62 shapes)', () => {
  test('freedViaCaller: dispatcher frees the value the Source wrote back through a reference param', async () => {
    const a = write(
      'case_43.cpp',
      `
#include <cstdlib>
static void badSource(char * &data) {
    data = (char *)calloc(100, sizeof(char));
}
static void bad(void) {
    char *data;
    data = NULL;
    badSource(data);
    ;
}
static void goodB2GSource(char * &data) {
    data = (char *)calloc(100, sizeof(char));
}
static void goodB2G(void) {
    char *data;
    data = NULL;
    goodB2GSource(data);
    free(data);
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a]);

    expect(result.ownershipCorrelations.freedViaCaller).toEqual([
      expect.objectContaining({ calleeFunction: 'goodB2GSource', callerFunction: 'goodB2G', variable: 'data' }),
    ]);
    expect(result.ownershipCorrelations.unfreedReturnOwnership).toEqual([
      expect.objectContaining({ callerFunction: 'bad', calleeFunction: 'badSource', callerVariable: 'data' }),
    ]);
  });

  test('cross-file: dispatcher and Source in different files still correlate', async () => {
    const a = write(
      'case_62a.cpp',
      `
void badSource(char * &data);
void goodB2GSource(char * &data);
static void bad(void) {
    char *data;
    data = NULL;
    badSource(data);
    ;
}
static void goodB2G(void) {
    char *data;
    data = NULL;
    goodB2GSource(data);
    free(data);
}
`,
    );
    const b = write(
      'case_62b.cpp',
      `
#include <cstdlib>
void badSource(char * &data) {
    data = (char *)calloc(100, sizeof(char));
}
void goodB2GSource(char * &data) {
    data = (char *)calloc(100, sizeof(char));
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a, b]);

    expect(result.ownershipCorrelations.freedViaCaller).toEqual([
      expect.objectContaining({ calleeFunction: 'goodB2GSource', calleeFile: b, callerFunction: 'goodB2G' }),
    ]);
    expect(result.ownershipCorrelations.unfreedReturnOwnership).toEqual([
      expect.objectContaining({ callerFunction: 'bad', calleeFunction: 'badSource', calleeFile: b }),
    ]);
  });

  test("a callee whose out-param the CALLER already allocated is correlateOwnership()'s direction, not this one", async () => {
    const a = write(
      'already_allocated.cpp',
      `
#include <cstdlib>
void sink(char *data) {
    ;
}
void caller(void) {
    char *data = (char *)malloc(100);
    sink(data);
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a]);

    // Already covered by unfreedSinkParams (correlateOwnership) — must NOT
    // also show up as a synthesized return-ownership candidate.
    expect(result.ownershipCorrelations.unfreedReturnOwnership).toEqual([]);
    expect(result.ownershipCorrelations.unfreedSinkParams).toEqual([
      expect.objectContaining({ calleeFunction: 'sink', callerFunction: 'caller', callerVariable: 'data' }),
    ]);
  });
});

describe('CallGraphService — virtual dispatch (Juliet flow-variant 81-82 shapes)', () => {
  test('fnIndex resolves the RECEIVER-CONSTRUCTED class, not just the first same-named method seen', async () => {
    const a = write(
      'case_82.cpp',
      `
class Base {
public:
    virtual void action(char *data) = 0;
};
void Bad::action(char *data) {
    ;
}
void GoodB2G::action(char *data) {
    free(data);
}
void bad(void) {
    char *data = (char *)malloc(100);
    Base *baseObject = new Bad;
    baseObject->action(data);
}
void goodB2G(void) {
    char *data = (char *)malloc(100);
    Base *baseObject = new GoodB2G;
    baseObject->action(data);
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a]);

    // Each dispatcher must resolve to ITS OWN constructed class's action() —
    // NOT collapse onto whichever definition parseAll happened to see first.
    expect(result.ownershipCorrelations.unfreedSinkParams).toEqual([
      expect.objectContaining({ calleeFunction: 'action', callerFunction: 'bad', callerVariable: 'data' }),
    ]);
    expect(result.ownershipCorrelations.freedCrossFile).toEqual([
      expect.objectContaining({ calleeFunction: 'action', callerFunction: 'goodB2G', callerVariable: 'data' }),
    ]);
  });
});

describe('CallGraphService — RAII constructor/destructor pairing (Juliet flow-variant 83-84 shapes)', () => {
  test("freedViaCaller: a destructor that frees the field exonerates the constructor's allocation", async () => {
    const a = write(
      'case_83.cpp',
      `
#include <cstdlib>
class GoodB2G {
public:
    GoodB2G(char *dataCopy);
    ~GoodB2G();
private:
    char *data;
};
GoodB2G::GoodB2G(char *dataCopy) {
    data = dataCopy;
    data = (char *)malloc(100 * sizeof(char));
}
GoodB2G::~GoodB2G() {
    free(data);
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a]);

    expect(result.ownershipCorrelations.freedViaCaller).toEqual([
      expect.objectContaining({ calleeFunction: 'GoodB2G', callerFunction: '~GoodB2G', variable: 'data' }),
    ]);
  });

  test("no matching destructor free: no correlation is added (the ctor's own candidate stays as-is)", async () => {
    const a = write(
      'case_84.cpp',
      `
#include <cstdlib>
class Bad {
public:
    Bad(char *dataCopy);
    ~Bad();
private:
    char *data;
};
Bad::Bad(char *dataCopy) {
    data = dataCopy;
    data = (char *)malloc(100 * sizeof(char));
}
Bad::~Bad() {
    ;
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a]);

    expect(result.ownershipCorrelations.freedViaCaller).toEqual([]);
  });

  test('a constructor with no matching destructor in the parsed file set is left alone', async () => {
    const a = write(
      'no_dtor.cpp',
      `
#include <cstdlib>
class Lonely {
public:
    Lonely();
private:
    char *data;
};
Lonely::Lonely() {
    data = (char *)malloc(100);
}
`,
    );

    const svc = new CallGraphService(new CParserService());
    const result = await svc.extract(dir, [a]);

    expect(result.ownershipCorrelations.freedViaCaller).toEqual([]);
  });
});
