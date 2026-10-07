import { invokedSkills } from '../../shared/skill-invocation.js';
import { listSkillLibrary, readLibrarySkill, type SkillLibraryScope } from '../skill-library.js';
import { readSkillAtRevision, readSkillTextSnapshot } from '../skills.js';
import { resolvePath } from '../sandbox.js';
import { createHash } from 'node:crypto';
import type { Root } from '../../shared/types.js';
import type { RoutedSkillSelection } from '../../shared/skill-routing.js';
import type { SkillLibrary } from '../../shared/skills.js';

/** Read once at the input owner's preparation boundary. deliveryText owns retries. */
export type SelectedSkill = { id: string; text: string; path?: string };
export async function selectedSkillInstructions(authored: string, scope: SkillLibraryScope = {}, library?: SkillLibrary, autoSkills: readonly RoutedSkillSelection[] = [], access?: () => { roots: readonly Root[]; read: boolean }): Promise<SelectedSkill[]> {
  const sections: SelectedSkill[] = [];
  const ids = invokedSkills(authored);
  if (access) {
    for (const id of ids.length ? ids : autoSkills.map(selection => selection.id)) {
      const selected = library?.skills.find(skill => skill.id === id);
      if (!selected) throw new Error(`Skill "${id}" is unavailable in the external approved roots.`);
      const before = access();
      if (!before.read) throw new Error('Read permission is required for selected Skills');
      const resolved = await resolvePath(before.roots, selected.path);
      const checked = access();
      if (!checked.read) throw new Error('Read permission changed during Skill preparation');
      const current = await resolvePath(checked.roots, selected.path);
      if (current.real !== resolved.real) throw new Error('Skill changed location during preparation');
      const snapshot = await readSkillTextSnapshot(current.real);
      const after = access();
      if (!after.read || (await resolvePath(after.roots, selected.path)).real !== current.real) throw new Error('Skill location or permission changed during reading');
      const expected = !ids.length ? autoSkills.find(selection => selection.id === id)?.revision : undefined;
      if (expected && createHash('sha256').update(snapshot.bytes).digest('hex') !== expected) throw new Error(`Auto-selected Skill "${id}" changed after routing; send the message again`);
      sections.push({ id, path: selected.path, text: snapshot.text.replace(/\r\n?/g, '\n') });
    }
    return sections;
  }
  if (!ids.length && autoSkills.length) {
    for (const selection of autoSkills) {
      const skill = await readSkillAtRevision(selection.id, selection.revision);
      sections.push({ id: selection.id, path: skill.summary.path, text: skill.text.replace(/\r\n?/g, '\n') });
    }
    return sections;
  }
  if (!ids.length) return sections;
  const current = library ?? await listSkillLibrary(scope);
  for (const id of ids) {
    const skill = await readLibrarySkill(id, scope, current);
    sections.push({ id, path: skill.summary.path, text: skill.text.replace(/\r\n?/g, '\n') });
  }
  return sections;
}
