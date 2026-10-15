// ============================================================
// Output parsers — v14
// ============================================================

/**
 * Parse a markdown field value: from "- FieldName:" to next "- " or "### ".
 * Handles multi-line values including fenced code blocks.
 */
function extractFieldValue(content) {
  if (!content) return "";
  return content.replace(/^\s*/, "").replace(/\s+$/, "");
}

/**
 * Parse "- FieldName: value" lines from a block of text.
 * Returns a Map of lowercase field name → raw value string.
 * Handles multi-line values (evidence with code blocks, etc.).
 */
function parseFields(blockContent) {
  const fields = new Map();
  const lines = blockContent.split("\n");
  let currentField = null;
  let currentValue = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Track fenced code blocks
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      if (currentField) {
        currentValue.push(line);
      }
      continue;
    }

    if (inCodeBlock) {
      if (currentField) {
        currentValue.push(line);
      }
      continue;
    }

    // Check for new field: "- FieldName: value" or "- FieldName (detail): value"
    const fieldMatch = line.match(/^- ([A-Za-z][A-Za-z_ ]*(?:\([^)]*\))?):\s*(.*)/);
    if (fieldMatch) {
      // Save previous field
      if (currentField) {
        fields.set(currentField, extractFieldValue(currentValue.join("\n")));
      }
      currentField = fieldMatch[1].trim().toLowerCase();
      currentValue = [fieldMatch[2]];
    } else if (currentField) {
      // Continuation line for current field
      currentValue.push(line);
    }
  }

  // Save last field
  if (currentField) {
    fields.set(currentField, extractFieldValue(currentValue.join("\n")));
  }

  return fields;
}

const VERDICT_STATUSES = ["APPROVE", "REVISE", "CONSENSUS", "CONTINUE", "STALEMATE"];

/**
 * Normalize a raw verdict status ("**APPROVE**", "`approve`.", "Stalemate") to one of
 * VERDICT_STATUSES. Returns null when the value does not start with a known status.
 */
