const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function checkTables() {
  try {
    await client.connect();
    console.log('✓ Connected to database\n');

    // Get all tables
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log(`Total tables: ${tablesResult.rows.length}\n`);

    // Category-related tables
    const categoryTables = tablesResult.rows.filter(row => 
      row.table_name.toLowerCase().includes('category')
    );

    console.log('=== CATEGORY-RELATED TABLES ===');
    if (categoryTables.length > 0) {
      categoryTables.forEach(row => console.log(`  - ${row.table_name}`));
    } else {
      console.log('  No category tables found');
    }

    // Product-related tables
    const productTables = tablesResult.rows.filter(row => 
      row.table_name.toLowerCase().includes('product')
    );

    console.log('\n=== PRODUCT-RELATED TABLES ===');
    if (productTables.length > 0) {
      productTables.forEach(row => console.log(`  - ${row.table_name}`));
    } else {
      console.log('  No product tables found');
    }

    // Other important tables
    console.log('\n=== ALL TABLES ===');
    tablesResult.rows.forEach(row => console.log(`  - ${row.table_name}`));

    // Check if product_category table exists and has data
    const categoryCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'product_category'
      );
    `);

    if (categoryCheck.rows[0].exists) {
      const count = await client.query('SELECT COUNT(*) FROM product_category;');
      console.log(`\n✓ product_category table exists with ${count.rows[0].count} records`);
      
      // Show some sample categories if any
      if (parseInt(count.rows[0].count) > 0) {
        const samples = await client.query('SELECT id, name, handle, parent_category_id FROM product_category LIMIT 10;');
        console.log('\nSample categories:');
        samples.rows.forEach(cat => {
          console.log(`  ID: ${cat.id}, Name: ${cat.name}, Handle: ${cat.handle}, Parent: ${cat.parent_category_id || 'None'}`);
        });
      }
    } else {
      console.log('\n✗ product_category table does not exist');
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

checkTables();
