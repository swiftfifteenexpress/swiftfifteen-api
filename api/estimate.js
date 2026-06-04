// ============================================================
// Swift-Fifteen Express — Shipbubble Price Estimate Function
// Route: POST /api/estimate
// No geocoding needed — Shipbubble handles addresses directly
// ============================================================

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

  const MINIMUM_CHARGE = 2000;

  if (!process.env.SHIPBUBBLE_API_KEY) {
    console.error('SHIPBUBBLE_API_KEY missing');
    return res.status(200).json({
      success: true, kwikpik_price: null,
      your_price: MINIMUM_CHARGE, fallback: true,
      message: 'Shipbubble API key not configured'
    });
  }

  try {
    const payload = {
      pickup_date: new Date().toISOString().split('T')[0],
      category_id: 1,
      package_items: [{
        name: 'Package',
        description: 'Delivery package',
        unit_weight: parseFloat(package_weight) || 1,
        unit_amount: 1000,
        quantity: 1
      }],
      package_dimension: { length: 10, width: 10, height: 10 },
      sender_address: {
        name: 'Swift-Fifteen Express',
        email: 'orders@swiftfifteenexpress.com',
        phone: '+2348029234994',
        address: pickup_address
      },
      receiver_address: {
        name: 'Recipient',
        email: 'recipient@example.com',
        phone: '+2348000000000',
        address: delivery_address
      }
    };

    console.log('Calling Shipbubble fetch_rates...');

    const shipRes = await fetch('https://api.shipbubble.com/v1/shipping/fetch_rates', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SHIPBUBBLE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const rawText = await shipRes.text();
    console.log('Shipbubble HTTP status:', shipRes.status);
    console.log('Shipbubble response:', rawText);

    if (!rawText || rawText.trim() === '') {
      console.error('Shipbubble returned empty body');
      return res.status(200).json({
        success: true, your_price: MINIMUM_CHARGE,
        fallback: true, message: 'Empty response from Shipbubble'
      });
    }

    let data;
    try { data = JSON.parse(rawText); }
    catch(e) {
      console.error('Non-JSON from Shipbubble:', rawText.substring(0, 300));
      return res.status(200).json({
        success: true, your_price: MINIMUM_CHARGE,
        fallback: true, message: 'Non-JSON response from Shipbubble'
      });
    }

    if (data.status !== 'success' || !data.data?.couriers?.length) {
      console.error('No couriers found:', JSON.stringify(data));
      return res.status(200).json({
        success: true, your_price: MINIMUM_CHARGE,
        fallback: true, message: 'No couriers available for this route',
        debug: data
      });
    }

    // Use cheapest courier as the base price
    const cheapest = data.data.cheapest_courier;
    const basePrice = parseFloat(cheapest?.total || cheapest?.price || 0);

    console.log('Cheapest courier:', cheapest?.courier_name, '— ₦' + basePrice);
    console.log('All couriers:', data.data.couriers.map(c => `${c.courier_name}: ₦${c.total}`).join(', '));

    if (!basePrice) {
      return res.status(200).json({
        success: true, your_price: MINIMUM_CHARGE,
        fallback: true, message: 'Could not extract price from Shipbubble response',
        debug: data.data
      });
    }

    // Return raw Shipbubble price — 25% margin applied in browser
    return res.status(200).json({
      success:        true,
      kwikpik_price:  basePrice,   // keeping same field name for browser compatibility
      your_price:     basePrice,   // browser applies 25% margin
      courier_name:   cheapest?.courier_name || 'Available courier',
      pickup_eta:     cheapest?.pickup_eta || null,
      request_token:  data.data.request_token || null,
      fallback:       false,
      currency:       'NGN'
    });

  } catch (err) {
    console.error('Estimate error:', err.message);
    return res.status(200).json({
      success: true, your_price: MINIMUM_CHARGE,
      fallback: true, error: err.message,
      message: 'Fallback price used'
    });
  }
      }