export function normalizeVerdictStatus(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[*`]/g, "").trim();
  const m = cleaned.match(/^([A-Za-z]+)\b/);
  if (!m) return null;
  const word = m[1].toUpperCase();
  return VERDICT_STATUSES.includes(word) ? word : null;
}

/**
 * Extract verdict block from markdown.
 *
 * Accepts verdict headings and standalone bold "**VERDICT**" lines (any case) followed by
 * "- Status:" / "- Reason:" fields, and inline "VERDICT: X" values. When the output
 * contains several verdict markers, the last one wins.
 */
export function parseVerdict(md) {
  // Heading containing the word ("### VERDICT", "## Final Plan Review Verdict: APPROVE"),
  // a standalone bold "**VERDICT**" line, or an inline "VERDICT: X" line.
  const markerRegex = /^(?:#{1,3}[ \t]*(?:[^\n]*?[ \t])?\**VERDICT\**[ \t]*(?::[ \t]*(.*))?|\*\*VERDICT\*\*[ \t]*(?::[ \t]*(.*))?|VERDICT[ \t]*:[ \t]*(.*))$/gim;
  let last = null;
  let m;
  while ((m = markerRegex.exec(md)) !== null) last = m;
  if (!last) return null;

  const inlineValue = (last[1] ?? last[2] ?? last[3] ?? "").trim();
  const startIdx = last.index + last[0].length;
  // Find next heading or end
  const nextHeading = md.slice(startIdx).search(/^#{1,3} /m);
  const verdictContent = nextHeading >= 0
    ? md.slice(startIdx, startIdx + nextHeading)
    : md.slice(startIdx);

  const fields = parseFields(verdictContent);
  // Fallback: a bare status as the first non-empty line ("## Final Verdict\n\n**APPROVE**")
  const firstLine = verdictContent.split("\n").map(l => l.trim()).find(l => l) || "";
  const rawStatus = inlineValue || fields.get("status") || (normalizeVerdictStatus(firstLine) ? firstLine : null);

  const result = {
    status: normalizeVerdictStatus(rawStatus),
    reason: fields.get("reason") || null,
    risk_summary: null,
  };

  // Parse Security Risk Summary if present
  const riskMatch = verdictContent.match(/Security Risk Summary:\s*\n([\s\S]*?)(?:\n\n|\nRecommendations:|\nBlocking|$)/);
  if (riskMatch) {
    const riskLines = riskMatch[1].trim().split("\n");
    const risk = {};
    for (const line of riskLines) {
      const m = line.match(/^-\s*(Critical|High|Medium|Low):\s*(\d+)/i);
      if (m) {
        risk[m[1].toLowerCase()] = parseInt(m[2], 10);
      }
    }
    if (Object.keys(risk).length > 0) {
      result.risk_summary = risk;
    }
  }

  return result;
}

/**
 * Extract Overall Assessment block from markdown.
 */
function parseOverallAssessment(md) {
  const oaMatch = md.match(/^### Overall Assessment\s*$/m);
  if (!oaMatch) return null;

  const startIdx = oaMatch.index + oaMatch[0].length;
  const nextHeading = md.slice(startIdx).search(/^### /m);
  const oaContent = nextHeading >= 0
    ? md.slice(startIdx, startIdx + nextHeading)
    : md.slice(startIdx);

  const fields = parseFields(oaContent);
  const result = {};

  for (const [key, value] of fields) {
    // Normalize field names: "code quality" → "code_quality"
    const normalized = key.replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    result[normalized] = value;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse think-about format output.
 */
function parseThinkAboutMarkdown(md) {
  const result = {
    format: "think-about",
    insights: [],
    considerations: [],
    recommendations: [],
    sources: [],
    open_questions: [],
    confidence: null,
    suggested_status: null,
    raw_markdown: md,
  };

  // Split by ### headings
  const sections = {};
  const sectionRegex = /^### (.+)$/gm;
  let match;
  const headings = [];

  while ((match = sectionRegex.exec(md)) !== null) {
    headings.push({ title: match[1].trim(), index: match.index + match[0].length });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index - headings[i + 1].title.length - 5 : md.length;
    sections[headings[i].title.toLowerCase()] = md.slice(start, end).trim();
  }

  // Extract bullet items from a section
  function extractBullets(sectionName) {
    const content = sections[sectionName];
    if (!content) return [];
    const items = [];
    for (const line of content.split("\n")) {
      const m = line.match(/^- (.+)/);
      if (m) items.push(m[1].trim());
    }
    return items;
  }

  result.insights = extractBullets("key insights");
  result.considerations = extractBullets("considerations");
  result.recommendations = extractBullets("recommendations");
  result.open_questions = extractBullets("open questions");

  // Parse Sources table
  const sourcesContent = sections["sources"];
  if (sourcesContent) {
    const tableRows = sourcesContent.split("\n").filter(line => line.includes("|") && !line.match(/^\|?\s*[-|]+\s*\|?$/));
    for (const row of tableRows) {
      const cells = row.split("|").map(c => c.trim()).filter(c => c);
      if (cells.length >= 3 && cells[0] !== "#") {
        result.sources.push({ url: cells[1], description: cells[2] });
      }
    }
  }

  // Confidence level
  const confContent = sections["confidence level"];
  if (confContent) {
    const m = confContent.match(/\b(low|medium|high)\b/i);
    if (m) result.confidence = m[1].toLowerCase();
  }

  // Suggested Status
  const statusContent = sections["suggested status (advisory)"] || sections["suggested status"];
  if (statusContent) {
    const m = statusContent.match(/\b(CONTINUE|CONSENSUS|STALEMATE)\b/i);
    if (m) result.suggested_status = m[1].toUpperCase();
  }

  return result;
}

/**
 * End of an ISSUE/CROSS/RESPONSE block: the next heading of level 1-3 or a verdict
 * marker line, ignoring lines inside fenced code blocks (evidence may quote markdown).
 */
function findBlockEnd(md, start) {
  let offset = start;
  let inFence = false;
  for (const line of md.slice(start).split("\n")) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
    } else if (!inFence && offset > start && /^(?:#{1,3} |\*\*VERDICT\*\*|VERDICT[ \t]*:)/i.test(line)) {
      return offset;
    }
    offset += line.length + 1;
  }
  return md.length;
}

/**
 * parseOutputMarkdown — unified entry point for parsing Codex output.
 *
 * Detects format variant and extracts structured data.
 */
export function parseOutputMarkdown(md, skillHint) {
  if (!md || !md.trim()) {
    return { format: "unknown", raw_markdown: md || "", parse_error: "Empty output" };
  }

  // Step 1: Detect format variant
  const hasResponse = /^### RESPONSE-\d+:/m.test(md);
  const hasCross = /^### CROSS-\d+:/m.test(md);
  const hasIssue = /^### ISSUE-\d+:/m.test(md);
  const hasCWE = /\bCWE:/m.test(md) || /\bCWE-\d+/m.test(md);
  const hasOWASP = /\bOWASP:/m.test(md) || /\bA\d{2}:2021/m.test(md);
  const hasAttackVector = /\bAttack Vector:/m.test(md);
  const hasOverallAssessment = /^### Overall Assessment/m.test(md);
  const hasKeyInsights = /^### Key Insight/m.test(md);
  const hasConsiderations = /^### Considerations/m.test(md);

  let format;
  if (hasResponse && !hasIssue && !hasCross) {
    format = "codebase-validation";
  } else if (hasCross) {
    format = "codebase-cross";
  } else if (hasIssue && (hasCWE || hasOWASP || hasAttackVector)) {
    format = "security-review";
  } else if (hasIssue && hasOverallAssessment) {
    format = "commit-pr-review";
  } else if (hasIssue) {
    format = "review";
  } else if (hasKeyInsights || hasConsiderations) {
    return parseThinkAboutMarkdown(md);
  } else if (hasResponse) {
    // Standalone RESPONSE blocks (round 2+ security review)
    format = "codebase-validation";
  } else {
    // Verdict-only output (e.g. APPROVE with zero issues) is a review with no blocks
    const verdict = parseVerdict(md);
    if (verdict && verdict.status) {
      return { format: "review", blocks: [], verdict, overall_assessment: null, raw_markdown: md };
    }
    return { format: "unknown", raw_markdown: md, parse_error: "No recognized format markers found" };
  }

  // Step 2: Extract blocks
  const blockRegex = /^### (ISSUE|CROSS|RESPONSE)-(\d+):\s*(.+)$/gm;
  const blockPositions = [];
  let m;

  while ((m = blockRegex.exec(md)) !== null) {
    blockPositions.push({
      prefix: m[1],
      id: parseInt(m[2], 10),
      title: m[3].trim(),
      startContent: m.index + m[0].length,
      headerEnd: m.index + m[0].length,
    });
  }

  // Find end of each block (next ### heading that is ISSUE/CROSS/RESPONSE or VERDICT or Overall Assessment)
  const blocks = [];
  for (let i = 0; i < blockPositions.length; i++) {
    const start = blockPositions[i].startContent;
    // Find next ### heading
    const end = findBlockEnd(md, start);
    const blockContent = md.slice(start, end);

    const fields = parseFields(blockContent);
    const block = {
      id: blockPositions[i].id,
      prefix: blockPositions[i].prefix,
      title: blockPositions[i].title,
    };

    // Step 3: Extract fields per variant
    // Common fields for all block-based formats
    const fieldMapping = {
      "review": ["category", "severity", "location", "problem", "evidence", "why it matters", "suggested fix", "plan section", "file"],
      "security-review": ["category", "severity", "location", "problem", "evidence", "suggested fix", "cwe", "owasp", "attack vector", "confidence", "file"],
      "commit-pr-review": ["category", "severity", "problem", "evidence", "suggested fix", "commit", "why it matters", "file"],
      "codebase-cross": ["category", "severity", "problem", "evidence", "suggested fix", "modules affected"],
      "codebase-validation": ["action", "reason", "revised finding", "counter-evidence", "maintained assessment"],
    };

    const expectedFields = fieldMapping[format] || [];
    for (const [key, value] of fields) {
      // Normalize field name: "why it matters" → "why_it_matters"
      const normalized = key.replace(/\s+/g, "_").replace(/[^a-z0-9_()]/g, "");
      if (expectedFields.some(f => f.replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "") === normalized || key === f)) {
        block[normalized] = value;
      } else {
        // Unknown field → extra
        if (!block.extra) block.extra = {};
        block.extra[key] = value;
      }
    }

    if (!block.extra) block.extra = {};
    blocks.push(block);
  }

  const result = {
    format,
    blocks,
    verdict: parseVerdict(md),
    overall_assessment: hasOverallAssessment ? parseOverallAssessment(md) : null,
    raw_markdown: md,
  };

  return result;
}
