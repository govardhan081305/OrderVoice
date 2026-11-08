// Restaurant data: eateries in Harohalli (Bengaluru South district, Karnataka 562112).
//
// Names come from public listings (Justdial, Trip.com, SquareYards, 99acres).
// Coordinates are APPROXIMATE positions around Harohalli town centre
// (12.6799, 77.4693) along Kanakapura Main Road. Adjust lat/lng here if you
// know the exact spot. Menus, prices, ratings and ETAs are SAMPLE data for the
// demo, not the restaurants' real menus.
//
// No user accounts are seeded: customers, agents and admins sign up themselves.

const CENTER = { lat: 12.679863, lng: 77.469299 };
// Kanakapura Main Road runs roughly NE (towards Bengaluru) <-> SW (towards Kanakapura).
// `km` = distance along the road from the centre (+ towards Bengaluru), `side` = small offset across it.
const along = (km, side = 0) => ({
  lat: +(CENTER.lat + km * 0.0083 - side * 0.0035).toFixed(6),
  lng: +(CENTER.lng + km * 0.0042 + side * 0.0069).toFixed(6),
});

const RESTAURANTS = [
  { name: 'Vaibhoga Family Restaurant', cuisine: 'Veg & Non-veg', rating: 4.2, eta: 25, emoji: '🍛', address: 'Kanakapura Main Rd, opp. KSRTC Bus Depot, Harohalli', ...along(0.45, 0.04),
    menu: [['Veg Meals', 'Rice, sambar, rasam, palya, curd, papad', 120, 1], ['Chicken Biryani', 'Spiced dum biryani with raita', 220, 0], ['Paneer Butter Masala', 'Cottage cheese in creamy tomato gravy', 190, 1], ['Butter Naan', 'Tandoor-baked, brushed with butter', 45, 1]] },
  { name: 'Idly Mane', cuisine: 'South Indian breakfast', rating: 4.5, eta: 15, emoji: '🍚', address: 'Kanakapura Road, Harohalli', ...along(-0.25, -0.03),
    menu: [['Thatte Idli', 'Two plate-sized idlis with chutney & sambar', 50, 1], ['Masala Dosa', 'Crispy dosa with potato palya', 70, 1], ['Vada (2 pcs)', 'Crispy medu vada with chutney', 40, 1], ['Filter Coffee', 'Strong decoction, frothy milk', 25, 1]] },
  { name: 'Ramanna Dum Biriyani', cuisine: 'Biryani', rating: 4.3, eta: 30, emoji: '🍗', address: 'Kanakapura Main Rd, Harohalli', ...along(0.8, -0.05),
    menu: [['Chicken Dum Biryani', 'Donne-style, slow-cooked on dum', 200, 0], ['Mutton Biryani', 'Tender mutton, aromatic rice', 300, 0], ['Chicken Kebab', 'Spicy fried chicken, 6 pcs', 140, 0], ['Egg Biryani', 'Biryani rice with 2 boiled eggs', 150, 0]] },
  { name: 'Green Chilli Multicuisine', cuisine: 'Chinese · North Indian', rating: 4.1, eta: 30, emoji: '🥡', address: 'Harohalli, near Devarakaggalahalli Road', ...along(-0.7, 0.08),
    menu: [['Veg Fried Rice', 'Wok-tossed rice and vegetables', 140, 1], ['Gobi Manchurian', 'Crispy cauliflower in tangy sauce', 130, 1], ['Chilli Chicken', 'Dry, Indo-Chinese style', 190, 0], ['Veg Noodles', 'Hakka noodles with vegetables', 140, 1]] },
  { name: 'Hotel Sri Durga', cuisine: 'South Indian · Meals', rating: 4.0, eta: 20, emoji: '🍽️', address: 'Near Harohalli Bus Stand', ...along(0.05, -0.02),
    menu: [['Mini Meals', 'Rice, sambar, palya, curd', 90, 1], ['Set Dosa', 'Three soft dosas with sagu', 60, 1], ['Rava Idli', 'With chutney and sagu', 50, 1], ['Badam Milk', 'Chilled, with saffron', 40, 1]] },
  { name: 'Sri Krishna Sagar', cuisine: 'Pure Veg', rating: 4.2, eta: 20, emoji: '🥘', address: 'Kanakapura Main Rd, Harohalli', ...along(0.25, 0.03),
    menu: [['Bisi Bele Bath', 'Spiced rice-lentil dish with boondi', 70, 1], ['Khara Bath', 'Savoury semolina with vegetables', 45, 1], ['Kesari Bath', 'Sweet semolina with ghee', 45, 1], ['Masala Puri', 'Puri in spiced peas gravy', 50, 1]] },
  { name: 'Rs Grand Restaurant', cuisine: 'Multi-cuisine', rating: 4.0, eta: 30, emoji: '🍲', address: 'Kanakapura Circle, Harohalli', ...along(-0.15, 0.05),
    menu: [['Chicken Ghee Roast', 'Mangalore-style, rich and spicy', 230, 0], ['Veg Biryani', 'Mixed vegetables, saffron rice', 160, 1], ['Kadai Paneer', 'Paneer with capsicum and onion', 190, 1], ['Tandoori Roti', 'Whole-wheat, tandoor-baked', 30, 1]] },
  { name: 'Jayaram Breakfast Point', cuisine: 'Breakfast · Snacks', rating: 4.4, eta: 15, emoji: '☕', address: 'Harohalli', ...along(1.1, -0.04),
    menu: [['Idli Vada', '2 idli, 1 vada, chutney, sambar', 45, 1], ['Poori Sagu', '2 pooris with vegetable sagu', 50, 1], ['Onion Dosa', 'Dosa topped with onions', 60, 1], ['Tea', 'Masala chai', 15, 1]] },
];

