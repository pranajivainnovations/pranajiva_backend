const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function checkAiStudio() {
  try {
    await client.connect();
    console.log('✓ Connected to database\n');

    // ── Check if ai_studio schema exists ─────────────────────────────────────
    const schemaResult = await client.query(`
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name = 'ai_studio';
    `);

    if (schemaResult.rows.length === 0) {
      console.log('✗ ai_studio schema does NOT exist');
      console.log('  → Run: npx medusa migrations run');
      return;
    }

    console.log('✓ ai_studio schema exists\n');

    // ── Check tables in ai_studio schema ─────────────────────────────────────
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'ai_studio' 
      ORDER BY table_name;
    `);

    console.log('=== AI STUDIO TABLES ===');
    if (tablesResult.rows.length > 0) {
      tablesResult.rows.forEach(row => console.log(`  ✓ ${row.table_name}`));
    } else {
      console.log('  ✗ No tables found in ai_studio schema');
      return;
    }

    // ── Check columns in generations table ───────────────────────────────────
    console.log('\n=== ai_studio.generations COLUMNS ===');
    const genCols = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_schema = 'ai_studio' AND table_name = 'generations'
      ORDER BY ordinal_position;
    `);
    genCols.rows.forEach(col => {
      console.log(`  ${col.column_name} | ${col.data_type} | nullable: ${col.is_nullable} | default: ${col.column_default || '-'}`);
    });

    // ── Check columns in cake_designs table ──────────────────────────────────
    console.log('\n=== ai_studio.cake_designs COLUMNS ===');
    const designCols = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_schema = 'ai_studio' AND table_name = 'cake_designs'
      ORDER BY ordinal_position;
    `);
    designCols.rows.forEach(col => {
      console.log(`  ${col.column_name} | ${col.data_type} | nullable: ${col.is_nullable} | default: ${col.column_default || '-'}`);
    });

    // ── Check indexes ────────────────────────────────────────────────────────
    console.log('\n=== INDEXES ===');
    const indexes = await client.query(`
      SELECT indexname, tablename
      FROM pg_indexes 
      WHERE schemaname = 'ai_studio'
      ORDER BY tablename, indexname;
    `);
    indexes.rows.forEach(idx => {
      console.log(`  ${idx.tablename} → ${idx.indexname}`);
    });

    // ── Check row counts ─────────────────────────────────────────────────────
    console.log('\n=== ROW COUNTS ===');
    const genCount = await client.query('SELECT COUNT(*) FROM ai_studio.generations;');
    const designCount = await client.query('SELECT COUNT(*) FROM ai_studio.cake_designs;');
    console.log(`  generations:  ${genCount.rows[0].count}`);
    console.log(`  cake_designs: ${designCount.rows[0].count}`);

    console.log('\n✓ AI Studio schema is ready!');

  } catch (error) {
    console.error('✗ Error:', error.message);
  } finally {
    await client.end();
  }
}

checkAiStudio();
