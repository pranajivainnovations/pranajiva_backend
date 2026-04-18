const { Client } = require("pg");

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Fix images with old S3 URL (path-style without bucket)
  const oldPrefix = "https://s3.eu-north-1.amazonaws.com/";
  const newPrefix = "https://pranajiva-innovations.s3.eu-north-1.amazonaws.com/";

  const res = await c.query(
    `UPDATE image SET url = REPLACE(url, $1, $2) WHERE url LIKE $3 RETURNING id, url`,
    [oldPrefix, newPrefix, oldPrefix + "%"]
  );
  console.log(`Fixed ${res.rowCount} image(s) with old S3 URL:`);
  res.rows.forEach(r => console.log("  ", r.url));

  // Show all current image URLs
  const all = await c.query("SELECT url FROM image ORDER BY created_at DESC");
  console.log("\nAll image URLs now:");
  all.rows.forEach(r => console.log("  ", r.url));

  await c.end();
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
