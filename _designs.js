require('dotenv').config()
const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
;(async()=>{
  const { rows } = await pool.query(`
    SELECT id, prompt, occasion, style, flavor, view_count, save_count, order_count,
           created_at::date AS created
      FROM ai_studio.cake_designs
     WHERE is_public = true AND status='active'
     ORDER BY prompt, created_at`)
  console.log('total public designs:', rows.length)
  const norm = p => (p||'').toLowerCase().replace(/\s+/g,' ').trim()
  const groups = new Map()
  for (const r of rows) {
    const k = norm(r.prompt).slice(0,80)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  console.log('distinct prompt-groups:', groups.size)
  console.log('\n=== GROUPS WITH DUPLICATES ===')
  for (const [k,v] of [...groups.entries()].sort((a,b)=>b[1].length-a[1].length)) {
    if (v.length < 2) continue
    console.log(`\n[${v.length}x] ${k}`)
    v.forEach((r,i)=>console.log(`   ${i===0?'KEEP':'HIDE'}  ${r.id}  views:${r.view_count||0} saves:${r.save_count||0} ${r.created}`))
  }
  console.log('\n=== ALL PROMPTS (for privacy review) ===')
  ;[...groups.keys()].sort().forEach(k=>console.log(' -', k))
  await pool.end()
})().catch(e=>{console.error('ERR',e.message);process.exit(1)})
