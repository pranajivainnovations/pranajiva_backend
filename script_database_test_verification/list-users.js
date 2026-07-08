const dotenv = require("dotenv");
const express = require("express");
const loaders = require("@medusajs/medusa/dist/loaders/index").default;

dotenv.config();

(async () => {
  const app = express();
  const directory = process.cwd();

  const { container } = await loaders({ directory, expressApp: app });
  const userService = container.resolve("userService");

  const email = "admin@pranajiva.com";
  const newPassword = "Admin@PranaJiva2026";

  const user = await userService.retrieveByEmail(email.toLowerCase());
  console.log("Found user:", user.email, "| Role:", user.role);

  await userService.setPassword_(user.id, newPassword);

  console.log("\n✅ Password reset successfully!");
  console.log("   Email:    " + email);
  console.log("   Password: " + newPassword);
  process.exit(0);
})().catch(e => { console.error("Error:", e.message); process.exit(1); });
