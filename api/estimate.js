// ============================================================
// Swift-Fifteen Express — Shipbubble Price Estimate
// Route: POST /api/estimate
// Docs: https://api.shipbubble.com/v1
// Flow: geocode → validate addresses → fetch_rates
// ============================================================

async function geocode(address) {
  const query = encodeURIComponent(address + ', Nigeria');
  const url   = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${process.env.GOOGLE_MAPS_API_KEY}&region=ng&components=country:NG`;
  const res   = await fetch(url);
  const data  = await res.json();
  console.log(`Geocode "${address}" → ${data.status}`);
  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Geocoding failed for "${address}" — ${data.status}`);
  }
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

async function validateAddress(address, name, phone, email, apiKey, coords) {
  // Shipbubble requires: letters only in name, full name (2 words minimum)
  const cleanName = (name || '').replace(/[^a-zA-Z\s]/g, '').trim();
  const fullName  = cleanName.split(' ').filter(Boolean).length >= 2
    ? cleanName
    : cleanName + ' User';

  const payload = {
    name:      fullName,
    email:     email || 'orders@swiftfifteenexpress.com',
    phone:     phone || '+2348029234994',
    address:   address,
    latitude:  coords.lat,
    longitude: coords.lng
  };

  console.log(`Validating address: "${address}" as "${fullName}"`);

  const res  = await fetch('https://api.shipbubble.com/v1/shipping/address/validate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    body: JSON.stringify(payload)
  });

  const raw  = await res.text();
  console.log(`Validate response (${res.status}): ${raw}`);

  const data = JSON.parse(raw);
  if (data.status !== 'success' || !data.data?.address_code) {
    throw new Error(`Address validation failed: ${data.message || JSON.stringify(data.errors)}`);
  }
  return data.data.address_code;
}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { pickup_address, delivery_address, package_weight } = req.body;

  console.log('=== estimate called ===');
  console.log('Pickup:', pickup_address);
  console.log('Delivery:', delivery_address);

  if (!pickup_address || !delivery_address) {
    return res.status(400).json({ error: 'Both addresses are required' });
  }

  const MINIMUM   = 5000;
  const SB_KEY    = process.env.SHIPBUBBLE_API_KEY;
  const GM_KEY    = process.env.GOOGLE_MAPS_API_KEY;

  if (!SB_KEY || !GM_KEY) {
    return res.status(200).json({
      success: true, kwikpik_price: null,
      your_price: MINIMUM, fallback: true,
      message: 'API keys not configured'
    });
  }

  try {
    // Step 1 — Geocode both addresses
    const [pickupCoords, deliveryCoords] = await Promise.all([
      geocode(pickup_address),
      geocode(delivery_address)
    ]);
    console.log('Pickup coords:', pickupCoords);
    console.log('Delivery coords:', deliveryCoords);

    // Step 2 — Validate addresses with Shipbubble
    // Using lat/lng so Shipbubble uses coordinates, not address string
    const [senderCode, receiverCode] = await Promise.all([
      validateAddress(
        pickup_address,
        'Swift Fifteen',      // clean name, 2 words, no hyphens/numbers
        '+2348029234994',
        'orders@swiftfifteenexpress.com',
        SB_KEY,
        pickupCoords
      ),
      validateAddress(
        delivery_address,
        'Delivery Recipient',  // generic clean name for estimate
        '+2348000000001',
        'recipient@swiftfifteenexpress.com',
        SB_KEY,
        deliveryCoords
      )
    ]);

    console.log('Sender code:', senderCode, '| Receiver code:', receiverCode);

    // Step 3 — Fetch rates
    // Note: Shipbubble docs use "reciever_address_code" (typo in their API)
    const today        = new Date().toISOString().split('T')[0];
    const weight       = parseFloat(package_weight) || 1;

    const ratesPayload = {
      sender_address_code:   senderCode,
      reciever_address_code: receiverCode,    // ← Shipbubble typo — must match exactly
      pickup_date:           today,
      category_id:           74794423,        // "Fashion wears" — most common for our orders
      package_items: [{
        name:        'Package',
        description: 'Delivery package',
        unit_weight: weight,
        unit_amount: 5000,
        quantity:    1
      }],
      package_dimension: { length: 20, width: 15, height: 10 }
    };

    console.log('Fetching rates:', JSON.stringify(ratesPayload));

    const ratesRes  = await fetch('https://api.shipbubble.com/v1/shipping/fetch_rates', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      body: JSON.stringify(ratesPayload)
    });

    const ratesRaw  = await ratesRes.text();
    console.log('Rates status:', ratesRes.status);
    console.log('Rates response:', ratesRaw);

    const ratesData = JSON.parse(ratesRaw);

    if (ratesData.status !== 'success' || !ratesData.data?.couriers?.length) {
      console.error('No couriers:', JSON.stringify(ratesData));
      return res.status(200).json({
        success: true, your_price: MINIMUM,
        fallback: true, message: 'No couriers available for this route',
        debug: ratesData
      });
    }

    // Use fastest courier for same-day delivery
    const bestCourier = ratesData.data.fastest_courier
      || ratesData.data.cheapest_courier
      || ratesData.data.couriers[0];

    const basePrice = parseFloat(bestCourier?.total || 0);
    console.log('Selected courier:', bestCourier?.courier_name, '₦' + basePrice);
    console.log('All couriers:', ratesData.data.couriers.map(c => `${c.courier_name}: ₦${c.total}`).join(' | '));

    return res.status(200).json({
      success:               true,
      kwikpik_price:         basePrice,   // raw cost, browser applies 25% margin
      your_price:            basePrice,
      courier_name:          bestCourier?.courier_name || '',
      pickup_eta:            bestCourier?.pickup_eta   || '',
      delivery_eta:          bestCourier?.delivery_eta || '',
      sender_address_code:   senderCode,
      receiver_address_code: receiverCode,
      request_token:         ratesData.data.request_token,
      fallback:              false,
      currency:              'NGN'
    });

  } catch (err) {
    console.error('Estimate error:', err.message);
    return res.status(200).json({
      success: true, your_price: MINIMUM,
      fallback: true, error: err.message
    });
  }
                                         }
