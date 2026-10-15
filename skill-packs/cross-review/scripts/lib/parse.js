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
 * Blank out fenced code blocks (fence lines included) while keeping every offset, so
 * markers quoted inside evidence or examples are not mistaken for real ones.
 */
/**
 * Line-by-line fence tracker (CommonMark rule): a fence opens with 3+ backticks or tildes
 * and closes only with the same character, at least as long, and nothing after it.
 * Returns "open", "inside", "close" or "outside" for each line in order.
 */
function fenceTracker() {
  let open = null;
  return (line) => {
    const t = line.trim();
    const m = t.match(/^(`{3,}|~{3,})/);
    if (open) {
      if (m && m[1][0] === open[0] && m[1].length >= open.length && t.slice(m[1].length).trim() === "") {
        open = null;
        return "close";
      }
      return "inside";
    }
    if (m) {
      open = m[1];
      return "open";
    }
    return "outside";
  };
}

/**
 * The reviewer sometimes wraps its whole answer in one fence (```markdown or ````markdown when the
 * answer itself quotes code). Return the inner text when the outer fence spans the whole
 * output, else the output unchanged.
 */
function unwrapWholeFence(md) {
  const lines = md.trim().split("\n");
  if (lines.length < 3) return md;
  const track = fenceTracker();
  for (let i = 0; i < lines.length; i++) {
    const kind = track(lines[i]);
    if (i === 0 && kind !== "open") return md;
    if (kind === "close") return i === lines.length - 1 ? lines.slice(1, -1).join("\n") : md;
  }
  return md;
}

/**
 * Blank out fenced code blocks (fence lines included) while keeping every offset, so
 * markers quoted inside evidence or examples are not mistaken for real ones.
 */
function maskFences(md) {
  const track = fenceTracker();
  return md.split("\n").map(line => (track(line) === "outside" ? line : " ".repeat(line.length))).join("\n");
}

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
export function parseVerdict(raw) {
  const md = maskFences(unwrapWholeFence(raw || ""));
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
    position: null,
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

  if (sections["position"]) result.position = sections["position"].replace(/^- /gm, "").trim() || null;
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
 * End of an ISSUE/RESPONSE block: the next heading of level 1-3 or a verdict
 * marker line, ignoring lines inside fenced code blocks (evidence may quote markdown).
 */
function findBlockEnd(md, start) {
  let offset = start;
  const track = fenceTracker();
  for (const line of md.slice(start).split("\n")) {
    if (track(line) === "outside" && offset > start && /^(?:#{1,3} |\*\*VERDICT\*\*|VERDICT[ \t]*:)/i.test(line)) {
      return offset;
    }
    offset += line.length + 1;
  }
  return md.length;
}

/**
 * parseOutputMarkdown — unified entry point for parsing reviewer output.
 *
 * Detects format variant and extracts structured data.
 */
export function parseOutputMarkdown(md, skillHint) {
  if (!md || !md.trim()) {
    return { format: "unknown", raw_markdown: md || "", parse_error: "Empty output" };
  }

  md = unwrapWholeFence(md);
  // Step 1: Detect format variant (ignoring markers quoted inside code fences)
  const masked = maskFences(md);
  const hasResponse = /^### RESPONSE-\d+:/m.test(masked);
  const hasIssue = /^### ISSUE-\d+:/m.test(masked);
  const hasOverallAssessment = /^### Overall Assessment/m.test(masked);
  const hasKeyInsights = /^### Key Insight/m.test(masked);
  const hasConsiderations = /^### Considerations/m.test(masked);

  let format;
  if (hasIssue && hasOverallAssessment) {
    format = "commit-pr-review";
  } else if (hasIssue) {
    format = "review";
  } else if (hasKeyInsights || hasConsiderations) {
    return parseThinkAboutMarkdown(md);
  } else if (hasResponse) {
    // Round 2+ of commit and PR reviews answers earlier findings with RESPONSE blocks
    format = "response";
  } else {
    // Verdict-only output (e.g. APPROVE with zero issues) is a review with no blocks
    const verdict = parseVerdict(md);
    if (verdict && verdict.status) {
      return { format: "review", blocks: [], verdict, overall_assessment: null, raw_markdown: md };
    }
    return { format: "unknown", raw_markdown: md, parse_error: "No recognized format markers found" };
  }

  // Step 2: Extract blocks
  const blockRegex = /^### (ISSUE|RESPONSE)-(\d+):\s*(.+)$/gm;
  const blockPositions = [];
  let m;

  while ((m = blockRegex.exec(masked)) !== null) {
    blockPositions.push({
      prefix: m[1],
      id: parseInt(m[2], 10),
      title: m[3].trim(),
      startContent: m.index + m[0].length,
      headerEnd: m.index + m[0].length,
    });
  }

  // Find end of each block (next ### heading that is ISSUE/RESPONSE or VERDICT or Overall Assessment)
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
      "commit-pr-review": ["category", "severity", "problem", "evidence", "suggested fix", "commit", "why it matters", "file"],
      "response": ["action", "reason", "revised finding", "counter-evidence", "maintained assessment"],
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
