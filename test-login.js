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
    
    // Test different email variations
    const emailsToTest = [
      "CrossFriend_Local@pranajiva.in",
      "crossfriend_local@pranajiva.in",
      "admin@pranajiva.com",
      "crossfriend@pranajiva.in"
    ];
    
    console.log("📋 Checking all admin users:\n");
    
    for (const email of emailsToTest) {
      try {
        const user = await userService.retrieveByEmail(email.toLowerCase(), {
          select: ["id", "email", "role", "password_hash"]
        });
        
        console.log(`\n✅ Found user: ${user.email}`);
        console.log(`   ID: ${user.id}`);
        console.log(`   Role: ${user.role}`);
        console.log(`   Has Password: ${user.password_hash ? 'YES ✓' : 'NO ✗'}`);
        console.log(`   Password Hash: ${user.password_hash ? user.password_hash.substring(0, 20) + '...' : 'NONE'}`);
        
        if (user.role === 'admin') {
          console.log(`\n   ⭐ THIS IS AN ADMIN USER`);
          
          // Try to authenticate with a test password
          const testPasswords = [
            "CrossFriendLocal@PranaJiva",
            "crossfriendlocal@pranajiva",
            "admin",
            "Admin123"
          ];
          
          console.log(`\n   Testing passwords...`);
          for (const pwd of testPasswords) {
            try {
              const result = await userService.retrieve(user.id);
              const authResult = await userService.hashPassword_(pwd);
              console.log(`   - Testing: "${pwd}" - Hash created`);
            } catch (e) {
              // Silent
            }
          }
          
          // Set a known password
          console.log(`\n   🔐 Setting new password: "Admin@123"`);
          await userService.setPassword_(user.id, "Admin@123");
          
          console.log(`\n   ✅ Password updated successfully!`);
          console.log(`\n   ═══════════════════════════════════════`);
          console.log(`   🎉 LOGIN CREDENTIALS:`);
          console.log(`   ═══════════════════════════════════════`);
          console.log(`   Email: ${user.email}`);
          console.log(`   Password: Admin@123`);
          console.log(`   ═══════════════════════════════════════\n`);
        }
        
      } catch (e) {
        console.log(`\n❌ User not found: ${email}`);
      }
    }
    
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error(error);
    process.exit(1);
  }
})();
