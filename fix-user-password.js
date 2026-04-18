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

    console.log("📧 Setting password for:", email);
    console.log("=" .repeat(60));

    // Retrieve the user
    const user = await userService.retrieveByEmail(email.toLowerCase());
    console.log(`\n✅ User found: ${user.email} (ID: ${user.id})`);

    // Update the user with password using setPassword method
    console.log("\n🔐 Setting password...");
    
    await userService.setPassword_(user.id, password);

    console.log("✅ Password set successfully!");

    // Verify the password was set
    const updatedUser = await userService.retrieve(user.id, {
      select: ["id", "email", "password_hash", "role"]
    });

    console.log("\n✅ Verification:");
    console.log(`   Email: ${updatedUser.email}`);
    console.log(`   Role: ${updatedUser.role}`);
    console.log(`   Password Hash Length: ${updatedUser.password_hash ? updatedUser.password_hash.length : 0}`);
    console.log(`   Password Set: ${updatedUser.password_hash ? 'YES ✓' : 'NO ✗'}`);

    console.log("\n🎉 You can now login with:");
    console.log(`   Email: ${email}`);
    console.log(`   Password: ${password}`);

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error(error);
    process.exit(1);
  }
})();
