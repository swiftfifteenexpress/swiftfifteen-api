// ============================================================
// Swift-Fifteen Express — Kwikpik Auto-Dispatch Function
// Route: POST /api/dispatch
// ============================================================

// Geocode using Google Maps API
async function geocode(address) {
  const query = encodeURIComponent(address + ', Nigeria');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${process.env.GOOGLE_MAPS_API_KEY}&region=ng&components=country:NG`;

  const res  = await fetch(url);
  const data = await res.json();

  console.log(`Geocode "${address}" status:`, data.status);

  if (data.status !== 'OK' || !data.results || data.results.length === 0) {
    throw new Error(`Google could not geocode: "${address}" — status: ${data.status}`);
  }

  const loc = data.results[0].geometry.location;
  return {
    latitude:  loc.lat,
    longitude: loc.lng,
    address:   address
  };
}

// Convert weight string from order form to numeric kg
function weightToKg(weightStr) {
  if (!weightStr) return 1;
  if (weightStr.includes('20kg+')) return 25;
  if (weightStr.includes('5–20'))  return 10;
  if (weightStr.includes('1–5'))   return 3;
  return 1; // under 1kg default
}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const {
    order_id,
    sender_name,
    sender_phone,
    sender_email,
    pickup_address,
    pickup_city,
    recipient_name,
    recipient_phone,
    delivery_address,
    package_description,
    package_weight,
    declared_value,
  } = req.body;

  if (!pickup_address || !delivery_address || !recipient_phone || !sender_phone) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  if (!process.env.KWIKPIK_API_KEY || !process.env.GOOGLE_MAPS_API_KEY) {
    return res.status(200).json({
      success: false, fallback_required: true,
      message: 'API keys not configured — dispatch manually on Kwikpik dashboard'
    });
  }

  try {
    // Step 1 — Geocode both addresses
    console.log('Geocoding addresses for dispatch...');
    const pickupFull   = pickup_address + (pickup_city ? ', ' + pickup_city : ', Lagos');
    const [pickupCoords, deliveryCoords] = await Promise.all([
      geocode(pickupFull),
      geocode(delivery_address)
    ]);

    // Step 2 — Build exact Kwikpik initiate payload from API docs
    const payload = {
      vehicleType: 'bike',
      pickupLocation: {
        latitude:  pickupCoords.latitude,
        longitude: pickupCoords.longitude,
        address:   pickup_address
      },
      deliveryLocation: {
        latitude:  deliveryCoords.latitude,
        longitude: deliveryCoords.longitude,
        address:   delivery_address
      },
      senderName:          sender_name,
      senderEmail:         sender_email || 'orders@swiftfifteenexpress.com',
      senderPhoneNumber:   sender_phone,
      recipientName:       recipient_name,
      recipientPhoneNumber: recipient_phone,
      description:         package_description || 'Package delivery',
      itemCategory:        'general',
      itemValue:           parseFloat(declared_value) || 0,
      itemWeight:          weightToKg(package_weight),
      itemName:            package_description || 'Package',
      insured:             false,
      itemQuantity:        1
    };

    console.log('Calling Kwikpik /requests/initiate...');
    console.log('Payload:', JSON.stringify(payload));

    const kwikpikRes = await fetch('https://api.kwikpik.io/requests/initiate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    process.env.KWIKPIK_API_KEY,
        'Accept':       'application/json',
      },
      body: JSON.stringify(payload)
    });

    const rawText = await kwikpikRes.text();
    console.log('Kwikpik dispatch status:', kwikpikRes.status);
    console.log('Kwikpik dispatch response:', rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch(e) {
      return res.status(200).json({
        success: false, fallback_required: true,
        message: 'Could not parse Kwikpik response', raw: rawText
      });
    }

    if (!kwikpikRes.ok) {
      return res.status(200).json({
        success: false, fallback_required: true,
        kwikpik_error: data,
        message: 'Kwikpik dispatch failed — dispatch manually on dashboard'
      });
    }

    // Extract request ID from result.id (per Kwikpik docs)
    const kwikpikId  = data?.result?.id  || data?.id  || null;
    const status     = data?.result?.status || data?.status || 'PENDING';

    // Build tracking URL
    const trackingUrl = kwikpikId
      ? `https://kwikpik.io/track/${kwikpikId}`
      : null;

    console.log('Dispatch successful. Kwikpik ID:', kwikpikId);

    return res.status(200).json({
      success:      true,
      kwikpik_id:   kwikpikId,
      tracking_url: trackingUrl,
      status:       status,
      message:      'Delivery request created successfully'
    });

  } catch (err) {
    console.error('Dispatch error:', err.message);
    return res.status(200).json({
      success: false, fallback_required: true,
      message: 'Dispatch error — dispatch manually on Kwikpik dashboard',
      error: err.message
    });
  }
}
