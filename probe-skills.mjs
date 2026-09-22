/**
 * Does dsh's skill-filesystem provider actually discover the six skills the
 * dsh bundle ships in dist/skills?
 *
 * Boots the REAL registry + filesystem provider on a bare Cordis context with
 * includeDefaultRoots: false, so the bundled root is the only thing it can see.
 */
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'

const BUNDLED = 'C:/Users/Tham/Desktop/dsh_workspace/Agent-App/harness-plugins/dsh/dist/skills'

const ctx = new Context()
await ctx.plugin(SkillRegistry)
await ctx.plugin(SkillFileSystem, { bundledSkillDir: BUNDLED, includeDefaultRoots: false })

const skills = await ctx.skills.list()
console.log(`discovered ${skills.length} skill(s) from the bundled root:\n`)
for (const s of skills) {
  console.log(`  ${s.name}`)
  console.log(`      source      : ${s.source}`)
  console.log(`      modelInvocable: ${s.invocation.modelInvocable}`)
  console.log(`      description : ${String(s.description).replace(/\s+/g, ' ').slice(0, 110)}...`)
}
