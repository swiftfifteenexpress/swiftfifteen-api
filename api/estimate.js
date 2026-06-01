// ============================================================
// Swift-Fifteen Express — Kwikpik Price Estimate Function
// Route: POST /api/estimate
// ============================================================

async function geocode(address) {
  const query = encodeURIComponent(address + ', Nigeria');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${process.env.GOOGLE_MAPS_API_KEY}&region=ng&components=country:NG`;
  const res  = await fetch(url);
  const data = await res.json();
  console.log(`Geocode "${address}" → ${data.status}`);
  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Geocoding failed: "${address}" — ${data.status}`);
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
  console.log('=== estimate called ===');
  console.log('Pickup:', pickup_address);
  console.log('Delivery:', delivery_address);

  if (!pickup_address || !delivery_address) {
    return res.status(400).json({ error: 'Both addresses are required' });
  }

  const MINIMUM_CHARGE = 2000;

  if (!process.env.KWIKPIK_API_KEY) {
    console.error('KWIKPIK_API_KEY missing');
    return res.status(200).json({ success: true, kwikpik_price: null, your_price: MINIMUM_CHARGE, fallback: true, message: 'API key not configured' });
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error('GOOGLE_MAPS_API_KEY missing');
    return res.status(200).json({ success: true, kwikpik_price: null, your_price: MINIMUM_CHARGE, fallback: true, message: 'Maps key not configured' });
  }

  try {
    // Step 1 — Geocode both addresses
    const [pickupCoords, deliveryCoords] = await Promise.all([
      geocode(pickup_address),
      geocode(delivery_address)
    ]);
    console.log('Pickup coords:', JSON.stringify(pickupCoords));
    console.log('Delivery coords:', JSON.stringify(deliveryCoords));

    // Step 2 — Call Kwikpik estimate
    const kwikpikRes = await fetch('https://api.kwikpik.io/partners/requests/estimate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.KWIKPIK_API_KEY,
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        insured: false,
        itemValue: 0,
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
    console.log('Kwikpik estimate HTTP status:', kwikpikRes.status);
    console.log('Kwikpik estimate raw response:', rawText);

    // Handle empty response
    if (!rawText || rawText.trim() === '') {
      console.error('Kwikpik returned empty body on estimate');
      return res.status(200).json({
        success: true, kwikpik_price: null,
        your_price: MINIMUM_CHARGE, fallback: true,
        message: 'Kwikpik returned empty response'
      });
    }

    let data;
    try { data = JSON.parse(rawText); }
    catch(e) {
      console.error('Non-JSON from Kwikpik:', rawText.substring(0, 200));
      return res.status(200).json({
        success: true, kwikpik_price: null,
        your_price: MINIMUM_CHARGE, fallback: true,
        message: 'Non-JSON response from Kwikpik'
      });
    }

    // Step 3 — Extract price
    const basePrice = data?.result?.total
      || data?.result?.deliveryFee
      || data?.total
      || data?.deliveryFee
      || null;

    console.log('Extracted base price:', basePrice);
    console.log('Full Kwikpik response:', JSON.stringify(data));

    if (!basePrice) {
      return res.status(200).json({
        success: true, kwikpik_price: null,
        your_price: MINIMUM_CHARGE, fallback: true,
        full_response: data,
        message: 'Price field not found in Kwikpik response'
      });
    }

    // Step 4 — Return raw Kwikpik price only
    // The 25% margin is applied in the browser (order.html fetchEstimate function)
    const baseNum = parseFloat(basePrice);
    console.log(`Returning kwikpik_price: ₦${baseNum}`);

    return res.status(200).json({
      success:       true,
      kwikpik_price: baseNum,
      your_price:    baseNum, // browser applies 25% margin on top of this
      duration:      data?.result?.duration || null,
      fallback:       false,
      currency:       'NGN'
    });

  } catch (err) {
    console.error('Estimate error:', err.message);
    return res.status(200).json({
      success: true, kwikpik_price: null,
      your_price: MINIMUM_CHARGE, fallback: true,
      error: err.message
    });
  }
    }
