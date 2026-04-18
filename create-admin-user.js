const dotenv = require("dotenv");
const express = require("express");
const loaders = require("@medusajs/medusa/dist/loaders/index").default;

dotenv.config();

(async () => {
  const app = express();
  const directory = process.cwd();

  try {
    console.log("🔧 Initializing Medusa...");
    
    const { container } = await loaders({
      directory,
      expressApp: app,
    });

    const userService = container.resolve("userService");
    
    const email = "CrossFriend_Local@pranajiva.in";
    const password = "CrossFriendLocal@PranaJiva";

    // Check if user already exists
    try {
      const existingUser = await userService.retrieveByEmail(email);
      console.log(`\n⚠️  User already exists: ${existingUser.email}`);
      console.log(`   ID: ${existingUser.id}`);
      console.log(`   Role: ${existingUser.role}`);
      process.exit(0);
    } catch (error) {
      // User doesn't exist, proceed to create
    }

    // Create the admin user
    console.log(`\n✅ Creating admin user: ${email}`);
    
    const user = await userService.create({
      email: email,
      password: password,
      role: "admin",
    }, password);

    console.log(`\n🎉 Admin user created successfully!`);
    console.log(`   Email: ${user.email}`);
    console.log(`   ID: ${user.id}`);
    console.log(`   Role: ${user.role}`);
    console.log(`\n✅ You can now login to the admin panel with these credentials:`);
    console.log(`   Email: ${email}`);
    console.log(`   Password: ${password}`);

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error creating user:", error.message);
    console.error(error);
    process.exit(1);
  }
})();
