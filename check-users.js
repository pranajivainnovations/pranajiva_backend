const { Client } = require('pg');

const client = new Client({
  host: '144.24.104.236',
  port: 5432,
  user: 'pranajiva',
  password: 'pranajiva_secure_pwd_123',
  database: 'pranajiva_db'
});

async function checkUsers() {
  try {
    await client.connect();
    console.log('Connected to database\n');
    
    const res = await client.query('SELECT id, email, first_name, last_name, role, created_at FROM public.user ORDER BY created_at DESC');
    
    console.log(`Found ${res.rows.length} user(s):\n`);
    
    if (res.rows.length === 0) {
      console.log('No users found in the database!');
    } else {
      res.rows.forEach((user, index) => {
        console.log(`User ${index + 1}:`);
        console.log(`  ID: ${user.id}`);
        console.log(`  Email: ${user.email}`);
        console.log(`  Name: ${user.first_name || 'N/A'} ${user.last_name || 'N/A'}`);
        console.log(`  Role: ${user.role || 'N/A'}`);
        console.log(`  Created: ${user.created_at}`);
        console.log('');
      });
    }
    
    await client.end();
  } catch (err) {
    console.error('Error:', err.message);
    await client.end();
  }
}

checkUsers();
