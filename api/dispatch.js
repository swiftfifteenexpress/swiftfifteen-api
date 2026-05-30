// ============================================================
// Swift-Fifteen Express — Kwikpik Auto-Dispatch Function
// Route: POST /api/dispatch
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
    return res.status(400).json({ success: false, error: 'Missing required delivery fields' });
  }

  if (!process.env.KWIKPIK_API_KEY) {
    return res.status(200).json({
      success: false, fallback_required: true,
      message: 'API key not configured — dispatch manually on Kwikpik dashboard'
    });
  }

  try {
    // Step 1 — Geocode both addresses
    console.log('Geocoding addresses for dispatch...');
    const [pickupCoords, deliveryCoords] = await Promise.all([
      geocode(pickup_address + (pickup_city ? ', ' + pickup_city : '')),
      geocode(delivery_address)
    ]);

    // Step 2 — Build Kwikpik initiate payload using exact field names from docs
    const payload = {
      vehicleType: "bike",
      pickupLocation: pickupCoords,
      deliveryLocation: deliveryCoords,
      senderName: sender_name,
      senderEmail: sender_email || 'orders@swiftfifteenexpress.com',
      senderPhoneNumber: sender_phone,
      recipientName: recipient_name,
      recipientPhoneNumber: recipient_phone,
      description: package_description || 'Package',
      itemCategory: 'general',
      itemValue: parseFloat(declared_value) || 0,
      itemWeight: package_weight === '1–5kg' ? 3
        : package_weight === '5–20kg' ? 10
        : package_weight === '20kg+' ? 25
        : 1,
      itemName: package_description || 'Package',
      insured: false,
      itemQuantity: 1
    };

    console.log('Calling Kwikpik initiate with payload:', JSON.stringify(payload));

    const kwikpikRes = await fetch('https://api.kwikpik.io/requests/initiate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.KWIKPIK_API_KEY,
        'Accept': 'application/json',
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
        message: 'Could not parse Kwikpik dispatch response', raw: rawText
      });
    }

    if (!kwikpikRes.ok) {
      return res.status(200).json({
        success: false, kwikpik_error: data,
        fallback_required: true,
        message: 'Kwikpik dispatch failed — dispatch manually on dashboard'
      });
    }

    // Extract request ID from result.id
    const kwikpikId = data?.result?.id || data?.id || null;
    const status    = data?.result?.status || data?.status || 'PENDING';

    // Build tracking URL using the request ID
    const trackingUrl = kwikpikId
      ? `https://kwikpik.io/track/${kwikpikId}`
      : null;

    return res.status(200).json({
      success: true,
      kwikpik_id:   kwikpikId,
      tracking_url: trackingUrl,
      status:       status,
      message:      'Delivery request created successfully'
    });

  } catch (err) {
    console.error('Dispatch function error:', err.message);
    return res.status(200).json({
      success: false, fallback_required: true,
      message: 'Dispatch error — dispatch manually on Kwikpik dashboard',
      error: err.message
    });
  }
    }
