const dotenv = require("dotenv");
const { DataSource } = require("typeorm");

dotenv.config();

const AppDataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
});

async function checkCategories() {
  try {
    await AppDataSource.initialize();
    console.log("✅ Database connected successfully");

    // Check product categories
    const categories = await AppDataSource.query(
      "SELECT * FROM product_category ORDER BY created_at DESC LIMIT 10"
    );
    console.log("\n📦 Product Categories in Database:");
    console.log(`Total categories found: ${categories.length}`);
    if (categories.length > 0) {
      categories.forEach((cat) => {
        console.log(`  - ${cat.name} (ID: ${cat.id}, Handle: ${cat.handle})`);
      });
    } else {
      console.log("  ⚠️  No product categories found!");
    }

    // Check regions
    const regions = await AppDataSource.query(
      "SELECT id, name FROM region"
    );
    console.log("\n🌍 Regions:");
    console.log(`Total regions: ${regions.length}`);
    regions.forEach((r) => console.log(`  - ${r.name} (ID: ${r.id})`));

    // Check payment providers
    const paymentProviders = await AppDataSource.query(
      "SELECT * FROM payment_provider"
    );
    console.log("\n💳 Payment Providers:");
    console.log(`Total providers: ${paymentProviders.length}`);
    if (paymentProviders.length > 0) {
      paymentProviders.forEach((p) => console.log(`  - ${p.id} (Region: ${p.region_id})`));
    } else {
      console.log("  ⚠️  No payment providers configured!");
    }

    // Check fulfillment providers
    const fulfillmentProviders = await AppDataSource.query(
      "SELECT * FROM fulfillment_provider"
    );
    console.log("\n🚚 Fulfillment Providers:");
    console.log(`Total providers: ${fulfillmentProviders.length}`);
    if (fulfillmentProviders.length > 0) {
      fulfillmentProviders.forEach((p) => console.log(`  - ${p.id} (Region: ${p.region_id})`));
    } else {
      console.log("  ⚠️  No fulfillment providers configured!");
    }

    // Check shipping options
    const shippingOptions = await AppDataSource.query(
      "SELECT id, name, region_id FROM shipping_option"
    );
    console.log("\n📦 Shipping Options:");
    console.log(`Total shipping options: ${shippingOptions.length}`);
    if (shippingOptions.length > 0) {
      shippingOptions.forEach((s) => console.log(`  - ${s.name} (Region: ${s.region_id})`));
    } else {
      console.log("  ⚠️  No shipping options configured!");
    }

    await AppDataSource.destroy();
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

checkCategories();
