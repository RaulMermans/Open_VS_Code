import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"

import {
  SkillError,
  discoverSkills,
  getSkillMetadata,
  loadSkill,
  matchSkills,
  readSkillFrontmatter,
  type SkillFileReader,
} from "../../src/context/skills.ts"

const fixtureRoot = join(import.meta.dirname, "..", "fixtures", "skills-project")

test("reads exactly the frontmatter without loading body bytes", async () => {
  const path = join(fixtureRoot, ".agents", "skills", "safe-read", "SKILL.md")
  const frontmatter = await readSkillFrontmatter(path, 8 * 1024)
  assert.equal(frontmatter.endsWith("\n---\n"), true)
  assert.equal(frontmatter.includes("# Safe Read"), false)
  assert.equal(frontmatter.includes("Reject paths"), false)
})

test("discovers metadata in deterministic order without loading bodies", async () => {
  let fullReads = 0
  const reader: SkillFileReader = {
    readFrontmatter: readSkillFrontmatter,
    readText: async () => {
      fullReads += 1
      throw new Error("Discovery must not load Skill bodies")
    },
  }
  const skills = await discoverSkills(fixtureRoot, { reader })
  assert.deepEqual(skills.map((skill) => skill.name), ["repo-intake", "safe-read"])
  assert.equal("body" in skills[0]!, false)
  assert.equal(fullReads, 0)
})

test("loads a Skill body only after explicit selection", async () => {
  const skills = await discoverSkills(fixtureRoot)
  const metadata = getSkillMetadata(skills, "safe-read")
  const skill = await loadSkill(fixtureRoot, metadata)
  assert.equal(skill.body.startsWith("# Safe Read"), true)
  assert.equal(skill.body.includes("Reject paths outside"), true)
})

test("matches metadata deterministically without reading bodies", async () => {
  const skills = await discoverSkills(fixtureRoot)
  assert.deepEqual(matchSkills(skills, "bounded path-safe tools").map((skill) => skill.name), ["safe-read"])
})

test("rejects malformed frontmatter, duplicate names, and missing selections", async () => {
  const malformedRoot = join(import.meta.dirname, "..", "fixtures", "skills-malformed-project")
  await assert.rejects(discoverSkills(malformedRoot), { code: "MALFORMED_FRONTMATTER" })

  const duplicateRoot = join(import.meta.dirname, "..", "fixtures", "skills-duplicate-project")
  await assert.rejects(discoverSkills(duplicateRoot), { code: "DUPLICATE_NAME" })

  const skills = await discoverSkills(fixtureRoot)
  assert.throws(() => getSkillMetadata(skills, "missing"), SkillError)
})
