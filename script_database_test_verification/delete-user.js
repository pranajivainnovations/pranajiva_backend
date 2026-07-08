const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://pranajiva:pranajiva_secure_pwd_123@144.24.104.236:5432/pranajiva_db'
});

async function deleteUser() {
  try {
    // Delete ALL invites
    await pool.query('DELETE FROM invite');
    console.log('✅ Deleted all invites');
    
    // Delete ALL users
    await pool.query('DELETE FROM "user"');
    console.log('✅ Deleted all users');
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

deleteUser();
