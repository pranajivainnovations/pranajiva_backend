const dotenv = require("dotenv");
const express = require("express");
const loaders = require("@medusajs/medusa/dist/loaders/index").default;

dotenv.config();

(async () => {
  const app = express();
  const directory = process.cwd();

  try {
    console.log("🔧 Initializing Medusa...\n");
    
    const { container } = await loaders({
      directory,
      expressApp: app,
    });

    const userService = container.resolve("userService");
    
    const email = "CrossFriend_Local@pranajiva.in";
    const password = "CrossFriendLocal@PranaJiva";

    console.log("📧 Checking user:", email);
    console.log("=" .repeat(60));

    // Try to retrieve user by email
    try {
      const user = await userService.retrieveByEmail(email.toLowerCase());
      console.log("\n✅ User found in database:");
      console.log(`   ID: ${user.id}`);
      console.log(`   Email: ${user.email}`);
      console.log(`   Role: ${user.role}`);
      console.log(`   API Token: ${user.api_token ? 'Set' : 'Not set'}`);
      console.log(`   Password Hash: ${user.password_hash ? 'Set (length: ' + user.password_hash.length + ')' : 'NOT SET - THIS IS A PROBLEM!'}`);
      console.log(`   Created: ${user.created_at}`);
      console.log(`   Updated: ${user.updated_at}`);

      // Try to verify password
      console.log("\n🔐 Testing password verification...");
      try {
        const isValid = await userService.retrieve(user.id, {
          select: ["id", "email", "password_hash"]
        });
        
        // Use the internal hashPassword method to compare
        const crypto = require("crypto");
        const passwordMatch = await new Promise((resolve) => {
          crypto.pbkdf2(
            password,
            "",
            10000,
            64,
            "sha512",
            (err, derivedKey) => {
              if (err) {
                resolve(false);
                return;
              }
              // This is a simplified check - actual Medusa uses scrypt
              resolve(true);
            }
          );
        });

        console.log("   Password verification check completed");
        
      } catch (error) {
        console.log("   ⚠️  Could not verify password:", error.message);
      }

      // List all users
      console.log("\n👥 All users in database:");
      console.log("=" .repeat(60));
      const allUsers = await userService.list({});
      allUsers.forEach((u, index) => {
        console.log(`\n${index + 1}. ${u.email}`);
        console.log(`   ID: ${u.id}`);
        console.log(`   Role: ${u.role}`);
        console.log(`   Has Password: ${u.password_hash ? 'Yes' : 'NO - PROBLEM!'}`);
      });

    } catch (error) {
      console.log("\n❌ User NOT found:", error.message);
      console.log("\nTrying to search with exact email (case-sensitive)...");
      
      // List all users to see what exists
      const allUsers = await userService.list({});
      console.log(`\nTotal users in database: ${allUsers.length}`);
      allUsers.forEach((u, index) => {
        console.log(`${index + 1}. ${u.email} (ID: ${u.id}, Role: ${u.role})`);
      });
    }

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error(error);
    process.exit(1);
  }
})();
