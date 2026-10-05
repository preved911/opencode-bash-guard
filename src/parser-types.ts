export interface NormalizedWordValue {
  raw: string;
  value: string | null;
}

export interface RedirectInfo {
  operator: string;
  target: string;
  fileDescriptor: number | undefined;
  wellKnown: boolean;
  rawTarget?: string;
  targetValue?: string | null;
  heredocBody?: string | null;
}

export interface NormalizedInvocation {
  command: string;
  commandName: string;
  argv: string[];
  redirects: RedirectInfo[];
  candidatePaths: string[];
  candidatePathDetails?: NormalizedWordValue[];
}

export interface ParsedCommand {
  invocations: NormalizedInvocation[];
  topLevelInvocations: NormalizedInvocation[];
  parseError: boolean;
  errors: string[];
  maxDepth: number;
}

export interface LineSegmentInfo {
  lineNumber: number;
  segmentCount: number;
}

export interface PerLineResult {
  lines: LineSegmentInfo[];
  worstLine: LineSegmentInfo | null;
}

export interface InlineScriptInfo {
  interpreter: string;
  statementCount: number;
}
