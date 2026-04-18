const dotenv = require("dotenv");
const { DataSource } = require("typeorm");

dotenv.config();

const AppDataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
});

async function seedCategories() {
  try {
    await AppDataSource.initialize();
    console.log("✅ Database connected");

    // Define product categories
    const categories = [
      {
        id: "pcat_yoga_mats",
        name: "Yoga Mats",
        handle: "yoga-mats",
        description: "Premium yoga mats for your practice",
        is_active: true,
        is_internal: false,
        rank: 0,
      },
      {
        id: "pcat_yoga_wear",
        name: "Yoga Wear",
        handle: "yoga-wear",
        description: "Comfortable yoga clothing and accessories",
        is_active: true,
        is_internal: false,
        rank: 1,
      },
      {
        id: "pcat_meditation",
        name: "Meditation Accessories",
        handle: "meditation-accessories",
        description: "Tools for meditation and mindfulness",
        is_active: true,
        is_internal: false,
        rank: 2,
      },
      {
        id: "pcat_wellness",
        name: "Wellness Products",
        handle: "wellness-products",
        description: "Health and wellness essentials",
        is_active: true,
        is_internal: false,
        rank: 3,
      },
    ];

    console.log("\n📦 Creating product categories...");

    for (const category of categories) {
      // Check if category already exists
      const existing = await AppDataSource.query(
        "SELECT id FROM product_category WHERE id = $1",
        [category.id]
      );

      if (existing.length > 0) {
        console.log(`  ⏩ Skipped: ${category.name} (already exists)`);
        continue;
      }

      await AppDataSource.query(
        `INSERT INTO product_category 
        (id, name, handle, description, is_active, is_internal, rank, created_at, updated_at) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
        [
          category.id,
          category.name,
          category.handle,
          category.description,
          category.is_active,
          category.is_internal,
          category.rank,
        ]
      );
      console.log(`  ✅ Created: ${category.name}`);
    }

    // Verify
    const allCategories = await AppDataSource.query(
      "SELECT id, name, handle FROM product_category ORDER BY rank"
    );
    console.log(`\n✅ Total categories now: ${allCategories.length}`);
    allCategories.forEach((cat) => {
      console.log(`   - ${cat.name} (Handle: ${cat.handle})`);
    });

    await AppDataSource.destroy();
    console.log("\n🎉 Done!");
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error(error);
    process.exit(1);
  }
}

seedCategories();
