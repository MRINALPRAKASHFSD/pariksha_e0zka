import { parse as parseCsv } from "csv-parse/sync";
import {
  QuestionType,
  isSubjectiveQuestionType,
  questionTypeValues,
  validateQuestionIntegrity,
  type QuestionDto,
  type QuestionImportRowPreviewDto,
} from "@pariksha/shared";

const MAX_IMPORT_ROWS = 500;

export const QUESTION_CSV_TEMPLATE = [
  "type,prompt,marks,negativeMarks,isRequired,optionA,optionB,optionC,optionD,correctOptions,explanation",
  'MULTIPLE_CHOICE,"What is the time complexity of binary search?",2,0.5,true,"O(n)","O(log n)","O(n log n)","O(1)","B","Binary search halves the remaining interval at every comparison."',
  'MULTIPLE_SELECT,"Select all valid HTTP idempotent methods.",3,1,false,"GET","POST","PUT","DELETE","A,C,D","POST creates new state on repeated calls and is not idempotent."',
  'TRUE_FALSE,"HTTPS encrypts transport traffic using TLS.",1,0,true,"True","False","","","A","HTTPS runs HTTP over TLS."',
  'SUBJECTIVE_SHORT,"Define ACID properties in relational databases in 2-3 sentences.",5,0,true,"","","","","","Atomicity, Consistency, Isolation, Durability."',
  'SUBJECTIVE_LONG,"Design a distributed rate limiter and discuss trade-offs.",10,0,false,"","","","","","Compare token bucket vs sliding window logs with Redis atomicity."',
].join("\n");

export const QUESTION_JSON_TEMPLATE = JSON.stringify(
  [
    {
      type: "MULTIPLE_CHOICE",
      prompt: "Which isolation level prevents phantom reads in standard SQL?",
      marks: 2,
      negativeMarks: 0.5,
      isRequired: true,
      explanation: "Serializable isolation prevents dirty, non-repeatable, and phantom reads.",
      options: [
        { label: "A", text: "Read Uncommitted", isCorrect: false },
        { label: "B", text: "Read Committed", isCorrect: false },
        { label: "C", text: "Serializable", isCorrect: true },
        { label: "D", text: "None of the above", isCorrect: false },
      ],
    },
    {
      type: "SUBJECTIVE_SHORT",
      prompt: "Explain why session tokens are hashed before storing in PostgreSQL.",
      marks: 4,
      negativeMarks: 0,
      isRequired: true,
      explanation: "Hashing prevents stolen database snapshots from yielding usable bearer tokens.",
    },
  ],
  null,
  2,
);

export function neutralizeCsvFormula(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n");
  if (/^[=+\-@\t\r]/.test(normalized)) {
    return `'${normalized}`;
  }
  return normalized;
}

function escapeCsvField(value: string): string {
  const safe = neutralizeCsvFormula(value);
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function parseBooleanFlag(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n", ""].includes(normalized)) return false;
  }
  return fallback;
}

function parseNumberField(value: unknown, fallback: number | null): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return fallback;
}

function normalizeRecordKeys(record: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    mapped[key.trim().toLowerCase()] = val;
  }
  return mapped;
}

