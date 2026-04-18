const { Client } = require("pg");
const crypto = require("crypto");

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL || "postgres://pranajiva:pranajiva_secure_pwd_123@144.24.104.236:5432/pranajiva_db" });
  await c.connect();

  // Check user
  const res = await c.query(`SELECT id, email, role, password_hash FROM public."user" WHERE email = $1`, ["admin@pranajiva.com"]);
  
  if (res.rows.length === 0) {
    console.log("User admin@pranajiva.com NOT FOUND in database");
    await c.end();
    return;
  }

  const user = res.rows[0];
  console.log("User found:");
  console.log("  ID:", user.id);
  console.log("  Email:", user.email);
  console.log("  Role:", user.role);
  console.log("  Has password_hash:", !!user.password_hash);
  console.log("  Hash length:", user.password_hash ? user.password_hash.length : 0);
  
  if (user.password_hash) {
    console.log("  Hash preview:", user.password_hash.substring(0, 40) + "...");
  }

  // Try scrypt verify  
  try {
    const { scryptSync } = crypto;
    const [hashed, salt] = user.password_hash.split(":");
    if (salt) {
      const hashedBuf = Buffer.from(hashed, "hex");
      const derivedKey = scryptSync("Admin@123", salt, 64);
      const isValid = crypto.timingSafeEqual(hashedBuf, derivedKey);
      console.log("\nScrypt verification (Admin@123):", isValid ? "VALID" : "INVALID");
    } else {
      console.log("\nHash format not scrypt (no salt separator)");
      console.log("Hash starts with:", user.password_hash.substring(0, 10));
    }
  } catch (e) {
    console.log("\nScrypt verify error:", e.message);
  }

  // Try bcrypt as fallback
  try {
    const bcrypt = require("bcrypt");
    const isValid = await bcrypt.compare("Admin@123", user.password_hash);
    console.log("Bcrypt verification (Admin@123):", isValid ? "VALID" : "INVALID");
  } catch (e2) {
    console.log("Bcrypt not available:", e2.message);
  }

  // Also check via Medusa's own AuthService
  try {
    const { UserService } = require("@medusajs/medusa");
    console.log("\nUserService available:", !!UserService);
  } catch(e) {
    console.log("\nMedusa UserService check:", e.message);
  }

  await c.end();
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
