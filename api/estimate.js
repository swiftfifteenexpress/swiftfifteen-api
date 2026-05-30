// ============================================================
// Swift-Fifteen Express — Kwikpik Price Estimate Function
// Route: POST /api/estimate
// ============================================================

// Geocode a Lagos address to lat/lng using OpenStreetMap Nominatim (free, no key needed)
async function geocode(address) {
  const query = encodeURIComponent(address + ', Lagos, Nigeria');
  const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1&countrycodes=ng`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SwiftFifteenExpress/1.0 (swiftfifteenexpress@gmail.com)' }
  });
  const data = await res.json();
  if (!data || data.length === 0) {
    throw new Error(`Could not geocode address: ${address}`);
  }
  return {
    latitude: parseFloat(data[0].lat),
    longitude: parseFloat(data[0].lon),
    address: address
  };
}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { pickup_address, delivery_address, package_weight } = req.body;

  if (!pickup_address || !delivery_address) {
    return res.status(400).json({ error: 'Pickup and delivery addresses are required' });
  }

  // ── YOUR MARGIN SETTINGS ─────────────────────────────────
  const MARGIN_FLAT    = 800;   // flat ₦800 added to every order
  const MINIMUM_CHARGE = 3000;  // never charge less than ₦3,000
  // ─────────────────────────────────────────────────────────

  if (!process.env.KWIKPIK_API_KEY) {
    return res.status(200).json({
      success: true, your_price: MINIMUM_CHARGE,
      fallback: true, message: 'API key not configured'
    });
  }

  try {
    // Step 1 — Geocode both addresses
    console.log('Geocoding addresses...');
    const [pickupCoords, deliveryCoords] = await Promise.all([
      geocode(pickup_address),
      geocode(delivery_address)
    ]);
    console.log('Pickup coords:', pickupCoords);
    console.log('Delivery coords:', deliveryCoords);

    // Step 2 — Call Kwikpik estimate with correct payload
    const payload = {
      insured: false,
      itemValue: 0,
      vehicleType: "bike",
      pickupLocation: pickupCoords,
      deliveryLocation: deliveryCoords
    };

    console.log('Calling Kwikpik estimate with payload:', JSON.stringify(payload));

    const kwikpikRes = await fetch('https://api.kwikpik.io/requests/estimate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.KWIKPIK_API_KEY,
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    const rawText = await kwikpikRes.text();
    console.log('Kwikpik estimate status:', kwikpikRes.status);
    console.log('Kwikpik estimate response:', rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch(e) {
      console.error('Could not parse Kwikpik response:', rawText);
      return res.status(200).json({
        success: true, your_price: MINIMUM_CHARGE,
        fallback: true, message: 'Could not parse Kwikpik response'
      });
    }

    // Step 3 — Extract price from result.total
    const kwikpikBasePrice = data?.result?.total
      || data?.result?.deliveryFee
      || data?.total
      || data?.deliveryFee
      || null;

    if (!kwikpikBasePrice) {
      console.error('Price not found in response:', JSON.stringify(data));
      return res.status(200).json({
        success: true, your_price: MINIMUM_CHARGE,
        fallback: true, debug_response: data,
        message: 'Price field not found'
      });
    }

    const baseNum    = parseFloat(kwikpikBasePrice);
    const finalPrice = Math.max(Math.ceil((baseNum + MARGIN_FLAT) / 100) * 100, MINIMUM_CHARGE);

    console.log(`Kwikpik base: ₦${baseNum} → Your price: ₦${finalPrice}`);

    return res.status(200).json({
      success: true,
      kwikpik_price: baseNum,
      your_price: finalPrice,
      duration: data?.result?.duration || null,
      fallback: false,
      currency: 'NGN'
    });

  } catch (err) {
    console.error('Estimate function error:', err.message);
    return res.status(200).json({
      success: true, your_price: MINIMUM_CHARGE,
      fallback: true, error: err.message,
      message: 'Fallback price — API error'
    });
  }
}
