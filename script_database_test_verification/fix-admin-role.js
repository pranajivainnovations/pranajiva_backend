const { Client } = require("pg");

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL || "postgres://pranajiva:pranajiva_secure_pwd_123@144.24.104.236:5432/pranajiva_db" });
  await c.connect();

  await c.query(`UPDATE public."user" SET role = 'admin' WHERE email = 'admin@pranajiva.com'`);
  
  const res = await c.query(`SELECT id, email, role FROM public."user" WHERE email = 'admin@pranajiva.com'`);
  console.log("Updated user:", JSON.stringify(res.rows[0]));
  
  await c.end();
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
