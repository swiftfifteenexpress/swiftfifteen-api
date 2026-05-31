// ============================================================
// Swift-Fifteen Express — Kwikpik Price Estimate Function
// Route: POST /api/estimate
// ============================================================

async function geocode(address) {
  const query = encodeURIComponent(address + ', Nigeria');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${process.env.GOOGLE_MAPS_API_KEY}&region=ng&components=country:NG`;
  const res  = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results || data.results.length === 0) {
    throw new Error(`Could not geocode: "${address}" — ${data.status}`);
  }
  const loc = data.results[0].geometry.location;
  return { latitude: loc.lat, longitude: loc.lng, address: address };
}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { pickup_address, delivery_address } = req.body;

  if (!pickup_address || !delivery_address) {
    return res.status(400).json({ error: 'Pickup and delivery addresses are required' });
  }

  // ── YOUR MARGIN SETTINGS — adjust anytime ────────────────
  const MARGIN_FLAT    = 800;   // flat ₦800 added to every order
  const MINIMUM_CHARGE = 3000;  // never charge less than ₦3,000
  // ─────────────────────────────────────────────────────────

  if (!process.env.KWIKPIK_API_KEY || !process.env.GOOGLE_MAPS_API_KEY) {
    return res.status(200).json({
      success: true, your_price: MINIMUM_CHARGE,
      fallback: true, message: 'API keys not configured'
    });
  }

  try {
    // Step 1 — Geocode both addresses with Google Maps
    const [pickupCoords, deliveryCoords] = await Promise.all([
      geocode(pickup_address),
      geocode(delivery_address)
    ]);

    // Step 2 — Call Kwikpik estimate
    const kwikpikRes = await fetch('https://api.kwikpik.io/partners/requests/estimate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    process.env.KWIKPIK_API_KEY,
        'Accept':       'application/json',
      },
      body: JSON.stringify({
        insured:     false,
        itemValue:   0,
        vehicleType: 'motorcycle',
        pickupLocation: {
          latitude:  pickupCoords.latitude,
          longitude: pickupCoords.longitude,
          address:   pickup_address
        },
        deliveryLocation: {
          latitude:  deliveryCoords.latitude,
          longitude: deliveryCoords.longitude,
          address:   delivery_address
        }
      })
    });

    const rawText = await kwikpikRes.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch(e) {
      return res.status(200).json({
        success: true, your_price: MINIMUM_CHARGE,
        fallback: true, message: 'Could not parse Kwikpik response'
      });
    }

    // Step 3 — Extract price from result.total
    const basePrice = data?.result?.total
      || data?.result?.deliveryFee
      || data?.total
      || null;

    if (!basePrice) {
      return res.status(200).json({
        success: true, your_price: MINIMUM_CHARGE,
        fallback: true, message: 'Price not found in Kwikpik response'
      });
    }

    const baseNum    = parseFloat(basePrice);
    const finalPrice = Math.max(Math.ceil((baseNum + MARGIN_FLAT) / 100) * 100, MINIMUM_CHARGE);

    return res.status(200).json({
      success:       true,
      kwikpik_price: baseNum,
      your_price:    finalPrice,
      duration:      data?.result?.duration || null,
      fallback:      false,
      currency:      'NGN'
    });

  } catch (err) {
    console.error('Estimate error:', err.message);
    return res.status(200).json({
      success: true, your_price: MINIMUM_CHARGE,
      fallback: true, message: 'Fallback price used'
    });
  }
}
