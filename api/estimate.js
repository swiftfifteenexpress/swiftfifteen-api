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
    throw new Error(`Google could not geocode: "${address}" — status: ${data.status}`);
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

  const { pickup_address, delivery_address, package_weight } = req.body;

  const MARGIN_FLAT    = 800;
  const MINIMUM_CHARGE = 3000;

  if (!process.env.KWIKPIK_API_KEY) {
    return res.status(200).json({ success: true, your_price: MINIMUM_CHARGE, fallback: true, message: 'Kwikpik API key not configured' });
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return res.status(200).json({ success: true, your_price: MINIMUM_CHARGE, fallback: true, message: 'Google Maps API key not configured' });
  }

  try {
    // Geocode both addresses
    const [pickupCoords, deliveryCoords] = await Promise.all([
      geocode(pickup_address),
      geocode(delivery_address)
    ]);

    const payload = {
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
    };

    // Try both possible base URLs — sandbox vs live
    const BASE_URL = 'https://api.kwikpik.io';

    const kwikpikRes = await fetch(`${BASE_URL}/partners/requests/estimate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    process.env.KWIKPIK_API_KEY,
        'Accept':       'application/json',
      },
      body: JSON.stringify(payload)
    });

    const rawText = await kwikpikRes.text();

    // ── FULL DEBUG — shows everything ──────────────────────
    // Check if it's valid JSON first
    let parsedData = null;
    let isJson = false;
    try {
      parsedData = JSON.parse(rawText);
      isJson = true;
    } catch(e) {
      isJson = false;
    }

    // If still non-JSON — return full debug info so we can diagnose
    if (!isJson) {
      return res.status(200).json({
        success: false,
        debug: true,
        kwikpik_http_status: kwikpikRes.status,
        kwikpik_http_status_text: kwikpikRes.statusText,
        kwikpik_raw_response: rawText.substring(0, 500), // first 500 chars
        api_key_preview: process.env.KWIKPIK_API_KEY.substring(0, 8) + '...',
        geocode_results: { pickup: pickupCoords, delivery: deliveryCoords },
        payload_sent: payload,
        message: 'Kwikpik returned non-JSON — see kwikpik_raw_response for details'
      });
    }

    // If JSON — extract price
    const basePrice = parsedData?.result?.total
      || parsedData?.result?.deliveryFee
      || parsedData?.total
      || parsedData?.deliveryFee
      || null;

    if (!basePrice) {
      return res.status(200).json({
        success: true, your_price: MINIMUM_CHARGE,
        fallback: true, full_kwikpik_response: parsedData,
        message: 'Got JSON but price field not found — see full_kwikpik_response'
      });
    }

    const baseNum    = parseFloat(basePrice);
    const finalPrice = Math.max(Math.ceil((baseNum + MARGIN_FLAT) / 100) * 100, MINIMUM_CHARGE);

    return res.status(200).json({
      success:       true,
      kwikpik_price: baseNum,
      your_price:    finalPrice,
      duration:      parsedData?.result?.duration || null,
      fallback:      false,
      currency:      'NGN'
    });

  } catch (err) {
    return res.status(200).json({
      success: true, your_price: MINIMUM_CHARGE,
      fallback: true, error: err.message,
      message: 'Fallback price used — see error field'
    });
  }
                                }
