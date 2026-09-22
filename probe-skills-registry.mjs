/**
 * End-to-end: the bundle's OWN provider object, registered into the REAL dsh
 * skill registry, listed and loaded through the real registry code.
 *
 * probe-dsh-plugin.mjs captures the provider through a fake context; this probe
 * takes that same captured factory and hands it to a genuine SkillRegistry, so
 * nothing about the skill path is simulated.
 */
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'

const mod = await import('./harness-plugins/dsh/dist/lib/index.js')

let captured
const fake = {
  tools: { register: () => {} },
  skills: { registerProvider: (create) => { captured = create; return () => {} } },
  inject: (_deps, cb) => { cb(fake) },
  effect: (fn) => { fn(); return () => {} },
  get: () => undefined,
  webServer: { register: () => () => {} },
}
mod.apply(fake)
if (!captured) throw new Error('the bundle registered no skill provider')

const ctx = new Context()
await ctx.plugin(SkillRegistry)
ctx.skills.registerProvider(captured)

const list = await ctx.skills.list()
console.log(`real registry sees ${list.length} skill(s) from the bundle:\n`)
for (const s of list) {
  console.log(`  ${s.name.padEnd(12)} source=${s.source} provider=${s.provider} model=${s.invocation.modelInvocable}`)
}

const creator = await ctx.skills.get('creator')
console.log(`\nctx.skills.get("creator"):`)
console.log(`  description : ${creator.description.slice(0, 90)}...`)
console.log(`  content     : ${creator.content.length} chars`)
console.log(`  resourceBase: ${JSON.stringify(creator.resourceBase)}`)
console.log(`  body starts : ${JSON.stringify(creator.content.slice(0, 48))}`)
process.exit(0)
