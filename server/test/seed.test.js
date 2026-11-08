// Restaurant data: Harohalli restaurants, and in-place upgrade of an older database.
const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const { seed, RESTAURANTS, CENTER } = require('../src/seed');
const { haversine } = require('../src/geo');

test('restaurants are in Harohalli, within ~2 km of the town centre', () => {
  assert.ok(RESTAURANTS.length >= 8);
  for (const r of RESTAURANTS) {
    const km = haversine(CENTER, r) / 1000;
    assert.ok(km < 2, `${r.name} is ${km.toFixed(2)} km away`);
    assert.ok(r.menu.length >= 4);
  }
});

test('fresh database gets the Harohalli restaurants', async () => {
  const db = createDb({ sqlitePath: ':memory:', databaseUrl: '' });
  await db.migrate();
  assert.strictEqual(await seed(db, { log: false }), true);
  assert.strictEqual(await seed(db, { log: false }), false); // idempotent
  const rows = await db.all('SELECT name FROM restaurants ORDER BY id');
  assert.deepStrictEqual(rows.map((r) => r.name), RESTAURANTS.map((r) => r.name));
  await db.close();
});

test('older database (Bengaluru demo data + orders) is upgraded in place', async () => {
  const db = createDb({ sqlitePath: ':memory:', databaseUrl: '' });
  await db.migrate();
  // Simulate the old seed: 6 restaurants x 4 items, and an order that references them.
  for (let i = 1; i <= 6; i++) {
    const { lastId } = await db.run("INSERT INTO restaurants (name, cuisine, address, lat, lng) VALUES (?, 'Old', 'Bengaluru', 12.9, 77.6)", [`Old ${i}`]);
    for (let j = 0; j < 4; j++) await db.run("INSERT INTO menu_items (restaurant_id, name, price) VALUES (?, 'old item', 100)", [lastId]);
  }
  await db.run("INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('U', 'u@x', 'h', 'customer', 1)");
  await db.run("INSERT INTO orders (id, customer_id, restaurant_id, status, total, address, created_at) VALUES ('OV-OLD', 1, 2, 'delivered', 130, 'x', 1)");
  await db.run("INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES ('OV-OLD', 5, 'old item', 100, 1)");

  assert.strictEqual(await seed(db, { log: false }), true);
  const rows = await db.all('SELECT id, name, lat FROM restaurants ORDER BY id');
  assert.strictEqual(rows.length, RESTAURANTS.length);
  assert.strictEqual(rows[0].name, RESTAURANTS[0].name);
  assert.ok(rows.every((r) => r.lat < 12.7), 'all moved to Harohalli');
  const order = await db.get("SELECT o.id, r.name FROM orders o JOIN restaurants r ON r.id = o.restaurant_id WHERE o.id = 'OV-OLD'");
  assert.strictEqual(order.name, RESTAURANTS[1].name); // old order still valid
  const item = await db.get('SELECT name FROM menu_items WHERE id = 5');
  assert.strictEqual(item.name, RESTAURANTS[1].menu[0][0]);
  await db.close();
});