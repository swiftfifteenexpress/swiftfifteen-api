// ============================================================
// Swift-Fifteen Express — Paystack Verify + Kwikpik Dispatch
// Route: POST /api/verify-payment
// ============================================================

async function geocode(address) {
  const query = encodeURIComponent(address + ', Nigeria');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${process.env.GOOGLE_MAPS_API_KEY}&region=ng&components=country:NG`;
  const res  = await fetch(url);
  const data = await res.json();
  console.log(`Geocode "${address}" → status: ${data.status}`);
  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Geocoding failed for "${address}" — Google status: ${data.status}`);
  }
  const loc = data.results[0].geometry.location;
  return { latitude: loc.lat, longitude: loc.lng, address: address };
}

function weightToKg(w) {
  if (!w) return 1;
  if (w.includes('20kg+')) return 25;
  if (w.includes('5–20'))  return 10;
  if (w.includes('1–5'))   return 3;
  return 1;
}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { reference, order_data } = req.body;

  console.log('=== verify-payment called ===');
  console.log('Reference:', reference);
  console.log('Order data keys:', order_data ? Object.keys(order_data).join(', ') : 'MISSING');

  if (!reference) {
    return res.status(400).json({ success: false, error: 'Payment reference is required' });
  }

  if (!process.env.PAYSTACK_SECRET_KEY) {
    console.error('PAYSTACK_SECRET_KEY missing');
    return res.status(500).json({ success: false, error: 'Paystack secret key not configured' });
  }

  if (!process.env.KWIKPIK_API_KEY) {
    console.error('KWIKPIK_API_KEY missing');
  }

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error('GOOGLE_MAPS_API_KEY missing');
  }

  try {
    // ── Step 1: Verify with Paystack ─────────────────────
    console.log('Calling Paystack verify...');
    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const paystackData = await paystackRes.json();
    console.log('Paystack status:', paystackData?.data?.status);
    console.log('Paystack amount (kobo):', paystackData?.data?.amount);

    if (!paystackData.status || paystackData.data?.status !== 'success') {
      console.error('Payment not confirmed:', paystackData?.data?.status);
      return res.status(200).json({
        success: false,
        payment_verified: false,
        message: 'Payment not confirmed by Paystack',
        paystack_status: paystackData.data?.status || 'unknown'
      });
    }

    const paidAmountKobo = paystackData.data.amount;
    console.log(`Payment verified ✓ — ₦${paidAmountKobo / 100}`);

    // ── Step 2: Dispatch to Kwikpik ──────────────────────
    if (!order_data || !order_data.pickup_address || !order_data.delivery_address) {
      console.error('Missing order_data or addresses');
      return res.status(200).json({
        success: true,
        payment_verified: true,
        dispatch_status: 'failed',
        message: 'Payment verified but order data was missing or incomplete'
      });
    }

    // Geocode both addresses
    console.log('Geocoding pickup:', order_data.pickup_address);
    console.log('Geocoding delivery:', order_data.delivery_address);

    const pickupFull = order_data.pickup_address
      + (order_data.pickup_city ? ', ' + order_data.pickup_city : ', Lagos');

    const [pickupCoords, deliveryCoords] = await Promise.all([
      geocode(pickupFull),
      geocode(order_data.delivery_address)
    ]);

    console.log('Pickup coords:', JSON.stringify(pickupCoords));
    console.log('Delivery coords:', JSON.stringify(deliveryCoords));

    // Build Kwikpik payload
    const kwikpikPayload = {
      vehicleType: 'motorcycle',
      pickupLocation: {
        latitude:  pickupCoords.latitude,
        longitude: pickupCoords.longitude,
        address:   order_data.pickup_address
      },
      deliveryLocation: {
        latitude:  deliveryCoords.latitude,
        longitude: deliveryCoords.longitude,
        address:   order_data.delivery_address
      },
      senderName:           order_data.sender_name || 'Swift-Fifteen Customer',
      senderEmail:          order_data.sender_email || 'orders@swiftfifteenexpress.com',
      senderPhoneNumber:    order_data.sender_phone,
      recipientName:        order_data.recipient_name || order_data.sender_name,
      recipientPhoneNumber: order_data.recipient_phone || order_data.sender_phone,
      description:          order_data.package_description || 'Package delivery',
      itemCategory:         'general',
      itemValue:            parseFloat(order_data.declared_value) || 0,
      itemWeight:           weightToKg(order_data.package_weight),
      itemName:             order_data.package_description || 'Package',
      insured:              false,
      itemQuantity:         1
    };

    console.log('Sending to Kwikpik /partners/requests/initiate...');
    console.log('Payload:', JSON.stringify(kwikpikPayload));

    const kwikpikRes = await fetch('https://api.kwikpik.io/requests/initiate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    process.env.KWIKPIK_API_KEY,
        'Accept':       'application/json',
      },
      body: JSON.stringify(kwikpikPayload)
    });

    const kwikpikRaw = await kwikpikRes.text();
    console.log('Kwikpik HTTP status:', kwikpikRes.status);
    console.log('Kwikpik raw response:', kwikpikRaw);

    let kwikpikData;
    try {
      kwikpikData = JSON.parse(kwikpikRaw);
    } catch(e) {
      console.error('Kwikpik returned non-JSON:', kwikpikRaw);
      return res.status(200).json({
        success: true,
        payment_verified: true,
        paid_amount_ngn: paidAmountKobo / 100,
        dispatch_status: 'failed',
        dispatch_error: kwikpikRaw,
        message: 'Payment verified ✓ but Kwikpik returned non-JSON response'
      });
    }

    if (!kwikpikRes.ok) {
      console.error('Kwikpik dispatch failed:', JSON.stringify(kwikpikData));
      return res.status(200).json({
        success: true,
        payment_verified: true,
        paid_amount_ngn: paidAmountKobo / 100,
        dispatch_status: 'failed',
        dispatch_error: kwikpikData,
        kwikpik_http_status: kwikpikRes.status,
        message: 'Payment verified ✓ but Kwikpik dispatch failed'
      });
    }

    const kwikpikId  = kwikpikData?.result?.id  || kwikpikData?.id  || null;
    const kwikStatus = kwikpikData?.result?.status || kwikpikData?.status || null;
    const trackingUrl = kwikpikId ? `https://kwikpik.io/track/${kwikpikId}` : null;

    console.log('Kwikpik dispatch result — ID:', kwikpikId, 'Status:', kwikStatus);

    return res.status(200).json({
      success:           true,
      payment_verified:  true,
      paid_amount_ngn:   paidAmountKobo / 100,
      dispatch_status:   'success',
      kwikpik_id:        kwikpikId,
      kwikpik_status:    kwikStatus,
      tracking_url:      trackingUrl,
      message:           'Payment verified and delivery request created'
    });

  } catch (err) {
    console.error('verify-payment error:', err.message);
    console.error('Stack:', err.stack);
    return res.status(200).json({
      success: false,
      payment_verified: false,
      dispatch_status: 'error',
      error: err.message,
      message: 'Server error during verification — check Vercel logs'
    });
  }
}