function normalizeSingleRow(
  rawRow: Record<string, unknown>,
  rowNumber: number,
): QuestionImportRowPreviewDto {
  const row = normalizeRecordKeys(rawRow);
  const rawType = String(row.type ?? "")
    .trim()
    .toUpperCase() as QuestionType;
  if (!questionTypeValues.includes(rawType)) {
    return {
      row: rowNumber,
      valid: false,
      error: `Invalid question type "${String(row.type ?? "")}"`,
      question: null,
    };
  }

  const prompt = String(row.prompt ?? "").trim();
  const explanation =
    typeof row.explanation === "string" && row.explanation.trim().length > 0
      ? row.explanation.trim()
      : null;
  const marks = parseNumberField(row.marks, null);
  const negativeMarks = parseNumberField(row.negativemarks ?? row.negative_marks, 0);
  const isRequired = parseBooleanFlag(row.isrequired ?? row.is_required, false);

  if (marks === null) {
    return {
      row: rowNumber,
      valid: false,
      error: "Marks must be a valid positive number",
      question: null,
    };
  }
  if (negativeMarks === null) {
    return {
      row: rowNumber,
      valid: false,
      error: "negativeMarks must be a valid non-negative number",
      question: null,
    };
  }

  let options: Array<{ label: string; text: string; isCorrect: boolean }> = [];

  if (Array.isArray(row.options)) {
    options = row.options.map((opt, idx) => {
      const obj = (opt && typeof opt === "object" ? opt : {}) as Record<string, unknown>;
      const defaultLabel = String.fromCharCode(65 + idx);
      return {
        label: String(obj.label ?? defaultLabel).trim() || defaultLabel,
        text: String(obj.text ?? "").trim(),
        isCorrect: parseBooleanFlag(obj.isCorrect ?? obj.iscorrect, false),
      };
    });
  } else if (!isSubjectiveQuestionType(rawType)) {
    const optionKeys = [
      ["A", row.optiona ?? row.option1],
      ["B", row.optionb ?? row.option2],
      ["C", row.optionc ?? row.option3],
      ["D", row.optiond ?? row.option4],
      ["E", row.optione ?? row.option5],
      ["F", row.optionf ?? row.option6],
    ] as const;

    const correctTokens = String(row.correctoptions ?? row.correct ?? row.answer ?? "")
      .split(/[,;|]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const extracted = optionKeys
      .map(([label, val]) => ({
        label,
        text: typeof val === "string" ? val.trim() : "",
      }))
      .filter((opt) => opt.text.length > 0);

    if (rawType === QuestionType.TRUE_FALSE && extracted.length === 0) {
      const isTrueCorrect =
        correctTokens.includes("a") ||
        correctTokens.includes("true") ||
        correctTokens.includes("1");
      const isFalseCorrect =
        correctTokens.includes("b") ||
        correctTokens.includes("false") ||
        correctTokens.includes("0");
      options = [
        { label: "A", text: "True", isCorrect: isTrueCorrect },
        { label: "B", text: "False", isCorrect: !isTrueCorrect && isFalseCorrect },
      ];
    } else {
      options = extracted.map((opt, idx) => ({
        label: opt.label,
        text: opt.text,
        isCorrect:
          correctTokens.includes(opt.label.toLowerCase()) ||
          correctTokens.includes(String(idx + 1)) ||
          correctTokens.includes(opt.text.toLowerCase()),
      }));
    }
  }

  const issue = validateQuestionIntegrity({
    type: rawType,
    prompt,
    marks,
    negativeMarks,
    options,
  });
  if (issue) {
    return {
      row: rowNumber,
      valid: false,
      error: issue,
      question: null,
    };
  }

  return {
    row: rowNumber,
    valid: true,
    error: null,
    question: {
      type: rawType,
      prompt,
      explanation,
      marks,
      negativeMarks,
      isRequired,
      options,
    },
  };
}

export function parseAndValidateQuestionsImport(
  format: "csv" | "json",
  content: string,
): { rows: QuestionImportRowPreviewDto[]; parseError: string | null } {
  let rawItems: unknown[] = [];

  if (format === "csv") {
    try {
      const parsed = parseCsv(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
      }) as Record<string, unknown>[];
      rawItems = parsed;
    } catch (error) {
      return {
        rows: [],
        parseError: error instanceof Error ? error.message : "Invalid CSV syntax",
      };
    }
  } else {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (Array.isArray(parsed)) {
        rawItems = parsed;
      } else if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { questions?: unknown }).questions)
      ) {
        rawItems = (parsed as { questions: unknown[] }).questions;
      } else {
        return {
          rows: [],
          parseError: "JSON import must be an array of question objects or { questions: [...] }",
        };
      }
    } catch (error) {
      return {
        rows: [],
        parseError: error instanceof Error ? error.message : "Invalid JSON syntax",
      };
    }
  }

  if (rawItems.length === 0) {
    return { rows: [], parseError: "Import file contains no question rows" };
  }
  if (rawItems.length > MAX_IMPORT_ROWS) {
    return {
      rows: [],
      parseError: `Import exceeds maximum limit of ${MAX_IMPORT_ROWS} questions per batch`,
    };
  }

  const rows = rawItems.map((item, idx) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        row: idx + 1,
        valid: false,
        error: "Row must be an object/record",
        question: null,
      };
    }
    return normalizeSingleRow(item as Record<string, unknown>, idx + 1);
  });

  return { rows, parseError: null };
}

export function exportQuestionsToCsv(questions: QuestionDto[]): string {
  const header =
    "type,prompt,marks,negativeMarks,isRequired,optionA,optionB,optionC,optionD,correctOptions,explanation";

  const lines = questions.map((q) => {
    const opts = [...q.options].sort((a, b) => a.orderIndex - b.orderIndex);
    const optA = opts[0]?.text ?? "";
    const optB = opts[1]?.text ?? "";
    const optC = opts[2]?.text ?? "";
    const optD = opts[3]?.text ?? "";
    const correctLabels = opts
      .filter((o) => o.isCorrect)
      .map((o) => o.label)
      .join(",");

    return [
      escapeCsvField(q.type),
      escapeCsvField(q.prompt),
      String(q.marks),
      String(q.negativeMarks),
      String(q.isRequired),
      escapeCsvField(optA),
      escapeCsvField(optB),
      escapeCsvField(optC),
      escapeCsvField(optD),
      escapeCsvField(correctLabels),
      escapeCsvField(q.explanation ?? ""),
    ].join(",");
  });

  return [header, ...lines].join("\n");
}

export function exportQuestionsToJson(questions: QuestionDto[]): string {
  return JSON.stringify(
    questions.map((q) => ({
      type: q.type,
      prompt: q.prompt,
      marks: q.marks,
      negativeMarks: q.negativeMarks,
      isRequired: q.isRequired,
      explanation: q.explanation,
      options: q.options.map((opt) => ({
        label: opt.label,
        text: opt.text,
        isCorrect: opt.isCorrect,
      })),
    })),
    null,
    2,
  );
}