// Bump when RESTAURANTS changes; existing databases are upgraded in place.
const SEED_VERSION = 2;

async function insertRestaurant(tx, r) {
  const { lastId } = await tx.run(
    'INSERT INTO restaurants (name, cuisine, rating, eta_mins, emoji, address, lat, lng) VALUES (?,?,?,?,?,?,?,?)',
    [r.name, r.cuisine, r.rating, r.eta, r.emoji, r.address, r.lat, r.lng]);
  for (const [name, desc, price, veg] of r.menu) {
    await tx.run('INSERT INTO menu_items (restaurant_id, name, description, price, veg) VALUES (?,?,?,?,?)', [lastId, name, desc, price, veg]);
  }
}

async function seed(db, { log = true } = {}) {
  await db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const v = await db.get("SELECT value FROM meta WHERE key = 'seed_version'");
  if (v && Number(v.value) >= SEED_VERSION) return false;

  const existing = await db.all('SELECT id FROM restaurants ORDER BY id');
  await db.transaction(async (tx) => {
    if (!existing.length) {
      for (const r of RESTAURANTS) await insertRestaurant(tx, r);
    } else {
      // Upgrade in place: old orders keep pointing at valid restaurant / menu rows.
      for (let i = 0; i < RESTAURANTS.length; i++) {
        const r = RESTAURANTS[i];
        const row = existing[i];
        if (!row) { await insertRestaurant(tx, r); continue; }
        await tx.run('UPDATE restaurants SET name = ?, cuisine = ?, rating = ?, eta_mins = ?, emoji = ?, address = ?, lat = ?, lng = ? WHERE id = ?',
          [r.name, r.cuisine, r.rating, r.eta, r.emoji, r.address, r.lat, r.lng, row.id]);
        const items = await tx.all('SELECT id FROM menu_items WHERE restaurant_id = ? ORDER BY id', [row.id]);
        for (let j = 0; j < r.menu.length; j++) {
          const [name, desc, price, veg] = r.menu[j];
          if (items[j]) await tx.run('UPDATE menu_items SET name = ?, description = ?, price = ?, veg = ? WHERE id = ?', [name, desc, price, veg, items[j].id]);
          else await tx.run('INSERT INTO menu_items (restaurant_id, name, description, price, veg) VALUES (?,?,?,?,?)', [row.id, name, desc, price, veg]);
        }
      }
    }
    await tx.run("DELETE FROM meta WHERE key = 'seed_version'");
    await tx.run("INSERT INTO meta (key, value) VALUES ('seed_version', ?)", [String(SEED_VERSION)]);
  });
  if (log) console.log(`[seed] Harohalli restaurants ${existing.length ? 'updated' : 'created'} (seed v${SEED_VERSION})`);
  return true;
}

module.exports = { seed, RESTAURANTS, CENTER };

if (require.main === module) {
  const { createDb } = require('./db');
  (async () => { const db = createDb(); await db.migrate(); await seed(db); await db.close(); })();
}