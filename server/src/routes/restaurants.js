const express = require('express');

module.exports = function restaurantRoutes({ db }) {
  const r = express.Router();

  r.get('/', async (_req, res) => {
    res.json({ restaurants: await db.all('SELECT * FROM restaurants ORDER BY rating DESC') });
  });

  r.get('/:id', async (req, res) => {
    const restaurant = await db.get('SELECT * FROM restaurants WHERE id = ?', [Number(req.params.id)]);
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    const menu = await db.all('SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY id', [restaurant.id]);
    res.json({ restaurant, menu: menu.map((m) => ({ ...m, veg: !!m.veg })) });
  });

  return r;
};
