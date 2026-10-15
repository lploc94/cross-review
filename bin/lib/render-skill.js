// Render an installed SKILL.md from its template in the skill pack.
// Kept apart from bin/cross-review.js, which runs the install as soon as it is imported.

import fs from 'node:fs';
import path from 'node:path';

// Shared protocol section each runner skill receives after the core section
export const PROTOCOL_VARIANTS = {
  'review-plan': 'apply-rebut',
  'review-impl': 'apply-rebut',
  'review-pr': 'cross-analysis',
  'review-think': 'cross-analysis',
};

// Values for {{CLIENT_*}} placeholders in skills installed for both Claude Code and Codex
export const CLIENTS = {
  claude: { CLIENT_SKILL: '/', CLIENT_INSTRUCTIONS: '`CLAUDE.md`/`AGENTS.md`' },
  codex: { CLIENT_SKILL: '$', CLIENT_INSTRUCTIONS: '`AGENTS.md`' },
};

function readProtocol(skillPackDir, name) {
  const file = path.join(skillPackDir, 'shared', 'protocol', `${name}.md`);
  return fs.readFileSync(file, 'utf8').trimEnd();
}

/**
 * Returns the rendered SKILL.md text. Throws when the template lacks a required
 * placeholder or when any `{{...}}` placeholder is left after rendering.
 */
export function renderSkillTemplate(skillPackDir, skill, { runnerPath, skillsDir, client } = {}) {
  const templatePath = path.join(skillPackDir, 'skills', skill, 'SKILL.md');
  let text = fs.readFileSync(templatePath, 'utf8');

  if (client !== undefined) {
    const values = CLIENTS[client];
    if (!values) throw new Error(`Unknown client "${client}" (expected ${Object.keys(CLIENTS).join(' or ')})`);
    for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{{${name}}}`, value);
  }

  const variant = PROTOCOL_VARIANTS[skill];
  if (variant) {
    for (const placeholder of ['{{PROTOCOL_CORE}}', '{{PROTOCOL_VARIANT}}']) {
      if (!text.includes(placeholder)) {
        throw new Error(`Template ${skill}/SKILL.md missing ${placeholder} placeholder`);
      }
    }
    // Protocol text may itself contain {{RUNNER_PATH}}, so insert it first
    text = text.replaceAll('{{PROTOCOL_CORE}}', readProtocol(skillPackDir, 'core'));
    text = text.replaceAll('{{PROTOCOL_VARIANT}}', readProtocol(skillPackDir, variant));
    if (runnerPath === undefined) {
      throw new Error(`Rendering ${skill} requires runnerPath`);
    }
  }
  if (runnerPath !== undefined) text = text.replaceAll('{{RUNNER_PATH}}', runnerPath);
  if (skillsDir !== undefined) text = text.replaceAll('{{SKILLS_DIR}}', skillsDir);

  // Any remaining "{{" is an unresolved or malformed placeholder
  const leftover = text.match(/\{\{[^\n]{0,40}/);
  if (leftover) {
    throw new Error(`Template ${skill}/SKILL.md still contains "${leftover[0]}" after rendering`);
  }
  return text;
}
